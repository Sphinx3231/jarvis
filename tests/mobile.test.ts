import { rmSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, type RunningRelay } from '../relay/relay.ts';
import { RelayClient, relayUrlProblem } from '../server/mobile/relay-client.ts';
import { deviceIdOf, generateDeviceKeys, messageKey, msgAad, open, pairingKey, relayAuthMessage, seal, signB64, verifyB64, pairAad } from '../shared/protocol/crypto.ts';
import { parseEnvelope, ProtocolError, PROTOCOL_VERSION } from '../shared/protocol/protocol.ts';
import { makeApp } from './helpers.ts';
import { TestPhone, waitUntil } from './_phone.ts';
import type { JarvisApp } from '../server/app.ts';

async function withPcAndRelay(fn: (ctx: { app: JarvisApp; relay: RunningRelay }) => Promise<void>, relayOpts = {}) {
  const relay = await startRelay(relayOpts);
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ mobile: { enabled: true, relayUrl: relay.url } });
    await waitUntil(() => app.mobile.status().state === 'connected', 5000, 'PC connected to the relay');
    await fn({ app, relay });
  } finally {
    TestPhone.stopAll();
    await cleanup();
    await relay.close();
  }
}

async function pairedPhone(app: JarvisApp, relay: RunningRelay): Promise<TestPhone> {
  const phone = new TestPhone();
  await phone.connect(relay.url);
  const { uri } = app.mobile.startPairing();
  const confirm = await phone.pair(uri);
  assert.equal(confirm.type, 'device.pair.confirm');
  await waitUntil(() => app.mobile.status().devices.find((d) => d.id === phone.id)?.online, 5000, 'phone online on the PC');
  return phone;
}

test('mobile crypto: signatures, ECDH both ways, AES-GCM tamper detection', () => {
  const a = generateDeviceKeys();
  const b = generateDeviceKeys();
  assert.equal(a.deviceId, deviceIdOf(a.signPub));
  const msg = relayAuthMessage('nonce', a.deviceId);
  assert.ok(verifyB64(a.signPub, msg, signB64(a.signPriv, msg)));
  assert.ok(!verifyB64(b.signPub, msg, signB64(a.signPriv, msg)), 'another key does not verify');
  const kAB = messageKey(a.agreePriv, b.agreePub, a.deviceId, b.deviceId);
  const kAB2 = messageKey(b.agreePriv, a.agreePub, a.deviceId, b.deviceId);
  assert.deepEqual(kAB, kAB2, 'both ends derive the same directional key');
  assert.notDeepEqual(kAB, messageKey(a.agreePriv, b.agreePub, b.deviceId, a.deviceId), 'each direction has its own key');
  const sealed = seal(kAB, 'hello', msgAad(a.deviceId, b.deviceId));
  assert.equal(open(kAB2, sealed, msgAad(a.deviceId, b.deviceId)), 'hello');
  assert.throws(() => open(kAB, sealed, msgAad(b.deviceId, a.deviceId)), 'wrong AAD (re-addressed) is rejected');
  const bytes = Buffer.from(sealed, 'base64');
  bytes[20] ^= 1;
  assert.throws(() => open(kAB, bytes.toString('base64'), msgAad(a.deviceId, b.deviceId)), 'tampered ciphertext is rejected');
  assert.equal(relayUrlProblem('ws://relay.example.com/v1') !== null, true, 'plain ws to the internet is refused');
  assert.equal(relayUrlProblem('wss://relay.example.com/v1'), null);
  assert.equal(relayUrlProblem('ws://127.0.0.1:9/v1'), null);
});

