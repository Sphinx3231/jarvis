import { z } from 'zod';
import type { Database } from '../db/database.ts';
import type { EventBus } from './events.ts';
import { now, parseJson, UserError } from './util.ts';

export const PolicySchema = z.enum(['allow', 'ask', 'deny']);
export type Policy = z.infer<typeof PolicySchema>;

export const ProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  type: z.enum(['anthropic', 'openai-compatible']),
  name: z.string().min(1).max(60),
  baseUrl: z.string().url().or(z.literal('')).default(''),
  model: z.string().min(1).max(120),
  enabled: z.boolean().default(false),
  /** Whether this provider needs an API key (local servers such as Ollama do not). */
  requiresKey: z.boolean().default(true),
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

export const McpServerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  name: z.string().min(1).max(60),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).max(50).default([]),
  /** Non-secret environment variables. Secrets go through the secret store (mcp:<id>:env:<NAME>). */
  env: z.record(z.string(), z.string().max(2000)).default({}),
  secretEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  enabled: z.boolean().default(true),
});
export type McpServerConfig = z.infer<typeof McpServerSchema>;

export const SettingsSchema = z.object({
  assistant: z.object({
    userName: z.string().max(60).default(''),
  }),
  llm: z.object({
    providers: z.array(ProviderSchema).max(10),
    primary: z.string(),
    fallbackOrder: z.array(z.string()).max(10),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    serverSideFallback: z.boolean(),
    maxToolIterations: z.number().int().min(1).max(12),
    requestTimeoutSec: z.number().int().min(10).max(900),
  }),
  embeddings: z.object({
    enabled: z.boolean(),
    providerId: z.string(),
    model: z.string().min(1).max(120),
  }),
  memory: z.object({
    autoExtract: z.boolean(),
    contextMessages: z.number().int().min(2).max(100),
    retrievalLimit: z.number().int().min(0).max(30),
    conversationRetentionDays: z.number().int().min(1).max(3650),
    summarizeConversations: z.boolean(),
  }),
  background: z.object({
    enabled: z.boolean(),
    monitorIntervalSec: z.number().int().min(5).max(3600),
    maintenanceIntervalMin: z.number().int().min(1).max(1440),
    healthIntervalMin: z.number().int().min(1).max(1440),
    maxConcurrentTasks: z.number().int().min(1).max(8),
    stalledAfterSec: z.number().int().min(30).max(86400),
    approvalReminderMin: z.number().int().min(1).max(10080),
  }),
  tasks: z.object({
    stepTimeoutSec: z.number().int().min(5).max(3600),
    maxAttempts: z.number().int().min(1).max(5),
  }),
  permissions: z.object({
    policies: z.record(z.string(), PolicySchema),
  }),
  voice: z.object({
    enabled: z.boolean(),
    autoSpeak: z.boolean(),
    voiceName: z.string().max(200),
    rate: z.number().min(0.5).max(2),
    pitch: z.number().min(0).max(2),
    lang: z.string().max(20),
    wakeWord: z.boolean(),
    /** auto: browser speech recognition where it works, otherwise recorded audio + transcription. */
    inputMode: z.enum(['auto', 'browser', 'transcription']),
    transcription: z.object({
      providerId: z.string(),
      model: z.string().min(1).max(120),
    }),
  }),
  notifications: z.object({
    desktop: z.boolean(),
    taskCompletion: z.boolean(),
  }),
  appearance: z.object({
    reduceMotion: z.boolean(),
    accent: z.enum(['violet', 'indigo', 'fuchsia']),
  }),
  integrations: z.object({
    workspaceDir: z.string().max(1000),
    web: z.object({
      allowPrivateNetwork: z.boolean(),
      maxBytes: z.number().int().min(10_000).max(10_000_000),
    }),
    shell: z.object({
      enabled: z.boolean(),
    }),
    mcpServers: z.array(McpServerSchema).max(20),
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  assistant: { userName: '' },
  llm: {
    providers: [
      { id: 'anthropic', type: 'anthropic', name: 'Anthropic Claude', baseUrl: '', model: 'claude-opus-5-5', enabled: true, requiresKey: true },
      { id: 'openai', type: 'openai-compatible', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', enabled: false, requiresKey: true },
      { id: 'ollama', type: 'openai-compatible', name: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', enabled: false, requiresKey: false },
    ],
    primary: 'anthropic',
    fallbackOrder: ['openai', 'ollama'],
    effort: 'medium',
    serverSideFallback: true,
    maxToolIterations: 6,
    requestTimeoutSec: 180,
  },
  embeddings: { enabled: true, providerId: 'builtin', model: 'nomic-embed-text' },
  memory: {
    autoExtract: true,
    contextMessages: 20,
    retrievalLimit: 6,
    conversationRetentionDays: 90,
    summarizeConversations: true,
  },
  background: {
    enabled: true,
    monitorIntervalSec: 30,
    maintenanceIntervalMin: 30,
    healthIntervalMin: 15,
    maxConcurrentTasks: 2,
    stalledAfterSec: 600,
    approvalReminderMin: 60,
  },
  tasks: { stepTimeoutSec: 120, maxAttempts: 2 },
  permissions: { policies: {} },
  voice: {
    enabled: true,
    autoSpeak: false,
    voiceName: '',
    rate: 1,
    pitch: 1,
    lang: 'en-US',
    wakeWord: false,
    inputMode: 'auto',
    transcription: { providerId: 'openai', model: 'whisper-1' },
  },
  notifications: { desktop: true, taskCompletion: true },
  appearance: { reduceMotion: false, accent: 'violet' },
  integrations: {
    workspaceDir: '',
    web: { allowPrivateNetwork: false, maxBytes: 2_000_000 },
    shell: { enabled: true },
    mcpServers: [],
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge where arrays and primitives from `patch` replace those in `base`. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // `policies` and `env` are open maps: merge keys rather than replacing the whole map.
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export class SettingsStore {
  private db: Database;
  private bus: EventBus;
  private cache: Settings | null = null;

  constructor(db: Database, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'settings'");
    const stored = parseJson<unknown>(row?.value, {});
    const merged = deepMerge(DEFAULT_SETTINGS, stored);
    const parsed = SettingsSchema.safeParse(merged);
    // If stored settings became invalid (e.g. after an upgrade), fall back to defaults per field.
    this.cache = parsed.success ? parsed.data : DEFAULT_SETTINGS;
    return this.cache;
  }

  update(patch: unknown): Settings {
    const merged = deepMerge(this.get(), patch);
    const parsed = SettingsSchema.safeParse(merged);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new UserError(`Invalid setting ${issue.path.join('.')}: ${issue.message}`);
    }
    const next = parsed.data;
    const ids = new Set(next.llm.providers.map((p) => p.id));
    if (ids.size !== next.llm.providers.length) throw new UserError('Provider ids must be unique');
    if (!ids.has(next.llm.primary)) throw new UserError(`Primary provider "${next.llm.primary}" does not exist`);
    const mcpIds = new Set(next.integrations.mcpServers.map((s) => s.id));
    if (mcpIds.size !== next.integrations.mcpServers.length) throw new UserError('MCP server ids must be unique');
    this.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES ('settings', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      JSON.stringify(next),
      now(),
    );
    this.cache = next;
    this.bus.emit('settings.changed', {});
    return next;
  }
}
