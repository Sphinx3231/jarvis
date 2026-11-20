import type { JarvisApp } from '../app.ts';
import { errorMessage, truncate } from '../core/util.ts';
import { AGENT_CATALOG, AgentId, DeviceScope, parseEnvelope, ProtocolError, PROTOCOL_VERSION, REQUIRED_SCOPE, type Envelope, type MessageType, Payloads, type RelayFrame } from '../../shared/protocol/protocol.ts';
import { deviceIdOf, generateDeviceKeys, messageKey, msgAad, open, pairAad, pairingKey, randomB64Url, seal, type DeviceKeys } from '../../shared/protocol/crypto.ts';
import { RelayClient, relayUrlProblem, type RelayState } from './relay-client.ts';
import type { Task } from '../tasks/store.ts';
import type { z } from 'zod';

const KEYS_SECRET = 'mobile:device-keys';
const PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_SCOPES: DeviceScope[] = ['observe', 'command', 'approve', 'stop'];
const COMMANDS_PER_MINUTE = 30;

export interface MobileDevice {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
  scopes: DeviceScope[];
  pairedAt: number;
  lastSeen: number | null;
  revokedAt: number | null;
  online: boolean;
}

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  app_version: string;
  pub_sign: string;
  pub_agree: string;
  scopes: string;
  paired_at: number;
  last_seen: number | null;
  revoked_at: number | null;
}

/**
 * Jarvis Mobile gateway: the PC end of the phone link. It is an ADAPTER onto the existing Jarvis
 * services — commands go to jarvis.handleMessage, task control to the task engine, approvals to the
 * permission engine — so a command from the phone gets exactly the authorization a command typed on
 * this PC gets. On top of that it enforces:
 *  - pairing: a one-time room + QR secret, device identity bound to its key, one phone per code;
 *  - per-device scopes (observe / command / approve / stop), revocable here at any time;
 *  - end-to-end encryption, replay protection (message ids + timestamp window), idempotency for
 *    commands (the ledger in mobile_commands), per-device rate limiting and an audit trail.
 * Being connected to the relay is never permission to do anything.
 */
export class MobileGateway {
  private relay: RelayClient | null = null;
  private keys: DeviceKeys | null = null;
  private pairing: { room: string; secret: string; expires: number; failures: number } | null = null;
  private online = new Set<string>();
  private seen = new Map<string, number>();
  private rate = new Map<string, number[]>();
  private unsub: Array<() => void> = [];
  private knownTasks = new Map<string, string>();
  private agentTimer: NodeJS.Timeout | null = null;
  private seq = 0;

  private app: JarvisApp;

  constructor(app: JarvisApp) {
    this.app = app;
  }

  // ---------------------------------------------------------------- lifecycle

  identity(): DeviceKeys {
    if (this.keys) return this.keys;
    const stored = this.app.secrets.get(KEYS_SECRET);
    if (stored) {
      try {
        this.keys = JSON.parse(stored) as DeviceKeys;
        return this.keys;
      } catch {
        /* regenerate below */
      }
    }
    this.keys = generateDeviceKeys();
    this.app.secrets.set(KEYS_SECRET, JSON.stringify(this.keys));
    return this.keys;
  }

  /** Start (or restart) the relay connection according to settings. Never throws. */
  sync(): void {
    const cfg = this.app.settings.get().mobile;
    const url = cfg.relayUrl.trim();
    const wanted = cfg.enabled && url && !relayUrlProblem(url) ? url : null;
    if (this.relay && (!wanted || this.relay.url !== wanted)) {
      this.relay.stop();
      this.relay = null;
      this.online.clear();
    }
    if (!wanted || this.relay) return this.emitChanged();
    const keys = this.identity();
    this.relay = new RelayClient({
      url: wanted,
      role: 'pc',
      keys,
      onFrame: (f) => this.onFrame(f),
      onReady: () => this.pushAllowList(),
      onState: (state, detail) => {
        if (state !== 'connected') this.online.clear();
        if (state === 'connected') this.app.activity.log('info', 'mobile', `Jarvis Mobile relay connected (${detail})`);
        this.emitChanged();
      },
    });
    this.relay.start();
    this.subscribe();
  }

  stop(): void {
    for (const u of this.unsub.splice(0)) u();
    if (this.agentTimer) clearTimeout(this.agentTimer);
    this.relay?.stop();
    this.relay = null;
    this.online.clear();
  }

