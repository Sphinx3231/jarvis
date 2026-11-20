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
  /**
   * Jarvis's brain. openjarvis (default) = OpenJarvis on this computer (local models, local voice, no
   * API keys, no usage limits); roamies = the Roamies engine (needs the Roamies app; sign-ins there).
   */
  brain: z.object({
    backend: z.enum(['openjarvis', 'roamies']),
    /** Where OpenJarvis's server runs (`jarvis serve`). This computer or the local network only. */
    openjarvisUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.(local|lan))(:\d+)?\/?$/i.test(u), 'must be this computer or your local network'),
    /** Model OpenJarvis should use (any local model you pulled, e.g. a DeepSeek); empty = OpenJarvis's default. */
    model: z.string().max(160),
    /**
     * The local engine OpenJarvis runs models on (Ollama). Jarvis asks it what the model can do (tools,
     * thinking) and talks to it directly when a reasoning model's answer would otherwise come back empty.
     */
    engineUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.(local|lan))(:\d+)?\/?$/i.test(u), 'must be this computer or your local network'),
    /**
     * openjarvis = through the OpenJarvis server (default). engine = straight to the local engine
     * (Ollama), skipping the OpenJarvis server (~500 MB more RAM for the model); voice still runs locally.
     */
    via: z.enum(['openjarvis', 'engine']),
    /** native = the model's own tool calling; prompted = tools described in the prompt (models without tool support); auto = decide from the model. */
    toolMode: z.enum(['auto', 'native', 'prompted']),
    /** Never use a cloud model, cloud voice or cloud transcription — nothing billed, no usage limits. */
    localOnly: z.boolean(),
  }),
  /** Semantic memory search with the built-in local model. */
  embeddings: z.object({
    enabled: z.boolean(),
  }),
  memory: z.object({
    autoExtract: z.boolean(),
    contextMessages: z.number().int().min(2).max(100),
    retrievalLimit: z.number().int().min(0).max(30),
    /** 0 = keep every conversation forever (the default). */
    conversationRetentionDays: z.number().int().min(0).max(3650),
    summarizeConversations: z.boolean(),
    /**
     * Digest every conversation: once it has been quiet this many seconds, Jarvis summarises it to
     * itself (what was new, what was repeated), files each item under a category (rules, plans,
     * schedules, ideas, …) and writes it to the vault. 0 = only in the background job.
     */
    digestAfterSec: z.number().int().min(0).max(3600),
    /** How much of the standing knowledge (rules, preferences, plans, schedules) goes into every turn. */
    standingChars: z.number().int().min(0).max(20000),
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
  /**
   * COMPUTER ACCESS MODE: let Jarvis see — and, at higher levels, use — the computer it runs on
   * (processes, the active window, the screen, and later the mouse/keyboard). Off by default. When
   * off, no observation or control happens at all. This is a desktop-app capability; in the cloud it
   * is inert. Levels mirror the master brief: observe < interact < extended.
   */
  computerAccess: z.object({
    enabled: z.boolean(),
    /** observe = see only (telemetry/screen, no input); interact = mouse/keyboard/scroll; extended = open/manage apps, files and multi-step workflows. */
    level: z.enum(['observe', 'interact', 'extended']),
    /** Minutes to keep temporary screenshots before deletion (0 = delete as soon as they are used). */
    screenshotRetentionMin: z.number().int().min(0).max(1440),
    /** Loopback DevTools endpoint of the browser Jarvis operates (the user's Chromium-family browser). */
    browserEndpoint: z.string().max(200).refine((u) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(u), 'must be a loopback http://127.0.0.1:<port> endpoint'),
    /** Seconds between samples while watching/learning (event-driven change detection skips unchanged samples). */
    watchIntervalSec: z.number().min(1).max(120),
    /** Ask the user before critical actions (send, pay, delete, install, enter a password…). Off = Jarvis does them and logs them. */
    confirmCritical: z.boolean(),
  }),
  /** Jarvis Mobile: reach this PC from a paired Android phone through an end-to-end-encrypted relay. */
  mobile: z.object({
    enabled: z.boolean(),
    /** wss:// URL of the relay (ws:// only for loopback/private-network development). */
    relayUrl: z.string().max(300),
  }),
  voice: z.object({
    enabled: z.boolean(),
    autoSpeak: z.boolean(),
    voiceName: z.string().max(200),
    rate: z.number().min(0.5).max(2),
    pitch: z.number().min(0).max(2),
    lang: z.string().max(20),
    wakeWord: z.boolean(),
    /** How Jarvis speaks: local = Kokoro through OpenJarvis (offline); browser = the computer's built-in voice; fish = Fish Audio (cloud, needs a key). */
    tts: z.object({
      provider: z.enum(['local', 'browser', 'fish']),
      /** Kokoro voice (local, e.g. bm_george) or Fish Audio reference id; empty = the default. */
      voiceId: z.string().max(120),
    }),
    /**
     * Local listening/voice in on-demand worker processes that exit when idle, so their ~1 GB goes back
     * to the local model between conversations (onDemand off = use OpenJarvis's always-loaded speech).
     */
    local: z.object({
      onDemand: z.boolean(),
      /** Seconds without speech before a worker exits and frees its memory. */
      idleSec: z.number().int().min(15).max(3600),
      /** faster-whisper size: tiny/base/small/medium/large-v3 (bigger = more accurate, more RAM). */
      whisperModel: z.enum(['tiny', 'base', 'small', 'medium', 'large-v3']),
      /** Python with the speech packages; empty = the one the local setup installed. */
      python: z.string().max(500),
    }),
    /** auto: browser speech recognition where it works, otherwise recorded audio + transcription. */
    inputMode: z.enum(['auto', 'browser', 'transcription']),
    /** openai = the OpenAI API key saved in Roamies; custom = a Whisper-compatible server (e.g. local). */
    transcription: z.object({
      service: z.enum(['none', 'openjarvis', 'openai', 'custom']),
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
    /**
     * Autonomous report submission: when on — AND only with full access + offensive mode — Jarvis may
     * submit bug-bounty reports to in-scope programs on its own, without a per-report approval. The
     * in-scope gate still applies to every submission and fails closed. Off by default; this is the
     * switch that turns on "ship it without telling me".
     */
    autoSubmit: z.boolean(),
    /**
     * Autonomous hunting: the master "go" switch for the bug-bounty orchestrator. When on — with full
     * access + offensive mode — Jarvis runs the loop on its own (pick an in-scope program → test →
     * draft → with auto-submit, ship → next). Off by default.
     */
    autoHunt: z.boolean(),
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

/** The brain a fresh install starts with: OpenJarvis (fully local). */
export const BRAIN_DEFAULT: 'openjarvis' | 'roamies' = 'openjarvis';

/**
 * JARVIS_BRAIN=roamies (read when settings load, not at import) starts a fresh install on the Roamies
 * engine instead — for existing Roamies setups and the test suite's scripted model.
 */
function roamiesDefaults(): Partial<Settings> {
  return {
    brain: { backend: 'roamies', openjarvisUrl: 'http://127.0.0.1:8000', model: '', engineUrl: 'http://127.0.0.1:11434', via: 'openjarvis', toolMode: 'auto', localOnly: false },
    voice: { ...DEFAULT_SETTINGS.voice, transcription: { service: 'openai', baseUrl: '', model: 'whisper-1' }, tts: { provider: 'browser', voiceId: '' } },
  };
}

export function defaultSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  if (env.JARVIS_BRAIN === 'roamies') return deepMerge(DEFAULT_SETTINGS, roamiesDefaults());
  // The local setup's "-Engine" choice: go straight to the engine (no OpenJarvis server) from the start.
  if (env.JARVIS_BRAIN_VIA === 'engine') return deepMerge(DEFAULT_SETTINGS, { brain: { via: 'engine' } });
  return DEFAULT_SETTINGS;
}

export const DEFAULT_SETTINGS: Settings = {
  assistant: { userName: '' },
  llm: {
    model: '',
    thinking: 'medium',
    localServers: [],
    maxToolIterations: 6,
    requestTimeoutSec: 180,
  },
  // Off by default: the built-in embedding model costs ~200 MB that the local LLM can use instead;
  // memory search still works (keyword + full-text). Turn it on in Settings for semantic search.
  embeddings: { enabled: false },
  memory: {
    autoExtract: true,
    contextMessages: 20,
    retrievalLimit: 6,
    conversationRetentionDays: 0,
    summarizeConversations: true,
    digestAfterSec: 60,
    standingChars: 4000,
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
  brain: { backend: BRAIN_DEFAULT, openjarvisUrl: 'http://127.0.0.1:8000', model: '', engineUrl: 'http://127.0.0.1:11434', via: 'openjarvis', toolMode: 'auto', localOnly: true },
  computerAccess: { enabled: false, level: 'observe', screenshotRetentionMin: 0, browserEndpoint: 'http://127.0.0.1:9222', watchIntervalSec: 4, confirmCritical: true },
  mobile: { enabled: false, relayUrl: process.env.JARVIS_RELAY_URL ?? '' },
  voice: {
    enabled: true,
    autoSpeak: false,
    voiceName: '',
    rate: 1,
    pitch: 1,
    lang: 'en-US',
    wakeWord: true,
    inputMode: 'auto',
    transcription: { service: 'openjarvis', baseUrl: '', model: 'whisper-1' },
    tts: { provider: 'local', voiceId: 'bm_george' },
    local: { onDemand: true, idleSec: 120, whisperModel: 'small', python: '' },
  },
  notifications: { desktop: true, taskCompletion: true },
  agents: { enabled: true, spendUsd: 0, offensive: false, autoSubmit: false, autoHunt: false },
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
    const merged = deepMerge(defaultSettings(), stored);
    const parsed = SettingsSchema.safeParse(merged);
    // If stored settings became invalid (e.g. after an upgrade), fall back to defaults per field.
    this.cache = parsed.success ? parsed.data : defaultSettings();
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
