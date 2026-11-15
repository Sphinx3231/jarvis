import { z } from 'zod';
import type { Database } from '../db/database.ts';
import type { EventBus } from './events.ts';
import { now, parseJson, UserError } from './util.ts';

export const PolicySchema = z.enum(['allow', 'ask', 'deny']);
export type Policy = z.infer<typeof PolicySchema>;

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

const MailServerSchema = z.object({
  host: z.string().max(200),
  port: z.number().int().min(1).max(65535),
  /** tls = implicit TLS (993/465), starttls = upgrade (143/587), none = plain (local testing only). */
  security: z.enum(['tls', 'starttls', 'none']),
});

export const SettingsSchema = z.object({
  assistant: z.object({
    userName: z.string().max(60).default(''),
  }),
  /** Jarvis thinks with the Roamies engine: the provider, model and sign-ins chosen in Roamies. */
  llm: z.object({
    /** A different model from the same Roamies sign-ins; empty = the model picked in Roamies. */
    model: z.string().max(160),
    thinking: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']),
    /** Extra local model servers (OpenAI-compatible base URLs: LM Studio, llama.cpp, vLLM…). Ollama is found by itself. */
    localServers: z.array(z.string().url().regex(/^https?:\/\//)).max(8),
    maxToolIterations: z.number().int().min(1).max(12),
    requestTimeoutSec: z.number().int().min(10).max(900),
  }),
  /** Semantic memory search with the built-in local model. */
  embeddings: z.object({
    enabled: z.boolean(),
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
    /** Do what the user asked without asking again; anything not part of their request still needs approval. */
    followRequests: z.boolean(),
    /** FULL ACCESS: when on, Jarvis may use every capability — whole-disk files, any website, shell —
     *  with no sandbox and no approval prompts. Off by default; turn on only on a machine you trust it with. */
    fullAccess: z.boolean(),
  }),
  voice: z.object({
    enabled: z.boolean(),
    autoSpeak: z.boolean(),
    voiceName: z.string().max(200),
    rate: z.number().min(0.5).max(2),
    pitch: z.number().min(0).max(2),
    lang: z.string().max(20),
    wakeWord: z.boolean(),
    /** How Jarvis speaks: browser = the computer's built-in voice; fish = Fish Audio (needs a key). */
    tts: z.object({
      provider: z.enum(['browser', 'fish']),
      /** Fish Audio voice/reference id; empty = the account default. */
      voiceId: z.string().max(120),
    }),
    /** auto: browser speech recognition where it works, otherwise recorded audio + transcription. */
    inputMode: z.enum(['auto', 'browser', 'transcription']),
    /** openai = the OpenAI API key saved in Roamies; custom = a Whisper-compatible server (e.g. local). */
    transcription: z.object({
      service: z.enum(['none', 'openai', 'custom']),
      baseUrl: z.string().url().or(z.literal('')),
      model: z.string().min(1).max(120),
    }),
  }),
  notifications: z.object({
    desktop: z.boolean(),
    taskCompletion: z.boolean(),
  }),
  /** Jarvis's background sub-agents (Friday, Tom, Neo, Sentinel, Echo). */
  agents: z.object({
    enabled: z.boolean(),
    /** Your running cost so far (model/tools), so Friday can tell whether you're in profit. */
    spendUsd: z.number().min(0).max(1_000_000_000),
    /**
     * Offensive testing (Trinity): when on, Jarvis's security operator may send LIVE traffic with
     * its Kali tools against bug-bounty programs it has verified are in scope. Off by default — this
     * is the human authorization boundary the methodology requires, not a filter on the model. Also
     * needs full PC access (permissions.fullAccess) before any active step runs.
     */
    offensive: z.boolean(),
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
    email: z.object({
      enabled: z.boolean(),
      address: z.string().max(200),
      displayName: z.string().max(100),
      username: z.string().max(200),
      imap: MailServerSchema,
      smtp: MailServerSchema,
    }),
    obsidian: z.object({
      enabled: z.boolean(),
      /** Location of Jarvis's own vault; empty = ~/Documents/Jarvis Vault. */
      vaultPath: z.string().max(1000),
      include: z.object({
        manual: z.boolean(),
        memories: z.boolean(),
        tasks: z.boolean(),
        journal: z.boolean(),
        conversations: z.boolean(),
      }),
      intervalMin: z.number().int().min(1).max(1440),
    }),
    /** The autonomous bug-bounty pipeline. Read-only: tracks earnings and reports and discovers programs. */
    hackerone: z.object({
      enabled: z.boolean(),
      username: z.string().max(100),
      /** Keep discovering programs and refreshing earnings/reports for as long as this is on. */
      autoRun: z.boolean(),
      intervalMin: z.number().int().min(5).max(1440),
      /** Treat only programs that pay bounties as newly discovered opportunities. */
      bountyOnly: z.boolean(),
    }),
    calendar: z.object({
      caldav: z.object({
        enabled: z.boolean(),
        serverUrl: z.string().max(500),
        username: z.string().max(200),
      }),
      /** Read-only ICS subscriptions. URLs often contain private tokens, so they live in the secret store. */
      feeds: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().min(1).max(80) })).max(20),
    }),
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  assistant: { userName: '' },
  llm: {
    model: '',
    thinking: 'medium',
    localServers: [],
    maxToolIterations: 6,
    requestTimeoutSec: 180,
  },
  embeddings: { enabled: true },
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
  permissions: { policies: {}, followRequests: true, fullAccess: false },
  voice: {
    enabled: true,
    autoSpeak: false,
    voiceName: '',
    rate: 1,
    pitch: 1,
    lang: 'en-US',
    wakeWord: true,
    inputMode: 'auto',
    transcription: { service: 'openai', baseUrl: '', model: 'whisper-1' },
    tts: { provider: 'browser', voiceId: '' },
  },
  notifications: { desktop: true, taskCompletion: true },
  agents: { enabled: true, spendUsd: 0, offensive: false },
  appearance: { reduceMotion: false, accent: 'violet' },
  integrations: {
    workspaceDir: '',
    web: { allowPrivateNetwork: false, maxBytes: 2_000_000 },
    shell: { enabled: true },
    mcpServers: [],
    email: {
      enabled: false,
      address: '',
      displayName: '',
      username: '',
      imap: { host: '', port: 993, security: 'tls' },
      smtp: { host: '', port: 465, security: 'tls' },
    },
    obsidian: {
      enabled: true,
      vaultPath: '',
      include: { manual: true, memories: true, tasks: true, journal: true, conversations: true },
      intervalMin: 15,
    },
    hackerone: { enabled: false, username: '', autoRun: false, intervalMin: 30, bountyOnly: true },
    calendar: {
      caldav: { enabled: false, serverUrl: '', username: '' },
      feeds: [],
    },
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
