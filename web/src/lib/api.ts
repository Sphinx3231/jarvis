const token = document.querySelector<HTMLMetaElement>('meta[name="jarvis-token"]')?.content ?? '';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-jarvis-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // 423: Roamies went missing — the gate shows the "Roamies required" screen.
    if (res.status === 423) window.dispatchEvent(new Event('jarvis-locked'));
    throw new ApiError(json?.error ?? `Request failed (${res.status})`, res.status);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
  postAudio: async <T>(path: string, audio: Blob): Promise<T> => {
    const res = await fetch(path, { method: 'POST', headers: { 'x-jarvis-token': token, 'content-type': audio.type || 'audio/webm' }, body: audio });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(json?.error ?? `Request failed (${res.status})`, res.status);
    return json as T;
  },
  postBlob: async (path: string, body: unknown): Promise<Blob> => {
    const res = await fetch(path, { method: 'POST', headers: { 'x-jarvis-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new ApiError((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`, res.status);
    return res.blob();
  },
  eventsUrl: () => `/api/events?token=${encodeURIComponent(token)}`,
  hasToken: () => token.length > 0,
};

// ---------------------------------------------------------------- shared types (mirror the server)

export type AssistantState = 'idle' | 'thinking' | 'working' | 'success' | 'error';
export type CoreState = AssistantState | 'listening' | 'speaking';

export interface StateSnapshot {
  state: AssistantState;
  detail: string;
  since: number;
}

export type TaskStatus = 'queued' | 'running' | 'paused' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface PlanStep {
  skill: string;
  input: Record<string, unknown>;
  description: string;
  agent: string;
  status: 'pending' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'skipped' | 'uncertain';
  attempts: number;
  output?: unknown;
  outputText?: string;
  untrusted?: boolean;
  verification?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: TaskStatus;
  origin: string;
  agent: string | null;
  plan: PlanStep[] | null;
  currentStep: number;
  progress: number;
  result: { summary: string; verified: boolean; completedSteps: number } | null;
  error: string | null;
  attention: string | null;
  requiredPermissions: string[];
  scheduledFor: number | null;
  recurrence: { everyMinutes?: number; dailyAt?: string } | null;
  /** Which harness runs it: Jarvis's own planner, or Hermes Agent's loop (every step still run by Jarvis). */
  harness: 'native' | 'hermes';
  /** Agent identity responsible (null = Jarvis). */
  owner: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface TaskEvent {
  id: number;
  ts: number;
  type: string;
  message: string;
}

export interface Approval {
  id: string;
  taskId: string;
  taskTitle?: string;
  stepIndex: number;
  skill: string;
  input: unknown;
  summary: string;
  scope: string;
  status: string;
  createdAt: number;
  /** Why it needs your approval, e.g. it is not part of what you asked for. */
  reason: string | null;
  decidedBy: 'user' | 'request' | null;
}

export interface Memory {
  id: string;
  kind: string;
  content: string;
  tags: string[];
  source: string;
  sourceRef: string | null;
  sources: string[];
  confidence: number;
  verified: boolean;
  mergedCount: number;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  updatedAt: number;
  hasEmbedding: boolean;
}

export interface MemoryStats {
  total: number;
  unverified: number;
  embedded: number;
  byKind: Record<string, number>;
}

export interface SkillInfo {
  name: string;
  title: string;
  description: string;
  category: string;
  scope: string;
  scopeLabel: string;
  policy: 'allow' | 'ask' | 'deny';
  risk: 'internal' | 'read' | 'write' | 'consequential';
  idempotent: boolean;
  inlineSafe: boolean;
  untrustedOutput: boolean;
  dependsOn: string | null;
  available: boolean;
  unavailableReason: string | null;
  inputSchema: { properties?: Record<string, { type?: string; description?: string; enum?: string[] }>; required?: string[] };
  outputDescription: string;
}

export interface Insight {
  id: string;
  level: 'info' | 'warning' | 'error';
  text: string;
  page: string;
}

export interface Status {
  version: string;
  startedAt: number;
  uptimeSec: number;
  process: { rssBytes: number; heapUsedBytes: number };
  host: { platform: string; cpus: number; totalMemBytes: number; freeMemBytes: number; loadAvg: number };
  tasks: Record<TaskStatus, number>;
  runningNow: number;
  approvalsPending: number;
  memory: MemoryStats;
  model: { provider: string; model: string; healthy: boolean | null } | null;
  skills: { total: number; available: number };
  background: { enabled: boolean };
  dbSizeBytes: number;
}

export interface StatusResponse {
  status: Status;
  state: StateSnapshot;
  insights: Insight[];
  unreadNotifications: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  meta: { actions?: ChatAction[]; via?: string; error?: string; handledBy?: string };
  createdAt: number;
}

export type ChatAction =
  | { type: 'task_created'; taskId: string; title: string; needsApproval: string[]; scheduledFor: number | null; deduplicated: boolean }
  | { type: 'memory_saved'; memoryId: string; verified: boolean; merged: boolean }
  | { type: 'task_control'; taskId: string; action: string }
  | { type: 'tool_used'; skill: string; ok: boolean };

export interface ChatResult {
  conversationId: string;
  userMessage: ChatMessage;
  reply: ChatMessage;
  actions: ChatAction[];
  handledBy: string;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
}

export interface ActivityEntry {
  id: number;
  ts: number;
  level: 'info' | 'success' | 'warning' | 'error';
  category: string;
  message: string;
}

export interface NotificationEntry {
  id: string;
  ts: number;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  taskId: string | null;
  read: boolean;
}

export interface RoamiesDetection {
  installed: boolean;
  path: string | null;
  how: string | null;
  version: string | null;
  ggDir: string;
  configPath: string;
  configured: boolean;
  checkedAt: number;
  searched: string[];
}

export interface RoamiesRequirement {
  met: boolean;
  running: boolean;
  downloadUrl: string;
  detection: RoamiesDetection;
}

export interface LocalServerStatus {
  id: string;
  label: string;
  baseUrl: string;
  kind: 'ollama' | 'custom';
  reachable: boolean;
  reason: string | null;
  models: Array<{ id: string; name: string; tools: boolean; thinking: boolean; contextWindow: number; contextKnown: boolean }>;
}

/** The Roamies engine: the model and sign-ins chosen in Roamies. */
export interface EngineStatus {
  ready: boolean;
  provider: { id: string; name: string } | null;
  model: { id: string; name: string } | null;
  source: 'roamies' | 'jarvis' | 'auto' | 'openjarvis' | null;
  route: 'api' | 'claude-code' | null;
  backend: 'openjarvis' | 'roamies';
  localOnly: boolean;
  capabilities: { tools: boolean; thinking: boolean; vision: boolean; contextLength: number | null; family: string | null; parameterSize: string | null } | null;
  toolMode: 'native' | 'prompted' | null;
  openjarvis: { reachable: boolean; detail: string; models: Array<{ id: string; ownedBy: string | null }>; speech: { available: boolean; detail: string } | null; tts: { available: boolean; detail: string; voiceId: string | null } | null } | null;
  signedIn: Array<{ id: string; name: string; claude?: boolean }>;
  models: Array<{ id: string; name: string; provider: string; tools: boolean }>;
  tools: boolean;
  local: LocalServerStatus[];
  warning: string | null;
  problem: string | null;
  configPath: string;
  look: string | null;
  health: { ok: boolean; detail: string; checkedAt: number } | null;
  lastError: string | null;
  lastUsedAt: number | null;
}

export interface McpStatus {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  state: 'disabled' | 'connecting' | 'connected' | 'error';
  error: string | null;
  serverInfo: { name?: string; version?: string };
  tools: Array<{ name: string; skill: string; description: string; readOnly: boolean }>;
  secretEnv: Array<{ name: string; configured: boolean }>;
  connectedAt: number | null;
}

export interface AgentInfo {
  id: string;
  name: string;
  color: string;
  role: string;
  state: 'idle' | 'working';
  lastRunAt: number | null;
  lastSummary: string;
  runs: number;
  error: string | null;
  /** A Hermes task this agent owns that is running right now (its background job is separate). */
  task?: { id: string; title: string; phase: HarnessPhase; tool: string | null; harness: 'native' | 'hermes' } | null;
}
export type HarnessPhase = 'starting' | 'thinking' | 'tool' | 'awaiting_approval';
export interface HarnessStatus {
  available: boolean;
  mode: 'auto' | 'off';
  installed: boolean;
  reason: string | null;
  python: string | null;
  release: string | null;
  commit: string | null;
  model: string | null;
  contextWindow: number | null;
  contextSource: 'provider' | 'setting' | null;
}
export interface HarnessResponse {
  harness: HarnessStatus;
  settings: { mode: 'auto' | 'off'; python: string; contextLength: number; maxIterations: number; timeoutMin: number };
  activity: Array<{ taskId: string; owner: string; phase: HarnessPhase; tool: string | null; at: number; title: string }>;
}
/** What a Hermes run is doing, in words. */
export function harnessPhaseLabel(phase: HarnessPhase, tool: string | null): string {
  if (phase === 'awaiting_approval') return 'Awaiting approval';
  if (phase === 'tool') return tool ? `Using ${tool.replace(/^mcp\.[^.]+\./, '').replace(/[._]/g, ' ')}` : 'Using a tool';
  if (phase === 'starting') return 'Starting';
  return 'Thinking';
}
export interface AgentsResponse {
  agents: AgentInfo[];
  enabled: boolean;
  spendUsd: number;
}

export interface PipelineProgram {
  handle: string;
  name: string;
  currency: string | null;
  offersBounties: boolean;
  state: string | null;
  url: string;
  firstSeen: number;
  lastSeen: number;
  isNew: boolean;
}

export interface PipelineReport {
  id: string;
  title: string;
  state: string;
  program: string | null;
  severity: string | null;
  bounty: number | null;
  currency: string | null;
  createdAt: number | null;
}

/** The autonomous bug-bounty pipeline: earnings, reports and discovered programs. */
export interface PipelineSummary {
  connected: boolean;
  missing: string | null;
  enabled: boolean;
  autoRun: boolean;
  running: boolean;
  intervalMin: number;
  bountyOnly: boolean;
  username: string;
  tokenSet: boolean;
  lastCheck: { ok: boolean; detail: string; at: number } | null;
  earnings: { currency: string; total: number; count: number; last30d: number; averageBounty: number; monthly: Array<{ month: string; amount: number }> };
  reports: { total: number; byState: Record<string, number>; resolved: number; recent: PipelineReport[] };
  programs: { total: number; bountyPaying: number; newCount: number; discovered: PipelineProgram[] };
}

export interface Integrations {
  model: EngineStatus & { override: string; thinking: Settings['llm']['thinking'] };
  roamies: RoamiesDetection;
  embeddings: {
    enabled: boolean;
    active: boolean;
    memoriesEmbedded: number;
    builtin: { state: 'not_downloaded' | 'downloading' | 'ready' | 'error'; error: string | null; sizeBytes: number };
  };
  mcp: McpStatus[];
  workspace: { path: string; exists: boolean; writable: boolean; readPolicy: string; writePolicy: string };
  web: { policy: string; allowPrivateNetwork: boolean };
  shell: { enabled: boolean; policy: string };
  transcription: { service: 'none' | 'openjarvis' | 'openai' | 'custom'; baseUrl: string; model: string; keySet: boolean; available: boolean };
  tts: { provider: 'local' | 'browser' | 'fish'; voiceId: string; keySet: boolean; keyFromEnv: boolean; available: boolean; detail?: string };
  email: {
    enabled: boolean;
    address: string;
    displayName: string;
    username: string;
    imap: MailServer;
    smtp: MailServer;
    passwordSet: boolean;
    missing: string | null;
    lastCheck: { ok: boolean; detail: string; at: number } | null;
  };
  obsidian: {
    enabled: boolean;
    vaultPath: string;
    include: { manual: boolean; memories: boolean; tasks: boolean; journal: boolean; conversations: boolean };
    intervalMin: number;
    problem: string | null;
    location: string;
    isDefaultLocation: boolean;
    ready: boolean;
    openUri: string;
    trackedNotes: number;
    lastReport: { at: number; ok: boolean; written: number; unchanged: number; removed: number; keptUserEdits: string[]; imported: number; error: string | null; durationMs: number } | null;
  };
  hackerone: {
    enabled: boolean;
    username: string;
    autoRun: boolean;
    intervalMin: number;
    bountyOnly: boolean;
    tokenSet: boolean;
    missing: string | null;
    lastCheck: { ok: boolean; detail: string; at: number } | null;
  };
  calendar: {
    caldav: { enabled: boolean; serverUrl: string; username: string; passwordSet: boolean; missing: string | null };
    feeds: Array<{ id: string; name: string }>;
    lastCheck: { ok: boolean; detail: string; at: number } | null;
  };
}

export interface MailServer {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
}

export interface Scope {
  id: string;
  label: string;
  description: string;
  external: boolean;
  defaultPolicy: 'allow' | 'ask' | 'deny';
  allowPermitted: boolean;
  policy: 'allow' | 'ask' | 'deny';
}

// ---------------------------------------------------------------- Computer Access Mode
export type CapabilityStatus = 'available' | 'limited' | 'needs-permission' | 'unverified' | 'unavailable';
export interface ComputerCapability {
  id: string;
  label: string;
  level: 'observe' | 'interact' | 'extended';
  status: CapabilityStatus;
  detail: string;
  requires?: string;
}
export interface ComputerStatus {
  platform: string;
  os: string;
  enabled: boolean;
  level: 'observe' | 'interact' | 'extended';
  display: { server: string; headless: boolean; detail: string };
  stoppedAt: number | null;
  capabilities: ComputerCapability[];
  live: ComputerLive;
}
export type ComputerState = 'IDLE' | 'OBSERVING' | 'ANALYZING' | 'PLANNING' | 'INTERACTING' | 'VERIFYING' | 'LEARNING' | 'WAITING_FOR_APPROVAL' | 'PAUSED' | 'COMPLETED' | 'ERROR';
export interface ComputerConfirmation {
  id: string;
  kind: string;
  summary: string;
  finding: { category: string; reason: string };
  createdAt: number;
  status: string;
}
export interface ComputerLive {
  state: ComputerState;
  task: string | null;
  detail: string | null;
  activeApp: string | null;
  learningSession: { id: string; course: string; lesson: string | null } | null;
  since: number;
  pendingConfirmations: ComputerConfirmation[];
}
export interface ComputerAction {
  id: number;
  ts: number;
  kind: string;
  target: string | null;
  detail: string;
  outcome: 'ok' | 'failed' | 'blocked' | 'needs_confirmation' | 'cancelled' | 'unverified';
  verified: boolean | null;
  critical: string | null;
  task: string | null;
  durationMs: number | null;
}
export interface LearningSession {
  id: string;
  course: string;
  courseSlug: string;
  source: 'browser' | 'screen';
  status: 'watching' | 'completed' | 'stopped' | 'blocked' | 'interrupted' | 'error';
  lastLesson: string | null;
  lastLessonNumber: number | null;
  lastUrl: string | null;
  lessonsSeen: number;
  notesStored: number;
  samples: number;
  gaps: string[];
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
}
export interface ComputerResponse {
  status: ComputerStatus;
  telemetry: { activeWindow?: { available: boolean; title: string | null; app: string | null; detail: string }; processes?: { total: number }; memory?: { usedPercent: number }; cpu?: { usagePercent: number | null } } | null;
  browser: { ok: boolean; detail: string; browser?: string } | null;
  browserBinary: string | null;
  recent: ComputerAction[];
  learning: LearningSession[];
}
export interface ComputerProbe {
  id: string;
  ok: boolean;
  detail: string;
}

export interface Grant {
  id: string;
  skill: string;
  description: string;
  createdAt: number;
  expiresAt: number | null;
  uses: number;
}

export interface JobStatus {
  name: string;
  title: string;
  description: string;
  intervalMs: number;
  running: boolean;
  paused: boolean;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastMessage: string | null;
  lastDurationMs: number | null;
  runCount: number;
  nextRunAt: number | null;
}

export interface Settings {
  assistant: { userName: string };
  llm: {
    /** Empty = the model picked in Roamies. */
    model: string;
    thinking: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    localServers: string[];
    maxToolIterations: number;
    requestTimeoutSec: number;
  };
  embeddings: { enabled: boolean };
  memory: { autoExtract: boolean; contextMessages: number; retrievalLimit: number; conversationRetentionDays: number; summarizeConversations: boolean; digestAfterSec: number; standingChars: number };
  background: {
    enabled: boolean;
    monitorIntervalSec: number;
    maintenanceIntervalMin: number;
    healthIntervalMin: number;
    maxConcurrentTasks: number;
    stalledAfterSec: number;
    approvalReminderMin: number;
  };
  tasks: { stepTimeoutSec: number; maxAttempts: number };
  permissions: { policies: Record<string, 'allow' | 'ask' | 'deny'>; followRequests: boolean; fullAccess: boolean };
  brain: { backend: 'openjarvis' | 'roamies'; openjarvisUrl: string; model: string; engineUrl: string; via: 'openjarvis' | 'engine'; toolMode: 'auto' | 'native' | 'prompted'; localOnly: boolean };
  mobile: { enabled: boolean; relayUrl: string };
  computerAccess: { enabled: boolean; level: 'observe' | 'interact' | 'extended'; screenshotRetentionMin: number; browserEndpoint: string; watchIntervalSec: number; confirmCritical: boolean };
  voice: {
    enabled: boolean;
    autoSpeak: boolean;
    voiceName: string;
    rate: number;
    pitch: number;
    lang: string;
    wakeWord: boolean;
    inputMode: 'auto' | 'browser' | 'transcription';
    transcription: { service: 'none' | 'openjarvis' | 'openai' | 'custom'; baseUrl: string; model: string };
    tts: { provider: 'local' | 'browser' | 'fish'; voiceId: string };
    local: { onDemand: boolean; idleSec: number; whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'; python: string };
  };
  notifications: { desktop: boolean; taskCompletion: boolean };
  harness: { mode: 'auto' | 'off'; python: string; contextLength: number; maxIterations: number; timeoutMin: number };
  agents: { enabled: boolean; spendUsd: number; offensive: boolean; autoSubmit: boolean; autoHunt: boolean };
  appearance: { reduceMotion: boolean; accent: 'violet' | 'indigo' | 'fuchsia' };
  integrations: { workspaceDir: string; web: { allowPrivateNetwork: boolean; maxBytes: number }; shell: { enabled: boolean }; hackerone: { enabled: boolean; username: string; autoRun: boolean; intervalMin: number; bountyOnly: boolean } };
}

// ---------------------------------------------------------------- Jarvis Mobile

export type MobileScope = 'observe' | 'command' | 'approve' | 'stop';

export interface MobileDevice {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
  scopes: MobileScope[];
  pairedAt: number;
  lastSeen: number | null;
  revokedAt: number | null;
  online: boolean;
}

export interface MobileStatus {
  enabled: boolean;
  relayUrl: string;
  relayProblem: string | null;
  state: 'idle' | 'connecting' | 'connected' | 'error';
  detail: string;
  deviceId: string;
  pairing: { expiresAt: number } | null;
  devices: MobileDevice[];
}
