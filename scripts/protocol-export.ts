/**
 * Generate the Jarvis Mobile contract artifacts from shared/protocol/protocol.ts:
 *   shared/protocol/jarvis-protocol.schema.json   JSON Schema of frames, envelope and every payload
 *   shared/protocol/fixtures/envelopes.json        one valid envelope per message type
 *   shared/protocol/fixtures/crypto-vectors.json   fixed-key vectors (ECDSA, ECDH+HKDF, AES-GCM)
 * The Android contract tests decode/verify all of them; tests/protocol-contract.test.ts fails if
 * these files are out of date.   node scripts/protocol-export.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AGENT_CATALOG, EnvelopeBase, MESSAGE_TYPES, Payloads, PROTOCOL_VERSION, RelayFrame, REQUIRED_SCOPE, IDEMPOTENT_TYPES } from '../shared/protocol/protocol.ts';
import { deviceIdOf, messageKey, msgAad, pairAad, pairingKey, relayAuthMessage, seal } from '../shared/protocol/crypto.ts';

const dir = join(import.meta.dirname, '..', 'shared', 'protocol');

// Fixed TEST-ONLY keys (never used for anything real): P-256, PKCS#8 / SPKI DER base64.
const PC = {
  signPriv: 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgKGWh3XLOo41iBdDmPrd+zTpFEcyF4RlkeaTKYrLZsr+hRANCAAQd/gmRyn/xAxpwvboPPb8Dim7MJYzJ7eFGdLuzV/Ibaq2NWZZ2kLd1WFBIZn4PYZCa911AGdQb5cRYIrgIp1DA',
  signPub: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHf4Jkcp/8QMacL26Dz2/A4puzCWMye3hRnS7s1fyG2qtjVmWdpC3dVhQSGZ+D2GQmvddQBnUG+XEWCK4CKdQwA==',
  agreePriv: 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgifMacbhY/8QVIcHHo8mOWLNeCkvI75eg6g8y+xM7OyqhRANCAASj9KBrCKqpTvOn6QDojFTisPYOei7azDbFN/pL9tGkFhnH/DPsDOJqZt87lQiRZlH0EAhf4xIc07eRicHJ93Dl',
  agreePub: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEo/SgawiqqU7zp+kA6IxU4rD2Dnou2sw2xTf6S/bRpBYZx/wz7AziambfO5UIkWZR9BAIX+MSHNO3kYnByfdw5Q==',
};
const PHONE = {
  signPriv: 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg7K5+ecWe2T5HflPhfvxsedXnsYq5QR2fVOki8cQVR36hRANCAARFsY97vUdsg2a41N4gK1nWefDSzP9SNRM2fCrleDUKl446dfjSrbZCR9ZCX81ZjKElfI6UYCGYQAsDA8JGKERJ',
  signPub: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERbGPe71HbINmuNTeICtZ1nnw0sz/UjUTNnwq5Xg1CpeOOnX40q22QkfWQl/NWYyhJXyOlGAhmEALAwPCRihESQ==',
  agreePriv: 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgs3eOHFvdER0/FqYu81kJlATAv9zdpGw/NWzb0V7dqRChRANCAASFoyg90dXUjPtXPYWpUSj2mwKGEH2cHbtAj8jBGohIfofi9tOFjtfY5Yali+QJYv/4iIFKEMSE/GgVg6dLB262',
  agreePub: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhaMoPdHV1Iz7Vz2FqVEo9psChhB9nB27QI/IwRqISH6H4vbThY7X2OWGpYvkCWL/+IiBShDEhPxoFYOnSwdutg==',
};

function build(): Record<string, string> {
  const pcId = deviceIdOf(PC.signPub);
  const phoneId = deviceIdOf(PHONE.signPub);
  const ts = 1_795_000_000_000;
  const sample: Record<string, unknown> = {
    'device.pair.request': { deviceName: 'Pixel 9', platform: 'android', appVersion: '0.1.0', pubSign: PHONE.signPub, pubAgree: PHONE.agreePub },
    'device.pair.confirm': { pcDeviceId: pcId, pcName: "Mo's PC Jarvis", pubSign: PC.signPub, pubAgree: PC.agreePub, scopes: ['observe', 'command', 'approve', 'stop'], jarvisVersion: '1.0.0' },
    'device.pair.reject': { reason: 'Device identity does not match its key' },
    'device.status': { online: true, name: "Mo's PC Jarvis", jarvisVersion: '1.0.0', brain: 'qwen3:4b', scopes: ['observe', 'command'] },
    'device.revoke': { reason: 'Revoked on the PC' },
    'pc.snapshot.request': {},
    'pc.snapshot': {
      agents: [{ id: 'neo', name: 'Neo', color: '#15803d', role: 'Monitor — watches tasks.', state: 'idle', lastRunAt: ts, lastSummary: 'Watching 0 task(s)', runs: 3, error: null }],
      agentsEnabled: true,
      tasks: [{ id: 'tsk_abc12345', title: 'Run: echo hi', status: 'running', progress: 0.5, createdAt: ts, updatedAt: ts, error: null, result: null }],
      approvals: [{ id: 'apr_abc12345', taskId: 'tsk_abc12345', taskTitle: 'Housekeeping', summary: 'Run command: echo unrequested', reason: 'Nobody asked for this task directly.', scope: 'shell.execute', createdAt: ts }],
      assistantState: 'idle',
      assistantDetail: 'Ready',
    },
    'jarvis.command.submit': { text: 'remind me in 10 minutes to stretch', conversationId: null, via: 'text' },
    'jarvis.command.accepted': { conversationId: null },
    'jarvis.command.rejected': { code: 'unauthorized', reason: 'This phone is not allowed to command' },
    'jarvis.response.delta': { text: 'Partial' },
    'jarvis.response.complete': { conversationId: 'cnv_abc12345', text: 'Queued task “Stretch”.', handledBy: 'rules', actions: [{ type: 'task_created', title: 'Stretch', taskId: 'tsk_abc12345', needsApproval: false }], error: null },
    'agent.status.changed': { agents: [{ id: 'echo', name: 'Echo', color: '#a855f7', role: 'Reporter', state: 'working', lastRunAt: null, lastSummary: '', runs: 0, error: null }], agentsEnabled: true },
    'agent.run': { agentId: 'trinity' },
    'task.created': { task: { id: 'tsk_abc12345', title: 'Stretch', status: 'queued', progress: 0, createdAt: ts, updatedAt: ts, error: null, result: null } },
    'task.progress': { task: { id: 'tsk_abc12345', title: 'Stretch', status: 'running', progress: 0.5, createdAt: ts, updatedAt: ts, error: null, result: null } },
    'task.completed': { task: { id: 'tsk_abc12345', title: 'Stretch', status: 'completed', progress: 1, createdAt: ts, updatedAt: ts, error: null, result: 'Done' } },
    'task.failed': { task: { id: 'tsk_abc12345', title: 'Stretch', status: 'failed', progress: 0.2, createdAt: ts, updatedAt: ts, error: 'Timed out', result: null } },
    'task.cancel': { taskId: 'tsk_abc12345' },
    'approval.requested': { approval: { id: 'apr_abc12345', taskId: 'tsk_abc12345', taskTitle: 'Housekeeping', summary: 'Run command', reason: null, scope: 'shell.execute', createdAt: ts } },
    'approval.resolve': { approvalId: 'apr_abc12345', decision: 'approve' },
    'approval.resolved': { approvalId: 'apr_abc12345', status: 'approved' },
    'voice.session.started': { via: 'phone_stt' },
    'voice.transcript': { text: 'what is on my list today', conversationId: null, final: true },
    'system.emergency_stop': { reason: 'Pressed STOP on the phone' },
    'system.stopped': { cancelledTasks: 2, computerAccessStopped: true },
    'connection.heartbeat': { seq: 7 },
    error: { code: 'failed', message: 'Something went wrong' },
  };
  const envelopes = MESSAGE_TYPES.map((type, i) => {
    const fromPhone = REQUIRED_SCOPE[type] !== undefined || type.startsWith('device.pair.request');
    const env: Record<string, unknown> = { v: PROTOCOL_VERSION, id: `fx_${String(i).padStart(8, '0')}`, sessionId: 'ses_fixture01', from: fromPhone ? phoneId : pcId, to: fromPhone ? pcId : phoneId, ts, type, payload: sample[type] };
    if (IDEMPOTENT_TYPES.has(type)) env.idempotencyKey = `idem_${String(i).padStart(8, '0')}`;
    if (!fromPhone) env.correlationId = 'fx_00000000';
    // validate every fixture against the real schema
    EnvelopeBase.parse(env);
    Payloads[type].parse(env.payload);
    return env;
  });

  const key = messageKey(PHONE.agreePriv, PC.agreePub, phoneId, pcId);
  const nonce = Buffer.from('000102030405060708090a0b', 'hex');
  const plaintext = JSON.stringify(envelopes.find((e) => e.type === 'jarvis.command.submit'));
  const pairSecret = Buffer.alloc(32, 0x5a).toString('base64');
  const room = 'roomFixture1234567';
  const vectors = {
    note: 'TEST-ONLY keys. Shared by Node and the Android client to keep the crypto identical.',
    pc: { ...PC, deviceId: pcId },
    phone: { ...PHONE, deviceId: phoneId },
    relayAuth: { nonce: 'bm9uY2UtZml4dHVyZQ', message: relayAuthMessage('bm9uY2UtZml4dHVyZQ', phoneId).toString('utf8') },
    messageKeyPhoneToPc: key.toString('hex'),
    messageKeyPcToPhone: messageKey(PC.agreePriv, PHONE.agreePub, pcId, phoneId).toString('hex'),
    sealed: { nonceHex: nonce.toString('hex'), aad: msgAad(phoneId, pcId).toString('utf8'), plaintext, sealedB64: seal(key, plaintext, msgAad(phoneId, pcId), nonce) },
    pairing: { secretB64: pairSecret, room, keyHex: pairingKey(pairSecret, room).toString('hex'), aad: pairAad(room, phoneId).toString('utf8') },
  };

  const schema = {
    $comment: 'Generated from shared/protocol/protocol.ts — do not edit. node scripts/protocol-export.ts',
    version: PROTOCOL_VERSION,
    relayFrame: z.toJSONSchema(RelayFrame),
    envelope: z.toJSONSchema(EnvelopeBase),
    payloads: Object.fromEntries(MESSAGE_TYPES.map((t) => [t, z.toJSONSchema(Payloads[t])])),
    requiredScope: REQUIRED_SCOPE,
    idempotentTypes: [...IDEMPOTENT_TYPES],
    agents: AGENT_CATALOG,
  };
  return {
    'jarvis-protocol.schema.json': JSON.stringify(schema, null, 2) + '\n',
    'fixtures/envelopes.json': JSON.stringify(envelopes, null, 2) + '\n',
    'fixtures/crypto-vectors.json': JSON.stringify(vectors, null, 2) + '\n',
  };
}

const files = build();
const check = process.argv.includes('--check');
let stale = 0;
for (const [rel, content] of Object.entries(files)) {
  const path = join(dir, rel);
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    /* missing */
  }
  if (current === content) continue;
  stale++;
  if (!check) writeFileSync(path, content);
  console.log(`${check ? 'STALE' : 'wrote'} shared/protocol/${rel}`);
}
if (check && stale) process.exit(1);
