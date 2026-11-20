import { parseRelayFrame, PROTOCOL_VERSION, type RelayFrame } from '../../shared/protocol/protocol.ts';
import { relayAuthMessage, signB64 } from '../../shared/protocol/crypto.ts';

export type RelayState = 'idle' | 'connecting' | 'connected' | 'error';

/** wss:// is required, except loopback / private-network addresses during development. */
export function relayUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Not a valid URL';
  }
  if (u.protocol === 'wss:') return null;
  if (u.protocol !== 'ws:') return 'The relay URL must start with wss://';
  const h = u.hostname;
  const local = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  return local ? null : 'Unencrypted ws:// is only allowed on this computer or your local network; use wss://';
}

export interface RelayClientOptions {
  url: string;
  role: 'pc' | 'phone';
  keys: { deviceId: string; signPub: string; signPriv: string };
  onFrame: (f: RelayFrame) => void;
  onState?: (state: RelayState, detail: string) => void;
  /** Called right after authenticating (e.g. to send the PC's allow-list). */
  onReady?: () => void;
}

/**
 * An outbound, authenticated connection to the Jarvis relay. Reconnects with exponential backoff
 * (1 s → 30 s, with jitter) for as long as it is started. Nothing listens on this computer.
 */
export class RelayClient {
  state: RelayState = 'idle';
  detail = '';
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private retry: NodeJS.Timeout | null = null;
  private ping: NodeJS.Timeout | null = null;

  private opts: RelayClientOptions;

  constructor(opts: RelayClientOptions) {
    this.opts = opts;
  }

  get url(): string {
    return this.opts.url;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    this.retry = null;
    this.ping = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'stopped');
    } catch {
      /* already closed */
    }
    this.setState('idle', 'Stopped');
  }

  send(frame: RelayFrame): boolean {
    if (this.state !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private setState(state: RelayState, detail: string) {
    this.state = state;
    this.detail = detail;
    this.opts.onState?.(state, detail);
  }

  private connect() {
    if (this.stopped) return;
    const problem = relayUrlProblem(this.opts.url);
    if (problem) return this.setState('error', problem);
    this.setState('connecting', `Connecting to ${new URL(this.opts.url).host}…`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      return this.scheduleRetry((err as Error).message);
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, role: this.opts.role, deviceId: this.opts.keys.deviceId, pubSign: this.opts.keys.signPub } satisfies RelayFrame));
    });
    ws.addEventListener('message', (ev) => {
      let f: RelayFrame;
      try {
        f = parseRelayFrame(String(ev.data));
      } catch {
        return;
      }
      if (f.t === 'challenge') {
        ws.send(JSON.stringify({ t: 'auth', sig: signB64(this.opts.keys.signPriv, relayAuthMessage(f.nonce, this.opts.keys.deviceId)) } satisfies RelayFrame));
        return;
      }
      if (f.t === 'ready') {
        this.attempt = 0;
        this.setState('connected', `Connected to ${new URL(this.opts.url).host}`);
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), 20_000);
        this.ping.unref?.();
        this.opts.onReady?.();
        return;
      }
      if (f.t === 'error' && f.code === 'auth_failed') this.detail = `Relay refused authentication: ${f.message}`;
      this.opts.onFrame(f);
    });
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      if (!this.stopped) this.scheduleRetry(ev.reason || `connection closed (${ev.code})`);
    });
    ws.addEventListener('error', () => {
      /* 'close' follows and schedules the retry */
    });
  }

  private scheduleRetry(why: string) {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt = Math.min(this.attempt + 1, 6);
    this.setState('error', `Relay unreachable (${why}); retrying in ${Math.round(delay / 1000)} s`);
    this.retry = setTimeout(() => this.connect(), delay);
    this.retry.unref?.();
  }
}
