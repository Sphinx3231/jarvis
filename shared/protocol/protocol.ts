/**
 * Jarvis Mobile protocol, version 1 — the single source of truth.
 *
 * Two layers:
 *  1. RelayFrame: what the relay sees (routing + authentication). Plain JSON over TLS WebSocket.
 *  2. Envelope: the Jarvis message itself. Between paired devices it travels end-to-end encrypted
 *     inside a relay `msg` frame (AES-256-GCM, key from P-256 ECDH + HKDF), so the relay can route
 *     but never read it.
 *
 * The JSON Schema in jarvis-protocol.schema.json and the fixtures in fixtures/ are generated from
 * this file (`node scripts/protocol-export.ts`) and consumed by the Android client's contract tests.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
/** Hard ceiling for any frame or envelope (bytes of JSON). */
export const MAX_FRAME_BYTES = 256 * 1024;
/** Envelopes older/newer than this are rejected (replay window). */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const id = z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const deviceId = z.string().regex(/^[a-f0-9]{64}$/, 'device id = hex SHA-256 of the signing public key');
const b64 = z.string().max(16_384).regex(/^[A-Za-z0-9+/_=-]*$/);

// ---------------------------------------------------------------- relay frames (layer 1)

export const RelayFrame = z.discriminatedUnion('t', [
  // client → relay: who I am (signing key; the device id must equal sha256(SPKI DER)).
  z.object({ t: z.literal('hello'), v: z.literal(PROTOCOL_VERSION), role: z.enum(['pc', 'phone']), deviceId, pubSign: b64 }),
  // relay → client: prove it.
  z.object({ t: z.literal('challenge'), nonce: b64 }),
  // client → relay: ECDSA P-256/SHA-256 signature over "jarvis-relay-auth-v1|<nonce>|<deviceId>".
  z.object({ t: z.literal('auth'), sig: b64 }),
  z.object({ t: z.literal('ready'), deviceId }),
  // pc → relay: the phones allowed to talk to me (replaces the previous list).
  z.object({ t: z.literal('allow'), devices: z.array(deviceId).max(64) }),
  // pc → relay: open a one-time pairing room for at most 10 minutes.
  z.object({ t: z.literal('pair.open'), room: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), ttlMs: z.number().int().min(10_000).max(600_000) }),
  z.object({ t: z.literal('pair.close'), room: z.string().max(64) }),
  // phone → relay → pc (and pc → relay → phone): pairing payload, encrypted with the QR secret.
  z.object({ t: z.literal('pair.msg'), room: z.string().max(64), to: deviceId.optional(), from: deviceId.optional(), data: b64 }),
  // paired traffic: an encrypted Envelope.
  z.object({ t: z.literal('msg'), to: deviceId.optional(), from: deviceId.optional(), data: b64 }),
  z.object({ t: z.literal('presence'), deviceId, online: z.boolean() }),
  z.object({ t: z.literal('ping'), ts: z.number() }),
  z.object({ t: z.literal('pong'), ts: z.number() }),
  z.object({ t: z.literal('error'), code: z.enum(['bad_frame', 'auth_failed', 'not_authenticated', 'rate_limited', 'not_allowed', 'peer_offline', 'room_unknown', 'too_large', 'version']), message: z.string().max(300) }),
]);
export type RelayFrame = z.infer<typeof RelayFrame>;

// ---------------------------------------------------------------- shared data shapes

export const AgentId = z.enum(['friday', 'tom', 'neo', 'sentinel', 'echo', 'trinity']);
export type AgentId = z.infer<typeof AgentId>;

export const AgentStatus = z.object({
  id: AgentId,
  name: z.string().max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  role: z.string().max(400),
  state: z.enum(['idle', 'working']),
  lastRunAt: z.number().nullable(),
  lastSummary: z.string().max(1000),
  runs: z.number().int(),
  error: z.string().max(500).nullable(),
});

export const TaskSummary = z.object({
  id: z.string().max(64),
  title: z.string().max(300),
  status: z.enum(['queued', 'running', 'paused', 'awaiting_approval', 'completed', 'failed', 'cancelled']),
  progress: z.number().min(0).max(1),
  createdAt: z.number(),
  updatedAt: z.number(),
  error: z.string().max(1000).nullable(),
  result: z.string().max(4000).nullable(),
});