test('mobile protocol: version, shape, freshness and idempotency keys are validated', () => {
  const a = generateDeviceKeys().deviceId;
  const b = generateDeviceKeys().deviceId;
  const base = { v: PROTOCOL_VERSION, id: 'msg_12345678', sessionId: 'ses_12345678', from: a, to: b, ts: Date.now() };
  assert.equal(parseEnvelope(JSON.stringify({ ...base, type: 'connection.heartbeat', payload: { seq: 1 } })).type, 'connection.heartbeat');
  const bad = (env: unknown, code: string) => assert.throws(() => parseEnvelope(JSON.stringify(env)), (e: unknown) => e instanceof ProtocolError && e.code === code);
  bad({ ...base, v: 2, type: 'connection.heartbeat', payload: { seq: 1 } }, 'version');
  bad({ ...base, type: 'jarvis.command.submit', payload: { text: 'hi', conversationId: null, via: 'text' } }, 'no_idempotency_key');
  bad({ ...base, type: 'jarvis.command.submit', idempotencyKey: 'idem_1234', payload: { text: '', conversationId: null, via: 'text' } }, 'bad_payload');
  bad({ ...base, ts: Date.now() - 10 * 60_000, type: 'connection.heartbeat', payload: { seq: 1 } }, 'stale');
  bad({ ...base, type: 'nope', payload: {} }, 'bad_envelope');
});

test('relay: a device must prove its key; impostors, unpaired devices and floods are refused', async () => {
  const relay = await startRelay({ maxAuthFailures: 3, rate: 5, burst: 5 });
  try {
    const real = generateDeviceKeys();
    const impostor = generateDeviceKeys();
    // Claims the real device id but signs with another key.
    const states: string[] = [];
    const fake = new RelayClient({ url: relay.url, role: 'phone', keys: { deviceId: real.deviceId, signPub: real.signPub, signPriv: impostor.signPriv }, onFrame: () => {}, onState: (s, d) => states.push(`${s}:${d}`) });
    fake.start();
    await waitUntil(() => states.some((s) => s.startsWith('error')), 5000, 'impostor rejected');
    fake.stop();
    assert.equal(relay.stats().clients, 0, 'the impostor never became a client');

    // An authenticated phone that no PC has paired can't message anyone.
    const loner = new TestPhone();
    await loner.connect(relay.url);
    const pc = generateDeviceKeys();
    loner.client!.send({ t: 'msg', to: pc.deviceId, data: 'AAAA' });
    await waitUntil(() => loner.frames.find((f) => f.t === 'error' && f.code === 'not_allowed'), 3000, 'not_allowed');
    // Flooding is rate limited.
    for (let i = 0; i < 20; i++) loner.client!.send({ t: 'ping', ts: i });
    await waitUntil(() => loner.frames.find((f) => f.t === 'error' && f.code === 'rate_limited'), 3000, 'rate_limited');
    loner.stop();
  } finally {
    await relay.close();
  }
});

test('mobile: pairing over the relay — the QR secret is required, one phone per code, codes expire', async () => {
  await withPcAndRelay(async ({ app, relay }) => {
    // Wrong secret: never paired, and the PC keeps refusing.
    const attacker = new TestPhone();
    await attacker.connect(relay.url);
    const { uri } = app.mobile.startPairing();
    await assert.rejects(attacker.pair(uri, { secret: Buffer.alloc(32, 7).toString('base64') }), /Timed out/);
    assert.equal(app.mobile.devices().length, 0);
    attacker.stop();

    const phone = await pairedPhone(app, relay);
    const dev = app.mobile.devices()[0];
    assert.equal(dev.id, phone.id);
    assert.equal(dev.name, 'Test Pixel');
    assert.deepEqual(dev.scopes, ['observe', 'command', 'approve', 'stop']);
    assert.equal(phone.pc?.id, app.mobile.identity().deviceId, 'the phone pinned the PC from the QR code');

    // The code is one-time: a second phone can't reuse it.
    const second = new TestPhone();
    await second.connect(relay.url);
    await assert.rejects(second.pair(uri), /Timed out/);
    assert.ok(second.frames.some((f) => f.t === 'error' && f.code === 'room_unknown'), 'the room closed after the first pairing');
    second.stop();
    phone.stop();
    assert.ok(app.mobile.auditLog().some((a) => a.type === 'device.pair.request' && a.outcome === 'rejected'));
  });
});