  status(): { enabled: boolean; relayUrl: string; relayProblem: string | null; state: RelayState; detail: string; deviceId: string; pairing: { expiresAt: number } | null; devices: MobileDevice[] } {
    const cfg = this.app.settings.get().mobile;
    return {
      enabled: cfg.enabled,
      relayUrl: cfg.relayUrl,
      relayProblem: cfg.relayUrl ? relayUrlProblem(cfg.relayUrl) : 'No relay URL set',
      state: this.relay?.state ?? 'idle',
      detail: this.relay?.detail ?? (cfg.enabled ? 'Not connected' : 'Off'),
      deviceId: this.identity().deviceId,
      pairing: this.pairing && this.pairing.expires > Date.now() ? { expiresAt: this.pairing.expires } : null,
      devices: this.devices(),
    };
  }

  devices(): MobileDevice[] {
    return this.app.db.all<DeviceRow>('SELECT * FROM mobile_devices ORDER BY paired_at DESC').map((r) => this.mapDevice(r));
  }

  private mapDevice(r: DeviceRow): MobileDevice {
    return { id: r.id, name: r.name, platform: r.platform, appVersion: r.app_version, scopes: JSON.parse(r.scopes), pairedAt: r.paired_at, lastSeen: r.last_seen, revokedAt: r.revoked_at, online: this.online.has(r.id) };
  }

  private device(id: string): DeviceRow | undefined {
    return this.app.db.get<DeviceRow>('SELECT * FROM mobile_devices WHERE id = ? AND revoked_at IS NULL', id);
  }

  private emitChanged() {
    this.app.bus.emit('integrations.changed', { mobile: true });
  }

  private audit(deviceId: string | null, type: string, outcome: string, detail: string) {
    this.app.db.run('INSERT INTO mobile_audit (ts, device_id, type, outcome, detail) VALUES (?, ?, ?, ?, ?)', Date.now(), deviceId, type, outcome, truncate(detail, 500));
  }

  auditLog(limit = 100): Array<{ ts: number; deviceId: string | null; type: string; outcome: string; detail: string }> {
    return this.app.db.all<{ ts: number; device_id: string | null; type: string; outcome: string; detail: string }>('SELECT * FROM mobile_audit ORDER BY id DESC LIMIT ?', limit).map((r) => ({ ts: r.ts, deviceId: r.device_id, type: r.type, outcome: r.outcome, detail: r.detail }));
  }

  // ---------------------------------------------------------------- pairing

  /**
   * Open a one-time pairing room. The QR code carries the relay URL, the room, this PC's device id
   * and a 256-bit secret that never travels over the relay. Expires in 5 minutes; the first phone
   * that proves it holds the secret is paired and the room closes.
   */
  startPairing(): { uri: string; expiresAt: number } {
    const cfg = this.app.settings.get().mobile;
    if (!cfg.enabled) throw new Error('Turn on Jarvis Mobile first');
    if (!this.relay || this.relay.state !== 'connected') throw new Error(`The relay is not connected: ${this.relay?.detail ?? 'off'}`);
    const room = randomB64Url(18);
    const secret = Buffer.from(randomB64Url(32), 'base64url').toString('base64');
    this.pairing = { room, secret, expires: Date.now() + PAIRING_TTL_MS, failures: 0 };
    this.relay.send({ t: 'pair.open', room, ttlMs: PAIRING_TTL_MS });
    const name = this.pcName();
    const q = new URLSearchParams({ v: String(PROTOCOL_VERSION), relay: cfg.relayUrl, room, secret, pc: this.identity().deviceId, name });
    this.app.activity.log('info', 'mobile', 'Pairing code shown for Jarvis Mobile (valid 5 minutes)');
    this.emitChanged();
    return { uri: `jarvis://pair?${q.toString()}`, expiresAt: this.pairing.expires };
  }

  cancelPairing(): void {
    if (this.pairing) this.relay?.send({ t: 'pair.close', room: this.pairing.room });
    this.pairing = null;
    this.emitChanged();
  }

