/**
 * Jarvis relay — routes end-to-end-encrypted messages between a PC and its paired phones.
 *
 * Both sides connect OUTBOUND to the relay (so nothing on the PC is exposed to the internet, no
 * port forwarding, works across any networks). The relay:
 *  - authenticates every connection: the client proves it holds the private key of its device id
 *    (ECDSA P-256 challenge-response; device id = SHA-256 of the public key, so ids can't be forged);
 *  - routes `msg` frames only between a PC and phones that PC has allow-listed (the PC is the
 *    authority: it sends its allow-list after authenticating, and revoking a phone removes it);
 *  - routes pairing traffic only through a one-time room the PC opened, for at most 10 minutes;
 *  - never sees plaintext: payloads are AES-256-GCM sealed by the endpoints;
 *  - rate-limits frames per connection and failed authentications per IP; caps frame size;
 *  - keeps no message history (an offline recipient gets nothing: senders retry with idempotency).
 *
 * Deploy behind TLS (wss://). See relay/README.md.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_FRAME_BYTES, parseRelayFrame, PROTOCOL_VERSION, type RelayFrame } from '../shared/protocol/protocol.ts';
import { deviceIdOf, relayAuthMessage, verifyB64 } from '../shared/protocol/crypto.ts';

interface Client {
  ws: WebSocket;
  ip: string;
  role: 'pc' | 'phone' | null;
  deviceId: string | null;
  pubSign: string | null;
  nonce: string | null;
  authed: boolean;
  tokens: number;
  lastRefill: number;
  dropped: number;
}

export interface RelayOptions {
  port?: number;
  host?: string;
  /** Frames per second per connection (sustained) and burst. */
  rate?: number;
  burst?: number;
  /** Failed authentications per IP within 5 minutes before the IP is refused. */
  maxAuthFailures?: number;
  log?: (msg: string) => void;
  /**
   * Behind a reverse proxy / TLS terminator, take the client address from X-Forwarded-For (for the
   * failed-auth block). Off by default: when exposed directly, a client could forge that header.
   */
  trustProxy?: boolean;
}

export interface RunningRelay {
  url: string;
  port: number;
  server: Server;
  stats: () => { clients: number; pcs: number; phones: number; rooms: number };
  close: () => Promise<void>;
}

