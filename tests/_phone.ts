/**
 * A test phone: speaks the Jarvis Mobile protocol with the same shared crypto as the Android app
 * (which has its own Kotlin implementation, checked against shared/protocol/fixtures). Used by the
 * Node tests and by the cross-language end-to-end harness.
 */
import { randomBytes } from 'node:crypto';
import { RelayClient } from '../server/mobile/relay-client.ts';
import { PROTOCOL_VERSION, parseEnvelope, type Envelope, type MessageType, type RelayFrame } from '../shared/protocol/protocol.ts';
import { deviceIdOf, generateDeviceKeys, messageKey, msgAad, open, pairAad, pairingKey, seal } from '../shared/protocol/crypto.ts';

export class TestPhone {
  /** Every test phone, so a failing test can still close them all. */
  static all = new Set<TestPhone>();
  keys = generateDeviceKeys();
  inbox: Envelope[] = [];
  frames: RelayFrame[] = [];
  client: RelayClient | null = null;
  pc: { id: string; pubAgree: string; pubSign: string } | null = null;
  sessionId = `ses_${randomBytes(6).toString('hex')}`;
  private pairCtx: { room: string; key: Buffer; pc: string } | null = null;

  get id(): string {
    return this.keys.deviceId;
  }

  async connect(url: string): Promise<void> {
    TestPhone.all.add(this);
    this.client = new RelayClient({ url, role: 'phone', keys: { deviceId: this.keys.deviceId, signPub: this.keys.signPub, signPriv: this.keys.signPriv }, onFrame: (f) => this.onFrame(f) });
    this.client.start();
    await waitUntil(() => this.client!.state === 'connected', 5000, 'phone connected to the relay');
  }

  stop(): void {
    this.client?.stop();
    TestPhone.all.delete(this);
  }

  static stopAll(): void {
    for (const p of [...TestPhone.all]) p.stop();
  }

  private onFrame(f: RelayFrame) {
    this.frames.push(f);
    if (f.t === 'pair.msg' && this.pairCtx && f.from === this.pairCtx.pc) {
      const env = parseEnvelope(open(this.pairCtx.key, f.data, pairAad(this.pairCtx.room, f.from)));
      this.inbox.push(env);
      if (env.type === 'device.pair.confirm') {
        const p = env.payload as { pubAgree: string; pubSign: string; pcDeviceId: string };
        if (deviceIdOf(p.pubSign) !== this.pairCtx.pc) throw new Error('PC identity does not match the QR code');
        this.pc = { id: p.pcDeviceId, pubAgree: p.pubAgree, pubSign: p.pubSign };
      }
    }
    if (f.t === 'msg' && this.pc && f.from === this.pc.id) {
      const key = messageKey(this.keys.agreePriv, this.pc.pubAgree, this.pc.id, this.keys.deviceId);
      this.inbox.push(parseEnvelope(open(key, f.data, msgAad(this.pc.id, this.keys.deviceId))));
    }
  }

  /** Pair from the URI the PC shows as a QR code. */
  async pair(uri: string, opts: { secret?: string } = {}): Promise<Envelope> {
    const q = new URL(uri).searchParams;
    const room = q.get('room')!;
    const pc = q.get('pc')!;
    const secret = opts.secret ?? q.get('secret')!;
    this.pairCtx = { room, key: pairingKey(secret, room), pc };
    const env = this.envelope('device.pair.request', { deviceName: 'Test Pixel', platform: 'android', appVersion: '0.1.0', pubSign: this.keys.signPub, pubAgree: this.keys.agreePub }, pc);
    this.client!.send({ t: 'pair.msg', room, data: seal(this.pairCtx.key, JSON.stringify(env), pairAad(room, this.keys.deviceId)) });
    return this.waitFor((e) => e.type === 'device.pair.confirm' || e.type === 'device.pair.reject', 5000);
  }

  envelope(type: MessageType, payload: unknown, to: string, extra: Partial<Envelope> = {}): Envelope {
    return { v: PROTOCOL_VERSION, id: `ph_${randomBytes(9).toString('hex')}`, sessionId: this.sessionId, from: this.keys.deviceId, to, ts: Date.now(), type, payload, ...extra } as Envelope;
  }

  /** Seal and send an envelope to the paired PC. Returns it (for correlation). */
  send(type: MessageType, payload: unknown, extra: Partial<Envelope> & { raw?: (sealed: string) => string } = {}): Envelope {
    const { raw, ...rest } = extra;
    const env = this.envelope(type, payload, this.pc!.id, rest);
    const key = messageKey(this.keys.agreePriv, this.pc!.pubAgree, this.keys.deviceId, this.pc!.id);
    const sealed = seal(key, JSON.stringify(env), msgAad(this.keys.deviceId, this.pc!.id));
    this.client!.send({ t: 'msg', to: this.pc!.id, data: raw ? raw(sealed) : sealed });
    return env;
  }

  async waitFor(pred: (e: Envelope) => boolean, timeoutMs = 8000): Promise<Envelope> {
    return waitUntil(() => this.inbox.find(pred), timeoutMs, 'expected message from the PC');
  }
}

export async function waitUntil<T>(fn: () => T | undefined | null | false, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