  private pcName(): string {
    const user = this.app.settings.get().assistant.userName;
    return truncate(`${user ? `${user}'s ` : ''}PC Jarvis`, 80);
  }

  private onPairMessage(f: Extract<RelayFrame, { t: 'pair.msg' }>) {
    const p = this.pairing;
    const from = f.from;
    if (!p || p.room !== f.room || !from) return;
    if (p.expires < Date.now()) {
      this.audit(from, 'device.pair.request', 'rejected', 'pairing code expired');
      return this.cancelPairing();
    }
    const key = pairingKey(p.secret, p.room);
    let env: Envelope;
    try {
      env = parseEnvelope(open(key, f.data, pairAad(p.room, from)));
    } catch (err) {
      p.failures++;
      this.audit(from, 'device.pair.request', 'rejected', `bad pairing message: ${errorMessage(err)}`);
      if (p.failures >= 5) {
        this.app.activity.log('warning', 'mobile', 'Pairing closed after repeated invalid attempts');
        this.cancelPairing();
      }
      return;
    }
    const me = this.identity();
    const reply = (type: MessageType, payload: unknown) => {
      const out = this.envelope(type, payload, from, env.sessionId, env.id);
      this.relay?.send({ t: 'pair.msg', room: p.room, to: from, data: seal(key, JSON.stringify(out), pairAad(p.room, me.deviceId)) });
    };
    if (env.type !== 'device.pair.request') return;
    const req = env.payload as z.infer<(typeof Payloads)['device.pair.request']>;
    // The relay-authenticated sender, the envelope sender and the key in the request must all agree.
    if (env.from !== from || deviceIdOf(req.pubSign) !== from || env.to !== me.deviceId) {
      this.audit(from, 'device.pair.request', 'rejected', 'identity mismatch');
      return reply('device.pair.reject', { reason: 'Device identity does not match its key' });
    }
    const now = Date.now();
    this.app.db.run(
      `INSERT INTO mobile_devices (id, name, platform, app_version, pub_sign, pub_agree, scopes, paired_at, last_seen, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, app_version = excluded.app_version, pub_agree = excluded.pub_agree, scopes = excluded.scopes, paired_at = excluded.paired_at, revoked_at = NULL`,
      from,
      req.deviceName,
      req.platform,
      req.appVersion,
      req.pubSign,
      req.pubAgree,
      JSON.stringify(DEFAULT_SCOPES),
      now,
      now,
    );
    reply('device.pair.confirm', { pcDeviceId: me.deviceId, pcName: this.pcName(), pubSign: me.signPub, pubAgree: me.agreePub, scopes: DEFAULT_SCOPES, jarvisVersion: this.version() });
    this.pairing = null;
    this.relay?.send({ t: 'pair.close', room: p.room });
    this.pushAllowList();
    this.audit(from, 'device.pair.request', 'paired', req.deviceName);
    this.app.activity.log('success', 'mobile', `Paired Jarvis Mobile: ${req.deviceName}`);
    this.app.activity.notify('success', 'Phone paired', `${req.deviceName} can now reach this PC's Jarvis`);
    this.emitChanged();
  }

  revoke(id: string, reason = 'Revoked on the PC'): void {
    const row = this.device(id);
    if (!row) throw new Error('No such paired device');
    // Tell the phone (best effort) before cutting it off.
    this.sendTo(row, 'device.revoke', { reason });
    this.app.db.run('UPDATE mobile_devices SET revoked_at = ? WHERE id = ?', Date.now(), id);
    this.pushAllowList();
    this.audit(id, 'device.revoke', 'revoked', reason);
    this.app.activity.log('warning', 'mobile', `Revoked Jarvis Mobile device: ${row.name}`);
    this.emitChanged();
  }

  setScopes(id: string, scopes: DeviceScope[]): void {
    const row = this.device(id);
    if (!row) throw new Error('No such paired device');
    const clean = [...new Set(scopes.filter((s) => DeviceScope.options.includes(s)))];
    this.app.db.run('UPDATE mobile_devices SET scopes = ? WHERE id = ?', JSON.stringify(clean), id);
    this.audit(id, 'device.scopes', 'updated', clean.join(','));
    this.sendTo(row, 'device.status', this.statusPayload(clean));
    this.emitChanged();
  }

  private pushAllowList() {
    const ids = this.app.db.all<{ id: string }>('SELECT id FROM mobile_devices WHERE revoked_at IS NULL').map((r) => r.id);
    this.relay?.send({ t: 'allow', devices: ids.slice(0, 64) });
  }

  private version(): string {
    return String((this.app.statusSnapshot() as { version?: string }).version ?? '');
  }

  // ---------------------------------------------------------------- messaging

  private envelope(type: MessageType, payload: unknown, to: string, sessionId: string, correlationId?: string): Envelope {
    return { v: PROTOCOL_VERSION, id: `pc_${randomB64Url(12)}`, sessionId, from: this.identity().deviceId, to, ts: Date.now(), type, payload, ...(correlationId ? { correlationId } : {}) } as Envelope;
  }

  private sessions = new Map<string, string>();

  private sendTo(row: DeviceRow, type: MessageType, payload: unknown, correlationId?: string): boolean {
    if (!this.relay || !this.online.has(row.id)) return false;
    const me = this.identity();
    const env = this.envelope(type, payload, row.id, this.sessions.get(row.id) ?? `pc_${me.deviceId.slice(0, 12)}`, correlationId);
    const key = messageKey(me.agreePriv, row.pub_agree, me.deviceId, row.id);
    return this.relay.send({ t: 'msg', to: row.id, data: seal(key, JSON.stringify(env), msgAad(me.deviceId, row.id)) });
  }

  private broadcast(type: MessageType, payload: unknown) {
    for (const id of this.online) {
      const row = this.device(id);
      if (row && (JSON.parse(row.scopes) as DeviceScope[]).includes('observe')) this.sendTo(row, type, payload);
    }
  }

  private onFrame(f: RelayFrame) {
    if (f.t === 'presence') {
      if (f.online) {
        if (this.device(f.deviceId)) {
          this.online.add(f.deviceId);
          this.app.db.run('UPDATE mobile_devices SET last_seen = ? WHERE id = ?', Date.now(), f.deviceId);
        }
      } else this.online.delete(f.deviceId);
      return this.emitChanged();
    }
    if (f.t === 'pair.msg') return this.onPairMessage(f);
    if (f.t === 'msg' && f.from) return void this.onMessage(f.from, f.data);
  }

  private reject(row: DeviceRow, env: Envelope | null, code: string, reason: string) {
    this.audit(row.id, env?.type ?? 'unknown', 'rejected', `${code}: ${reason}`);
    if (env && (env.type === 'jarvis.command.submit' || env.type === 'voice.transcript')) this.sendTo(row, 'jarvis.command.rejected', { code, reason }, env.id);
    else this.sendTo(row, 'error', { code, message: reason }, env?.id);
  }

  async onMessage(from: string, data: string): Promise<void> {
    const row = this.device(from);
    if (!row) return this.audit(from, 'unknown', 'rejected', 'unknown or revoked device');
    const me = this.identity();
    let env: Envelope;
    try {
      const plain = open(messageKey(me.agreePriv, row.pub_agree, from, me.deviceId), data, msgAad(from, me.deviceId));
      env = parseEnvelope(plain);
    } catch (err) {
      return this.reject(row, null, err instanceof ProtocolError ? err.code : 'decrypt_failed', errorMessage(err));
    }
    // Destination and sender must match the authenticated route.
    if (env.from !== from || env.to !== me.deviceId) return this.reject(row, env, 'misrouted', 'Sender or destination does not match');
    // Replay protection: a message id is accepted once within the replay window.
    const now = Date.now();
    for (const [k, ts] of this.seen) if (now - ts > 11 * 60_000) this.seen.delete(k);
    const seenKey = `${from}:${env.id}`;
    if (this.seen.has(seenKey)) return this.audit(from, env.type, 'rejected', 'replayed message id');
    this.seen.set(seenKey, now);
    this.sessions.set(from, env.sessionId);
    this.app.db.run('UPDATE mobile_devices SET last_seen = ? WHERE id = ?', now, from);
    this.online.add(from);

    // Authorization: the device's scopes, checked for every message.
    const scopes = JSON.parse(row.scopes) as DeviceScope[];
    const need = REQUIRED_SCOPE[env.type];
    if (!need) return this.reject(row, env, 'unsupported', `${env.type} is not accepted from a phone`);
    if (!scopes.includes(need)) return this.reject(row, env, 'unauthorized', `This phone is not allowed to ${need} (change it in Jarvis → Settings → Jarvis Mobile)`);

    // Idempotency: a retried command is answered from the ledger, never executed twice.
    if (env.idempotencyKey) {
      const prior = this.app.db.get<{ status: string; response: string | null }>('SELECT status, response FROM mobile_commands WHERE device_id = ? AND idempotency_key = ?', from, env.idempotencyKey);
      if (prior) {
        this.audit(from, env.type, 'deduplicated', env.idempotencyKey);
        if (prior.status === 'done' && prior.response) {
          const r = JSON.parse(prior.response) as { type: MessageType; payload: unknown };
          this.sendTo(row, r.type, r.payload, env.id);
        } else this.sendTo(row, 'jarvis.command.accepted', { conversationId: null }, env.id);
        return;
      }
      // Rate limit consequential commands per device.
      const recent = (this.rate.get(from) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= COMMANDS_PER_MINUTE) return this.reject(row, env, 'rate_limited', 'Too many commands; wait a minute');
      recent.push(now);
      this.rate.set(from, recent);
      this.app.db.run('INSERT INTO mobile_commands (device_id, idempotency_key, type, status, response, created_at) VALUES (?, ?, ?, ?, NULL, ?)', from, env.idempotencyKey, env.type, 'running', now);
    }

    const finish = (type: MessageType, payload: unknown) => {
      if (env.idempotencyKey) this.app.db.run("UPDATE mobile_commands SET status = 'done', response = ? WHERE device_id = ? AND idempotency_key = ?", JSON.stringify({ type, payload }), from, env.idempotencyKey);
      this.sendTo(row, type, payload, env.id);
    };

    try {
      await this.dispatch(row, env, finish);
    } catch (err) {
      this.audit(from, env.type, 'failed', errorMessage(err));
      finish('error', { code: 'failed', message: truncate(errorMessage(err), 480) });
    }
  }

  private async dispatch(row: DeviceRow, env: Envelope, finish: (type: MessageType, payload: unknown) => void): Promise<void> {
    const p = env.payload as Record<string, unknown>;
    switch (env.type) {
      case 'connection.heartbeat':
        return void this.sendTo(row, 'connection.heartbeat', { seq: ++this.seq }, env.id);
      case 'pc.snapshot.request':
        this.sendTo(row, 'device.status', this.statusPayload(JSON.parse(row.scopes)), env.id);
        return void this.sendTo(row, 'pc.snapshot', this.snapshot(), env.id);
      case 'voice.session.started':
        return this.audit(row.id, env.type, 'ok', 'phone speech recognition');
      case 'jarvis.command.submit':
      case 'voice.transcript': {
        if (env.type === 'voice.transcript' && !(p.final as boolean)) return;
        const text = String(p.text);
        const via = env.type === 'voice.transcript' ? 'voice' : (p.via as 'text' | 'voice');
        this.sendTo(row, 'jarvis.command.accepted', { conversationId: (p.conversationId as string | null) ?? null }, env.id);
        this.audit(row.id, env.type, 'accepted', truncate(text, 200));
        // The same pipeline as typing on this PC: the permission engine, request scope and approvals apply.
        const r = await this.app.jarvis.handleMessage({ conversationId: (p.conversationId as string | null) ?? null, text, via });
        const actions = (r.actions ?? []).map((a) =>
          a.type === 'task_created' ? { type: a.type, title: a.title, taskId: a.taskId, needsApproval: a.needsApproval.length > 0 } : { type: a.type },
        );
        this.audit(row.id, env.type, r.error ? 'failed' : 'completed', truncate(r.reply.content, 200));
        return finish('jarvis.response.complete', { conversationId: r.conversationId, text: truncate(r.reply.content, 59_000), handledBy: r.handledBy, actions, error: r.error ?? null });
      }
      case 'task.cancel': {
        const task = this.app.engine.cancel(String(p.taskId));
        this.audit(row.id, env.type, 'ok', task.title);
        return finish('task.progress', { task: this.taskSummary(task) });
      }
      case 'approval.resolve': {
        const decision = p.decision as 'approve' | 'deny';
        const a = this.app.permissions.decideApproval(String(p.approvalId), decision, { note: `From ${row.name} (Jarvis Mobile)` });
        // The task engine may already have consumed the approval ("used"): report what the user decided.
        const status = decision === 'approve' ? 'approved' : 'denied';
        this.audit(row.id, env.type, status, a.summary);
        return finish('approval.resolved', { approvalId: a.id, status });
      }
      case 'agent.run': {
        const id = AgentId.parse(p.agentId);
        await this.app.subAgents.runAgent(id);
        this.audit(row.id, env.type, 'ok', id);
        return finish('agent.status.changed', { agents: this.agents(), agentsEnabled: this.app.settings.get().agents.enabled });
      }
      case 'system.emergency_stop': {
        let cancelled = 0;
        for (const t of this.app.tasks.list({ status: 'active', limit: 500 })) {
          try {
            this.app.engine.cancel(t.id);
            cancelled++;
          } catch {
            /* already finished */
          }
        }
        const computer = this.app.computer.status().enabled;
        this.app.computer.emergencyStop(`Emergency stop from ${row.name}`);
        this.audit(row.id, env.type, 'stopped', `${cancelled} task(s) cancelled`);
        this.app.activity.log('warning', 'mobile', `EMERGENCY STOP from ${row.name}: ${cancelled} task(s) cancelled${computer ? ', Computer Access stopped' : ''}`);
        return finish('system.stopped', { cancelledTasks: cancelled, computerAccessStopped: computer });
      }
      default:
        throw new Error(`Unhandled ${env.type}`);
    }
  }

  // ---------------------------------------------------------------- state → phone

  private statusPayload(scopes: DeviceScope[]) {
    const s = this.app.statusSnapshot() as { model?: { model: string } | null };
    return { online: true, name: this.pcName(), jarvisVersion: this.version(), brain: s.model?.model ?? null, scopes };
  }

  private agents() {
    return this.app.subAgents.list().map((a) => ({
      id: a.id as AgentId,
      name: AGENT_CATALOG[a.id as AgentId]?.name ?? a.name,
      color: a.color,
      role: truncate(a.role, 400),
      state: a.state,
      lastRunAt: a.lastRunAt,
      lastSummary: truncate(a.lastSummary, 1000),
      runs: a.runs,
      error: a.error ? truncate(a.error, 500) : null,
    }));
  }

  private taskSummary(t: Task) {
    return { id: t.id, title: truncate(t.title, 300), status: t.status, progress: t.progress, createdAt: t.createdAt, updatedAt: t.updatedAt, error: t.error ? truncate(t.error, 1000) : null, result: t.result?.summary ? truncate(t.result.summary, 4000) : null };
  }

  private approvals() {
    return this.app.permissions.listApprovals('pending', 100).map((a) => ({ id: a.id, taskId: a.taskId, taskTitle: truncate(this.app.tasks.get(a.taskId)?.title ?? '(deleted task)', 300), summary: truncate(a.summary, 600), reason: a.reason ? truncate(a.reason, 600) : null, scope: a.scope, createdAt: a.createdAt }));
  }

  snapshot() {
    const state = this.app.state.get();
    return {
      agents: this.agents(),
      agentsEnabled: this.app.settings.get().agents.enabled,
      tasks: [...this.app.tasks.list({ status: 'active', limit: 50 }), ...this.app.tasks.list({ limit: 20 }).filter((t) => !['queued', 'running', 'paused', 'awaiting_approval'].includes(t.status))].slice(0, 60).map((t) => this.taskSummary(t)),
      approvals: this.approvals(),
      assistantState: state.state,
      assistantDetail: truncate(state.detail, 300),
    };
  }

  /** Forward PC events (tasks, approvals, agents) to connected phones. */
  private subscribe() {
    if (this.unsub.length) return;
    this.unsub.push(
      this.app.bus.on('task.updated', (e) => {
        if (!this.online.size) return;
        const t = this.app.tasks.get(String(e.data.id));
        if (!t) return;
        const prev = this.knownTasks.get(t.id);
        this.knownTasks.set(t.id, t.status);
        const type: MessageType = !prev ? 'task.created' : t.status === 'completed' ? 'task.completed' : t.status === 'failed' ? 'task.failed' : 'task.progress';
        this.broadcast(type, { task: this.taskSummary(t) });
      }),
      this.app.bus.on('approval.updated', (e) => {
        if (!this.online.size) return;
        const status = String(e.data.status ?? '');
        if (status === 'pending' || !status) {
          const a = this.approvals().find((x) => x.id === e.data.id);
          if (a) this.broadcast('approval.requested', { approval: a });
        } else if (e.data.id && ['approved', 'denied', 'expired', 'used'].includes(status)) {
          this.broadcast('approval.resolved', { approvalId: String(e.data.id), status });
        }
      }),
      this.app.bus.on('agents.changed', () => {
        if (!this.online.size || this.agentTimer) return;
        this.agentTimer = setTimeout(() => {
          this.agentTimer = null;
          this.broadcast('agent.status.changed', { agents: this.agents(), agentsEnabled: this.app.settings.get().agents.enabled });
        }, 300);
        this.agentTimer.unref?.();
      }),
    );
  }
}