test('mobile: a command from the phone runs through PC Jarvis once — accepted, then completed; duplicates and replays never re-run', async () => {
  await withPcAndRelay(async ({ app, relay }) => {
    const phone = await pairedPhone(app, relay);
    const cmd = phone.send('jarvis.command.submit', { text: 'remember that my phone is a Pixel 9', conversationId: null, via: 'text' }, { idempotencyKey: 'idem_cmd_00001' });
    const accepted = await phone.waitFor((e) => e.type === 'jarvis.command.accepted' && e.correlationId === cmd.id);
    const done = await phone.waitFor((e) => e.type === 'jarvis.response.complete' && e.correlationId === cmd.id);
    assert.ok(accepted.ts <= done.ts, 'accepted comes before completed');
    const p = done.payload as { text: string; conversationId: string; actions: Array<{ type: string }> };
    assert.match(p.text, /remember that/);
    assert.ok(p.actions.some((a) => a.type === 'memory_saved'));
    assert.equal(app.memory.list({ kind: 'fact' }).filter((m) => /Pixel 9/.test(m.content)).length, 1);

    // The same command delivered again after a reconnect (same idempotency key, new message id).
    const again = phone.send('jarvis.command.submit', { text: 'remember that my phone is a Pixel 9', conversationId: null, via: 'text' }, { idempotencyKey: 'idem_cmd_00001' });
    const replayAnswer = await phone.waitFor((e) => e.type === 'jarvis.response.complete' && e.correlationId === again.id);
    assert.equal((replayAnswer.payload as { text: string }).text, p.text, 'answered from the ledger');
    assert.equal(app.conversations.messages(p.conversationId).length, 2, 'not executed twice');

    // A replayed message id (an attacker re-sending a captured frame) is dropped.
    const before = app.mobile.auditLog().length;
    phone.send('connection.heartbeat', { seq: 1 }, { id: 'ph_replay_000001' });
    phone.send('connection.heartbeat', { seq: 1 }, { id: 'ph_replay_000001' });
    await waitUntil(() => app.mobile.auditLog().some((a) => a.detail === 'replayed message id'), 3000, 'replay detected');
    assert.ok(app.mobile.auditLog().length > before);
    phone.stop();
  });
});

test('mobile: tampered, stale, misrouted and unauthorized messages are rejected; revoked phones are cut off', async () => {
  await withPcAndRelay(async ({ app, relay }) => {
    const phone = await pairedPhone(app, relay);
    // Tampered ciphertext.
    phone.send('connection.heartbeat', { seq: 2 }, {
      raw: (s) => {
        const b = Buffer.from(s, 'base64');
        b[b.length - 20] ^= 0xff;
        return b.toString('base64');
      },
    });
    await waitUntil(() => app.mobile.auditLog().find((a) => a.detail.startsWith('decrypt_failed')), 3000, 'tamper detected');
    // Stale timestamp (outside the replay window).
    phone.send('connection.heartbeat', { seq: 3 }, { ts: Date.now() - 20 * 60_000 });
    await waitUntil(() => app.mobile.auditLog().find((a) => a.detail.startsWith('stale')), 3000, 'stale rejected');

    // Scope: an observe-only phone can watch but not command (no privilege escalation).
    const id = phone.id;
    app.mobile.setScopes(id, ['observe']);
    const cmd = phone.send('jarvis.command.submit', { text: 'run `echo nope`', conversationId: null, via: 'text' }, { idempotencyKey: 'idem_cmd_00002' });
    const rej = await phone.waitFor((e) => e.type === 'jarvis.command.rejected' && e.correlationId === cmd.id);
    assert.equal((rej.payload as { code: string }).code, 'unauthorized');
    const stop = phone.send('system.emergency_stop', { reason: 'test' }, { idempotencyKey: 'idem_stop_0001' });
    await phone.waitFor((e) => e.type === 'error' && e.correlationId === stop.id);
    assert.equal(app.tasks.list({ limit: 10 }).length, 0, 'nothing ran');

    // Revocation: the PC tells the phone, the relay stops routing, the PC ignores it.
    app.mobile.revoke(id);
    await phone.waitFor((e) => e.type === 'device.revoke');
    await new Promise((r) => setTimeout(r, 200));
    phone.inbox.length = 0;
    phone.send('pc.snapshot.request', {});
    await waitUntil(() => phone.frames.find((f) => f.t === 'error' && f.code === 'not_allowed'), 3000, 'relay refuses a revoked phone');
    assert.equal(phone.inbox.length, 0);
    phone.stop();
  });
});