export const ApprovalSummary = z.object({
  id: z.string().max(64),
  taskId: z.string().max(64),
  taskTitle: z.string().max(300),
  summary: z.string().max(600),
  reason: z.string().max(600).nullable(),
  scope: z.string().max(80),
  createdAt: z.number(),
});

/** What a paired device may do on the PC. Granted at pairing, revocable on the PC. */
export const DeviceScope = z.enum(['observe', 'command', 'approve', 'stop']);
export type DeviceScope = z.infer<typeof DeviceScope>;

// ---------------------------------------------------------------- envelope payloads (layer 2)

export const Payloads = {
  'device.pair.request': z.object({ deviceName: z.string().min(1).max(80), platform: z.enum(['android']), appVersion: z.string().max(40), pubSign: b64, pubAgree: b64 }),
  'device.pair.confirm': z.object({ pcDeviceId: deviceId, pcName: z.string().max(80), pubSign: b64, pubAgree: b64, scopes: z.array(DeviceScope), jarvisVersion: z.string().max(40) }),
  'device.pair.reject': z.object({ reason: z.string().max(300) }),
  'device.status': z.object({ online: z.boolean(), name: z.string().max(80), jarvisVersion: z.string().max(40), brain: z.string().max(120).nullable(), scopes: z.array(DeviceScope) }),
  'device.revoke': z.object({ reason: z.string().max(300) }),
  'pc.snapshot.request': z.object({}),
  'pc.snapshot': z.object({ agents: z.array(AgentStatus).max(16), agentsEnabled: z.boolean(), tasks: z.array(TaskSummary).max(100), approvals: z.array(ApprovalSummary).max(100), assistantState: z.string().max(40), assistantDetail: z.string().max(300) }),
  'jarvis.command.submit': z.object({ text: z.string().min(1).max(20_000), conversationId: z.string().max(64).nullable(), via: z.enum(['text', 'voice']) }),
  'jarvis.command.accepted': z.object({ conversationId: z.string().max(64).nullable() }),
  'jarvis.command.rejected': z.object({ code: z.enum(['unauthorized', 'invalid', 'rate_limited', 'duplicate', 'unavailable']), reason: z.string().max(500) }),
  'jarvis.response.delta': z.object({ text: z.string().max(20_000) }),
  'jarvis.response.complete': z.object({
    conversationId: z.string().max(64),
    text: z.string().max(60_000),
    handledBy: z.string().max(20),
    actions: z.array(z.object({ type: z.string().max(40), title: z.string().max(300).optional(), taskId: z.string().max(64).optional(), needsApproval: z.boolean().optional() })).max(50),
    error: z.string().max(1000).nullable(),
  }),
  'agent.status.changed': z.object({ agents: z.array(AgentStatus).max(16), agentsEnabled: z.boolean() }),
  'agent.run': z.object({ agentId: AgentId }),
  'task.created': z.object({ task: TaskSummary }),
  'task.progress': z.object({ task: TaskSummary }),
  'task.completed': z.object({ task: TaskSummary }),
  'task.failed': z.object({ task: TaskSummary }),
  'task.cancel': z.object({ taskId: z.string().max(64) }),
  'approval.requested': z.object({ approval: ApprovalSummary }),
  'approval.resolve': z.object({ approvalId: z.string().max(64), decision: z.enum(['approve', 'deny']) }),
  'approval.resolved': z.object({ approvalId: z.string().max(64), status: z.enum(['approved', 'denied', 'expired', 'used']) }),
  'voice.session.started': z.object({ via: z.enum(['phone_stt']) }),
  'voice.transcript': z.object({ text: z.string().min(1).max(20_000), conversationId: z.string().max(64).nullable(), final: z.boolean() }),
  'system.emergency_stop': z.object({ reason: z.string().max(200) }),
  'system.stopped': z.object({ cancelledTasks: z.number().int(), computerAccessStopped: z.boolean() }),
  'connection.heartbeat': z.object({ seq: z.number().int() }),
  error: z.object({ code: z.string().max(40), message: z.string().max(500) }),
} as const;

export type MessageType = keyof typeof Payloads;
export const MESSAGE_TYPES = Object.keys(Payloads) as MessageType[];

