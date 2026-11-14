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
  if (!res.ok) throw new ApiError(json?.error ?? `Request failed (${res.status})`, res.status);
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
  eventsUrl: () => `/api/events?token=${encodeURIComponent(token)}`,
  hasToken: () => token.length > 0,
};

// ---------------------------------------------------------------- shared types (mirror the server)

export type AssistantState = 'idle' | 'thinking' | 'working' | 'success' | 'error';
export type DragonState = AssistantState | 'listening' | 'speaking';

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

export interface ProviderStatus {
  id: string;
  name: string;
  type: 'anthropic' | 'openai-compatible';
  model: string;
  baseUrl: string;
  enabled: boolean;
  requiresKey: boolean;
  keyConfigured: boolean;
  keySource: 'stored' | 'environment' | null;
  usable: boolean;
  role: 'primary' | 'fallback' | 'unused';
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

export interface Integrations {
  providers: ProviderStatus[];
  embeddings: {
    enabled: boolean;
    providerId: string;
    model: string;
    active: boolean;
    memoriesEmbedded: number;
    builtin: { state: 'not_downloaded' | 'downloading' | 'ready' | 'error'; error: string | null; sizeBytes: number };
  };
  mcp: McpStatus[];
  workspace: { path: string; exists: boolean; writable: boolean; readPolicy: string; writePolicy: string };
  web: { policy: string; allowPrivateNetwork: boolean };
  shell: { enabled: boolean; policy: string };
  transcription: { providerId: string; model: string; available: boolean };
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
    providers: Array<{ id: string; type: 'anthropic' | 'openai-compatible'; name: string; baseUrl: string; model: string; enabled: boolean; requiresKey: boolean }>;
    primary: string;
    fallbackOrder: string[];
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    serverSideFallback: boolean;
    maxToolIterations: number;
    requestTimeoutSec: number;
  };
  embeddings: { enabled: boolean; providerId: string; model: string };
  memory: { autoExtract: boolean; contextMessages: number; retrievalLimit: number; conversationRetentionDays: number; summarizeConversations: boolean };
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
  permissions: { policies: Record<string, 'allow' | 'ask' | 'deny'> };
  voice: {
    enabled: boolean;
    autoSpeak: boolean;
    voiceName: string;
    rate: number;
    pitch: number;
    lang: string;
    wakeWord: boolean;
    inputMode: 'auto' | 'browser' | 'transcription';
    transcription: { providerId: string; model: string };
  };
  notifications: { desktop: boolean; taskCompletion: boolean };
  appearance: { reduceMotion: boolean; accent: 'violet' | 'indigo' | 'fuchsia' };
  integrations: { workspaceDir: string; web: { allowPrivateNetwork: boolean; maxBytes: number }; shell: { enabled: boolean } };
}