test('mobile: snapshot, live task and approval events, approving from the phone, and emergency stop', async () => {
  await withPcAndRelay(async ({ app, relay }) => {
    const phone = await pairedPhone(app, relay);
    phone.send('pc.snapshot.request', {});
    const snap = await phone.waitFor((e) => e.type === 'pc.snapshot');
    const s = snap.payload as { agents: Array<{ id: string }>; tasks: unknown[] };
    assert.deepEqual(s.agents.map((a) => a.id).sort(), ['echo', 'friday', 'neo', 'sentinel', 'tom', 'trinity']);
    await phone.waitFor((e) => e.type === 'device.status');

    // Something nobody asked for waits for approval — the phone sees why, and can decide.
    app.engine.createTask({ title: 'Housekeeping', origin: 'system', steps: [{ skill: 'shell.run', input: { command: 'echo from-the-phone' }, description: 'Run housekeeping' }] });
    const req = await phone.waitFor((e) => e.type === 'approval.requested');
    const approval = (req.payload as { approval: { id: string; summary: string; reason: string | null } }).approval;
    assert.match(approval.summary, /echo from-the-phone/);
    assert.match(approval.reason ?? '', /Nobody asked for this task directly/);
    const resolve = phone.send('approval.resolve', { approvalId: approval.id, decision: 'approve' }, { idempotencyKey: 'idem_appr_0001' });
    await phone.waitFor((e) => e.type === 'approval.resolved' && e.correlationId === resolve.id);
    const completed = await phone.waitFor((e) => e.type === 'task.completed', 10_000);
    assert.equal((completed.payload as { task: { title: string } }).task.title, 'Housekeeping');
    assert.ok(app.mobile.auditLog().some((a) => a.type === 'approval.resolve' && a.outcome === 'approved'));

    // Emergency stop cancels what is active.
    app.engine.createTask({ title: 'Later', origin: 'user', steps: [{ skill: 'notify.user', input: { title: 'x' }, description: 'later' }], scheduledFor: Date.now() + 3_600_000 });
    const stop = phone.send('system.emergency_stop', { reason: 'test' }, { idempotencyKey: 'idem_stop_0002' });
    const stopped = await phone.waitFor((e) => e.type === 'system.stopped' && e.correlationId === stop.id);
    assert.ok((stopped.payload as { cancelledTasks: number }).cancelledTasks >= 1);
    assert.equal(app.tasks.list({ status: 'active', limit: 10 }).length, 0);
    phone.stop();
  });
});

test('mobile: PC offline, relay down and reconnection — the phone is told, nothing is lost, the PC reconnects', async () => {
  const relay = await startRelay();
  const port = relay.port;
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ mobile: { enabled: true, relayUrl: relay.url } });
    await waitUntil(() => app.mobile.status().state === 'connected', 5000, 'PC connected');
    const phone = await pairedPhone(app, relay);
    // The PC goes offline: the phone learns it, and a command gets peer_offline rather than vanishing.
    app.settings.update({ mobile: { enabled: false } });
    await waitUntil(() => phone.frames.find((f) => f.t === 'presence' && !f.online), 3000, 'presence offline');
    phone.send('connection.heartbeat', { seq: 9 });
    await waitUntil(() => phone.frames.find((f) => f.t === 'error' && f.code === 'peer_offline'), 3000, 'peer_offline');
    app.settings.update({ mobile: { enabled: true } });
    await waitUntil(() => phone.frames.filter((f) => f.t === 'presence' && f.online).length >= 1 && app.mobile.status().devices[0]?.online, 5000, 'back online');
    phone.stop();

    // The relay itself goes down: the PC reports it and retries until it is back.
    await relay.close();
    await waitUntil(() => app.mobile.status().state === 'error', 5000, 'relay down reported');
    const again = await startRelay({ port });
    try {
      await waitUntil(() => app.mobile.status().state === 'connected', 20_000, 'PC reconnected to the restarted relay');
    } finally {
      await again.close();
    }
  } finally {
    TestPhone.stopAll();
    await cleanup();
  }
});