export async function startRelay(opts: RelayOptions = {}): Promise<RunningRelay> {
  const rate = opts.rate ?? 40;
  const burst = opts.burst ?? 80;
  const maxAuthFailures = opts.maxAuthFailures ?? 10;
  const log = opts.log ?? (() => {});
  const clients = new Map<string, Client>(); // deviceId → authenticated client
  const allow = new Map<string, Set<string>>(); // pc deviceId → phones it accepts
  const rooms = new Map<string, { pc: string; expires: number; phones: Set<string>; msgs: number }>();
  const authFailures = new Map<string, { n: number; since: number }>();

  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: PROTOCOL_VERSION, ...stats() }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES, path: '/v1' });

  const stats = () => {
    let pcs = 0;
    let phones = 0;
    for (const c of clients.values()) c.role === 'pc' ? pcs++ : phones++;
    return { clients: clients.size, pcs, phones, rooms: rooms.size };
  };
  const send = (c: Client, f: RelayFrame) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(f));
  };
  const err = (c: Client, code: Extract<RelayFrame, { t: 'error' }>['code'], message: string) => send(c, { t: 'error', code, message });
  /** The PC a phone belongs to (the PC whose allow-list holds it). */
  const pcsOf = (phone: string) => [...allow.entries()].filter(([, set]) => set.has(phone)).map(([pc]) => pc);
  const presence = (to: string, about: string, online: boolean) => {
    const c = clients.get(to);
    if (c) send(c, { t: 'presence', deviceId: about, online });
  };
  const ipBlocked = (ip: string) => {
    const f = authFailures.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > 5 * 60_000) {
      authFailures.delete(ip);
      return false;
    }
    return f.n >= maxAuthFailures;
  };
  const authFailed = (c: Client, why: string) => {
    const f = authFailures.get(c.ip) ?? { n: 0, since: Date.now() };
    f.n++;
    authFailures.set(c.ip, f);
    log(`auth failed (${why})`);
    err(c, 'auth_failed', why);
    c.ws.close(4001, 'auth failed');
  };

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const forwarded = opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    const ip = forwarded || String(req.socket.remoteAddress ?? '');
    const c: Client = { ws, ip, role: null, deviceId: null, pubSign: null, nonce: null, authed: false, tokens: burst, lastRefill: Date.now(), dropped: 0 };
    if (ipBlocked(ip)) {
      err(c, 'rate_limited', 'Too many failed authentications from this address; try again later.');
      ws.close(4029, 'rate limited');
      return;
    }
    const authTimer = setTimeout(() => !c.authed && ws.close(4001, 'auth timeout'), 10_000);
    let alive = true;
    ws.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // token bucket
      const now = Date.now();
      c.tokens = Math.min(burst, c.tokens + ((now - c.lastRefill) / 1000) * rate);
      c.lastRefill = now;
      if (c.tokens < 1) {
        if (++c.dropped > 500) ws.close(4029, 'rate limited');
        return err(c, 'rate_limited', 'Slow down');
      }
      c.tokens--;
      if (isBinary) return err(c, 'bad_frame', 'Text frames only');
      let f: RelayFrame;
      try {
        f = parseRelayFrame(data.toString('utf8'));
      } catch (e) {
        return err(c, 'bad_frame', (e as Error).message);
      }
      if (!c.authed) return handleAuth(c, f, authTimer);
      handleFrame(c, f);
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(beat);
      if (c.authed && c.deviceId && clients.get(c.deviceId) === c) {
        clients.delete(c.deviceId);
        if (c.role === 'pc') {
          for (const phone of allow.get(c.deviceId) ?? []) presence(phone, c.deviceId, false);
          for (const [room, r] of rooms) if (r.pc === c.deviceId) rooms.delete(room);
        } else {
          for (const pc of pcsOf(c.deviceId)) presence(pc, c.deviceId, false);
        }
      }
    });
  });

  function handleAuth(c: Client, f: RelayFrame, timer: NodeJS.Timeout) {
    if (f.t === 'hello') {
      if (c.nonce) return authFailed(c, 'hello sent twice');
      if (deviceIdOf(f.pubSign) !== f.deviceId) return authFailed(c, 'device id does not match its key');
      c.role = f.role;
      c.deviceId = f.deviceId;
      c.pubSign = f.pubSign;
      c.nonce = randomBytes(32).toString('base64url');
      return send(c, { t: 'challenge', nonce: c.nonce });
    }
    if (f.t === 'auth' && c.nonce && c.deviceId && c.pubSign) {
      if (!verifyB64(c.pubSign, relayAuthMessage(c.nonce, c.deviceId), f.sig)) return authFailed(c, 'bad signature');
      clearTimeout(timer);
      c.authed = true;
      c.nonce = null;
      const previous = clients.get(c.deviceId);
      if (previous && previous !== c) previous.ws.close(4000, 'replaced by a new connection');
      clients.set(c.deviceId, c);
      send(c, { t: 'ready', deviceId: c.deviceId });
      if (c.role === 'phone') {
        for (const pc of pcsOf(c.deviceId)) {
          presence(pc, c.deviceId, true);
          if (clients.has(pc)) presence(c.deviceId, pc, true);
        }
      }
      log(`${c.role} connected (${stats().clients} online)`);
      return;
    }
    err(c, 'not_authenticated', 'Authenticate first (hello → challenge → auth)');
  }

  function handleFrame(c: Client, f: RelayFrame) {
    const me = c.deviceId!;
    switch (f.t) {
      case 'ping':
        return send(c, { t: 'pong', ts: f.ts });
      case 'allow': {
        if (c.role !== 'pc') return err(c, 'not_allowed', 'Only a PC sets an allow-list');
        const before = allow.get(me) ?? new Set<string>();
        const next = new Set(f.devices);
        allow.set(me, next);
        // (Re)announce every allowed phone that is online — also after the PC reconnects.
        for (const phone of next) if (clients.has(phone)) {
          presence(phone, me, true);
          presence(me, phone, true);
        }
        for (const phone of before) if (!next.has(phone)) {
          presence(phone, me, false);
          // A revoked phone loses its connection to this PC immediately.
        }
        return;
      }
      case 'pair.open': {
        if (c.role !== 'pc') return err(c, 'not_allowed', 'Only a PC opens a pairing room');
        for (const [room, r] of rooms) if (r.pc === me) rooms.delete(room);
        rooms.set(f.room, { pc: me, expires: Date.now() + f.ttlMs, phones: new Set(), msgs: 0 });
        return;
      }
      case 'pair.close': {
        const r = rooms.get(f.room);
        if (r && r.pc === me) rooms.delete(f.room);
        return;
      }
      case 'pair.msg': {
        const r = rooms.get(f.room);
        if (!r || r.expires < Date.now()) {
          if (r) rooms.delete(f.room);
          return err(c, 'room_unknown', 'That pairing code has expired or was already used');
        }
        if (++r.msgs > 30) {
          rooms.delete(f.room);
          return err(c, 'rate_limited', 'Too many pairing attempts; start pairing again on the PC');
        }
        if (c.role === 'phone') {
          const pc = clients.get(r.pc);
          if (!pc) return err(c, 'peer_offline', 'The PC is offline');
          r.phones.add(me);
          return send(pc, { t: 'pair.msg', room: f.room, from: me, data: f.data });
        }
        if (r.pc !== me || !f.to || !r.phones.has(f.to)) return err(c, 'not_allowed', 'Not your pairing room');
        const phone = clients.get(f.to);
        if (!phone) return err(c, 'peer_offline', 'The phone is offline');
        return send(phone, { t: 'pair.msg', room: f.room, from: me, data: f.data });
      }
      case 'msg': {
        if (!f.to) return err(c, 'bad_frame', 'msg needs a recipient');
        const permitted = c.role === 'pc' ? allow.get(me)?.has(f.to) : allow.get(f.to)?.has(me);
        if (!permitted) return err(c, 'not_allowed', 'You are not paired with that device');
        const peer = clients.get(f.to);
        if (!peer) return err(c, 'peer_offline', c.role === 'phone' ? 'Your PC is offline' : 'That phone is offline');
        return send(peer, { t: 'msg', from: me, data: f.data });
      }
      default:
        return err(c, 'bad_frame', `Unexpected ${f.t}`);
    }
  }

  // Expired pairing rooms disappear on their own.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [room, r] of rooms) if (r.expires < now) rooms.delete(room);
  }, 30_000);
  sweep.unref();

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/v1`,
    port,
    server,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