export const EnvelopeBase = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id,
  sessionId: z.string().min(8).max(128),
  from: deviceId,
  to: deviceId,
  ts: z.number().int(),
  type: z.enum(MESSAGE_TYPES as [MessageType, ...MessageType[]]),
  correlationId: id.optional(),
  idempotencyKey: id.optional(),
  payload: z.unknown(),
});
export type Envelope<T extends MessageType = MessageType> = Omit<z.infer<typeof EnvelopeBase>, 'type' | 'payload'> & { type: T; payload: z.infer<(typeof Payloads)[T]> };

/** Commands that change something on the PC: they must carry an idempotency key. */
export const IDEMPOTENT_TYPES = new Set<MessageType>(['jarvis.command.submit', 'voice.transcript', 'task.cancel', 'approval.resolve', 'agent.run', 'system.emergency_stop']);

/** Which device scope each inbound (phone → PC) message needs. */
export const REQUIRED_SCOPE: Partial<Record<MessageType, DeviceScope>> = {
  'pc.snapshot.request': 'observe',
  'connection.heartbeat': 'observe',
  'jarvis.command.submit': 'command',
  'voice.transcript': 'command',
  'voice.session.started': 'command',
  'agent.run': 'command',
  'task.cancel': 'command',
  'approval.resolve': 'approve',
  'system.emergency_stop': 'stop',
};

/** Validate a decrypted envelope: version, shape, payload, size and freshness. Throws a ProtocolError. */
export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function parseEnvelope(json: string, now = Date.now()): Envelope {
  if (json.length > MAX_FRAME_BYTES) throw new ProtocolError('too_large', 'Envelope too large');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ProtocolError('bad_json', 'Envelope is not JSON');
  }
  if (raw && typeof raw === 'object' && 'v' in raw && (raw as { v: unknown }).v !== PROTOCOL_VERSION) throw new ProtocolError('version', `Unsupported protocol version ${(raw as { v: unknown }).v}`);
  const base = EnvelopeBase.safeParse(raw);
  if (!base.success) throw new ProtocolError('bad_envelope', base.error.issues[0]?.message ?? 'invalid envelope');
  const payload = Payloads[base.data.type].safeParse(base.data.payload);
  if (!payload.success) throw new ProtocolError('bad_payload', `${base.data.type}: ${payload.error.issues[0]?.path.join('.')} ${payload.error.issues[0]?.message}`);
  if (Math.abs(now - base.data.ts) > MAX_CLOCK_SKEW_MS) throw new ProtocolError('stale', 'Envelope timestamp outside the replay window');
  if (IDEMPOTENT_TYPES.has(base.data.type) && !base.data.idempotencyKey) throw new ProtocolError('no_idempotency_key', `${base.data.type} needs an idempotency key`);
  return { ...base.data, payload: payload.data } as Envelope;
}

export function parseRelayFrame(json: string): RelayFrame {
  if (json.length > MAX_FRAME_BYTES) throw new ProtocolError('too_large', 'Frame too large');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ProtocolError('bad_frame', 'Frame is not JSON');
  }
  const r = RelayFrame.safeParse(raw);
  if (!r.success) throw new ProtocolError('bad_frame', r.error.issues[0]?.message ?? 'invalid frame');
  return r.data;
}

// ---------------------------------------------------------------- shared agent catalogue

/**
 * The six Jarvis agents, as both runtimes represent them. `pc` lists what the PC implementation
 * does; `mobile` lists what the phone can genuinely do itself (empty = PC only).
 */
export const AGENT_CATALOG: Record<AgentId, { name: string; color: string; pc: string[]; mobile: string[] }> = {
  friday: { name: 'Friday', color: '#ef4444', pc: ['pipeline.earnings', 'profit.report'], mobile: [] },
  tom: { name: 'Tom', color: '#22d3ee', pc: ['pipeline.discover_programs'], mobile: [] },
  neo: { name: 'Neo', color: '#15803d', pc: ['tasks.watch', 'keys.audit'], mobile: ['mobile.tasks.watch'] },
  sentinel: { name: 'Sentinel', color: '#f59e0b', pc: ['scope.authorized_programs'], mobile: ['mobile.permissions.audit'] },
  echo: { name: 'Echo', color: '#a855f7', pc: ['team.digest'], mobile: ['mobile.activity.digest'] },
  trinity: { name: 'Trinity', color: '#f43f5e', pc: ['security.operator', 'security.plan'], mobile: [] },
};