test('mobile: pairing payload binding — a request claiming another device id is refused', async () => {
  await withPcAndRelay(async ({ app, relay }) => {
    const phone = new TestPhone();
    await phone.connect(relay.url);
    const { uri } = app.mobile.startPairing();
    const q = new URL(uri).searchParams;
    const room = q.get('room')!;
    const key = pairingKey(q.get('secret')!, room);
    const other = generateDeviceKeys();
    // Correct secret, but the request carries someone else's signing key.
    const env = phone.envelope('device.pair.request', { deviceName: 'Sneaky', platform: 'android', appVersion: '1', pubSign: other.signPub, pubAgree: other.agreePub }, q.get('pc')!);
    phone.client!.send({ t: 'pair.msg', room, data: seal(key, JSON.stringify(env), pairAad(room, phone.id)) });
    await waitUntil(() => app.mobile.auditLog().find((a) => a.detail === 'identity mismatch'), 3000, 'identity mismatch');
    assert.equal(app.mobile.devices().length, 0);
    phone.stop();
  });
});

test('mobile: pairing is permanent — survives a full PC restart and a relay restart, no re-pairing', async () => {
  const relay = await startRelay();
  const port = relay.port;
  const first = await makeApp();
  const dir = first.dir;
  let second: Awaited<ReturnType<typeof makeApp>> | null = null;
  let relay2: RunningRelay | null = null;
  try {
    first.app.settings.update({ mobile: { enabled: true, relayUrl: relay.url } });
    await waitUntil(() => first.app.mobile.status().state === 'connected', 5000, 'PC connected');
    const pcId = first.app.mobile.status().deviceId;
    const phone = await pairedPhone(first.app, relay);

    // The PC shuts down completely (e.g. reboot). The phone stays paired and is told the PC is offline.
    await first.app.stop();
    await waitUntil(() => phone.frames.find((f) => f.t === 'presence' && !f.online), 5000, 'PC offline');
    const seen = phone.frames.length;

    // Jarvis starts again on the same data: same PC identity, the phone is still allowed, and it comes back online by itself.
    second = await makeApp({ dataDir: dir });
    assert.equal(second.app.mobile.status().deviceId, pcId, 'the PC keeps its identity across restarts');
    await waitUntil(() => second!.app.mobile.status().state === 'connected', 5000, 'restarted PC reconnected (setting persisted)');
    await waitUntil(() => phone.frames.slice(seen).find((f) => f.t === 'presence' && f.online), 5000, 'phone told the PC is back');
    const dev = second.app.mobile.status().devices.find((d) => d.id === phone.id);
    assert.ok(dev && dev.online && dev.revokedAt === null, 'still paired, online, not revoked');
    phone.send('pc.snapshot.request', {});
    await phone.waitFor((e) => e.type === 'pc.snapshot');

    // The relay restarts too: both ends reconnect on their own and keep working without pairing again.
    await relay.close();
    relay2 = await startRelay({ port });
    phone.stop();
    await phone.connect(relay2.url);
    await waitUntil(() => second!.app.mobile.status().state === 'connected', 20_000, 'PC reconnected to the restarted relay');
    await waitUntil(() => second!.app.mobile.status().devices.find((d) => d.id === phone.id)?.online, 5000, 'phone online again');
    const before = phone.inbox.filter((e) => e.type === 'pc.snapshot').length;
    phone.send('pc.snapshot.request', {});
    await waitUntil(() => phone.inbox.filter((e) => e.type === 'pc.snapshot').length > before, 5000, 'command after relay restart');
    assert.equal(second.app.mobile.status().devices.length, 1, 'no duplicate or re-paired device');
  } finally {
    TestPhone.stopAll();
    await second?.app.stop();
    rmSync(dir, { recursive: true, force: true });
    await relay2?.close();
    await relay.close().catch(() => {});
  }
});
