import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentPart, Message, Provider, ThinkingLevel, Tool } from '@kenkaiiii/gg-ai';
import type { AgentTool } from '@kenkaiiii/gg-agent';
import type { LocalEndpoint, LocalEndpointProbe } from '@kenkaiiii/gg-core';
import { z } from 'zod';
import type { ActivityLog } from '../core/activity.ts';
import type { SecretStore } from '../core/secrets.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage } from '../core/util.ts';
import type { RoamiesGate } from '../roamies/gate.ts';
import type { ClaudeCodeAgentOptions } from './claudecode.mjs';
import { isCloudModel, ollamaCapabilities, OpenJarvisClient, type ModelCapabilities, type OpenJarvisHealth } from './openjarvis.ts';
import type { LocalModelManager } from './local-embeddings.ts';
import type { EmbeddingProvider, LlmMessage, LlmRequest, LlmResponse, StopReason, ToolSpec } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * Jarvis's model layer is the Roamies engine: the GG framework (gg-ai / gg-agent / gg-core), with the
 * provider and model the user picked in Roamies and the sign-ins Roamies saved in ~/.gg/auth.json.
 * When Roamies is signed in with Claude, Jarvis runs through Claude Code exactly as Roamies does.
 * Jarvis never shows, copies or stores those credentials; it asks gg-core for them per request.
 */

/**
 * The Roamies engine (GG framework) is loaded only when the Roamies brain is in use: with the local
 * OpenJarvis brain Jarvis never pays its memory (~50 MB, plus the Claude Agent SDK) — RAM that stays
 * free for the local model.
 */
type GgAi = typeof import('@kenkaiiii/gg-ai');
type GgCore = typeof import('@kenkaiiii/gg-core');
let ggAi: GgAi | null = null;
let ggCore: GgCore | null = null;
export async function loadRoamiesEngine(): Promise<void> {
  ggAi ??= await import('@kenkaiiii/gg-ai');
  ggCore ??= await import('@kenkaiiii/gg-core');
}
/** Whether the Roamies engine libraries are in memory (diagnostics / the lean-harness test). */
export function roamiesEngineLoaded(): boolean {
  return ggAi !== null || ggCore !== null;
}
function core(): GgCore {
  if (!ggCore) throw new Error('The Roamies engine is not loaded (the Roamies brain is not in use).');
  return ggCore;
}

export const TRANSCRIPTION_SECRET = 'voice:transcription:apiKey';
const OPENAI_API = 'https://api.openai.com/v1';
const THINKING_ORDER: ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The order Roamies itself falls back through when nothing is picked yet. */
const PREFERRED = ['anthropic', 'openai', 'gemini'];

export interface EngineTool {
  spec: ToolSpec;
  execute(input: Record<string, unknown>, toolCallId: string): Promise<{ content: string; isError?: boolean }>;
}

export interface RunRequest {
  system: string;
  /** Conversation so far, ending with the user's turn. */
  messages: LlmMessage[];
  tools?: EngineTool[];
  maxTurns?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Stop as soon as this tool has run (its result is all the caller needs). */
  stopAfter?: string;
}

export interface RunResult {
  text: string;
  stopReason: StopReason;
  provider: string;
  model: string;
  route: 'api' | 'claude-code';
  turns: number;
}

/** A model server on this computer (or the local network): Ollama, LM Studio, llama.cpp, vLLM… */
export interface LocalServerStatus {
  id: string;
  label: string;
  baseUrl: string;
  /** ollama: the default Ollama (OLLAMA_HOST honoured); custom: added in Jarvis. */
  kind: 'ollama' | 'custom';
  reachable: boolean;
  reason: string | null;
  models: Array<{ id: string; name: string; tools: boolean; thinking: boolean; contextWindow: number; contextKnown: boolean }>;
}

/** Below this, a local model has too little context for Jarvis's instructions and tools. */
const MIN_LOCAL_CONTEXT = 16_384;

/** OLLAMA_HOST as Ollama reads it ("host", "host:port" or a URL) → its OpenAI-compatible base URL. */
export function ollamaBaseUrl(host = process.env.OLLAMA_HOST): string {
  const fallback = ggCore?.DEFAULT_LOCAL_ENDPOINTS.find((e) => e.id === 'ollama')?.baseUrl ?? 'http://127.0.0.1:11434/v1';
  if (!host?.trim()) return fallback;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(host.trim()) ? host.trim() : `http://${host.trim()}`);
    if (u.hostname === '0.0.0.0' || u.hostname === '[::]') u.hostname = '127.0.0.1';
    if (!u.port && !/^[a-z]+:\/\/[^/]+:\d+/i.test(host.trim())) u.port = '11434';
    return `${u.origin}/v1`;
  } catch {
    return fallback;
  }
}

/** A stable id for a server URL (it is part of model ids saved in settings). */
const serverId = (url: string): string => {
  try {
    const u = new URL(url);
    return `server-${u.hostname.replace(/[^a-z0-9]+/gi, '-')}-${u.port || (u.protocol === 'https:' ? '443' : '80')}`.toLowerCase();
  } catch {
    return 'server';
  }
};

export interface EngineStatus {
  ready: boolean;
  provider: { id: string; name: string } | null;
  model: { id: string; name: string } | null;
  /** roamies: the model picked in Roamies; jarvis: a model chosen in Jarvis's settings; auto: Roamies has none picked yet. */
  source: 'roamies' | 'jarvis' | 'auto' | 'openjarvis' | null;
  route: 'api' | 'claude-code' | null;
  /** openjarvis: local brain via OpenJarvis; roamies: the Roamies engine. */
  backend: 'openjarvis' | 'roamies';
  /** Cloud models / voices / transcription are refused. */
  localOnly: boolean;
  /** OpenJarvis server state (openjarvis backend). */
  openjarvis: OpenJarvisHealth | null;
  /** What the local engine says the model can do (tools / thinking / vision / context), when it knows. */
  capabilities: ModelCapabilities | null;
  /** How Jarvis gives this model its tools: the model's own tool calling, or described in the prompt. */
  toolMode: 'native' | 'prompted' | null;
  signedIn: Array<{ id: string; name: string; claude?: boolean }>;
  models: Array<{ id: string; name: string; provider: string; tools: boolean }>;
  /** Whether the model in use can call tools (local models may not). Without tools Jarvis can talk but not act. */
  tools: boolean;
  local: LocalServerStatus[];
  /** Something that works but not well (e.g. a local model with a tiny context window). */
  warning: string | null;
  problem: string | null;
  configPath: string;
  look: string | null;
  health: { ok: boolean; detail: string; checkedAt: number } | null;
  lastError: string | null;
  lastUsedAt: number | null;
}

interface Target {
  provider: string;
  model: string;
  source: 'roamies' | 'jarvis' | 'auto' | 'openjarvis';
  route: 'api' | 'claude-code';
}

interface RoamiesConfig {
  provider: string | null;
  model: string | null;
  look: string | null;
}

const providerName = (id: string): string => (id === 'openjarvis' ? 'OpenJarvis (this computer)' : id === 'local' ? 'Local models' : core().AUTH_PROVIDERS.find((p) => p.value === id)?.label ?? id);
const modelName = (id: string): string => {
  const local = core().parseLocalModelId(id);
  return local ? core().localModelShortName(local.rawId) : core().getModel(id)?.name ?? id;
};

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function fileStamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return 'none';
  }
}

function toGgMessages(messages: LlmMessage[], rawId: string): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool_results') out.push({ role: 'tool', content: m.results.map((r) => ({ type: 'tool_result' as const, toolCallId: r.toolCallId, content: r.content, isError: r.isError ?? false })) });
    else if (m.raw && m.raw.providerId === rawId) out.push({ role: 'assistant', content: m.raw.content as ContentPart[] });
    else {
      const parts: ContentPart[] = [];
      if (m.text) parts.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) parts.push({ type: 'tool_call', id: c.id, name: c.name, args: (c.input ?? {}) as Record<string, unknown> });
      out.push({ role: 'assistant', content: parts.length ? parts : '(no content)' });
    }
  }
  return out;
}

function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

function mapStop(reason: string, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_use';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end';
  if (reason === 'max_tokens' || reason === 'refusal' || reason === 'tool_use') return reason;
  return 'other';
}

function toProviderError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = (err as { statusCode?: number })?.statusCode;
  let msg = errorMessage(err);
  if (/not logged in|no saved credentials|NotLoggedIn/i.test(`${msg} ${(err as Error)?.name ?? ''}`)) msg = `${providerName(provider)} isn't signed in. Sign in on the Model page in Roamies.`;
  return new ProviderError(msg, { retryable: status === undefined || status === 429 || status >= 500, status });
}

/** This computer or the local network (local-only mode keeps voice/brain traffic off the internet). */
function isLocalAddress(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(h) || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h) || /\.(local|lan)$/.test(h);
  } catch {
    return false;
  }
}

export class RoamiesEngine {
  private settings: SettingsStore;
  private secrets: SecretStore;
  private activity: ActivityLog;
  private gate: RoamiesGate;
  private dataDir: string;
  readonly localModel: LocalModelManager | null;

  private auth: InstanceType<GgCore['AuthStorage']> | null = null;
  private authPath = '';
  private stamp = '';
  private target: Target | null = null;
  private snapshot: Omit<EngineStatus, 'health' | 'lastError' | 'lastUsedAt'> | null = null;
  private refreshing: Promise<void> | null = null;
  private health: EngineStatus['health'] = null;
  private lastError: string | null = null;
  private lastUsedAt: number | null = null;
  private probes: LocalEndpointProbe[] = [];
  /** On-demand local voice workers (set by the app); preferred over OpenJarvis's always-loaded speech. */
  localVoice: import('../voice/workers.ts').VoiceWorkers | null = null;
  private oj: OpenJarvisClient | null = null;
  private ojHealth: OpenJarvisHealth | null = null;
  private caps: ModelCapabilities | null = null;
  /** The reasoning model answered empty through OpenJarvis; talk to the engine directly from now on. */
  private direct = false;
  /** Test seam for the Claude Code route (replaces the Claude Agent SDK's query()). */
  claudeCodeQuery: ClaudeCodeAgentOptions['query'] | undefined;

  constructor(deps: { settings: SettingsStore; secrets: SecretStore; activity: ActivityLog; gate: RoamiesGate; dataDir: string; localModel?: LocalModelManager | null }) {
    this.settings = deps.settings;
    this.secrets = deps.secrets;
    this.activity = deps.activity;
    this.gate = deps.gate;
    this.dataDir = deps.dataDir;
    this.localModel = deps.localModel ?? null;
  }

  backend(): 'openjarvis' | 'roamies' {
    return this.settings.get().brain.backend;
  }

  localOnly(): boolean {
    return this.settings.get().brain.localOnly;
  }

  /** Tools in the prompt instead of native tool calling: when asked to, or when the engine says the model has no tool support. */
  private promptedTools(): boolean {
    const mode = this.settings.get().brain.toolMode;
    if (mode !== 'auto') return mode === 'prompted';
    return this.caps !== null && !this.caps.tools;
  }

  /** The OpenJarvis client for the configured address. */
  openJarvis(): OpenJarvisClient {
    const url = this.settings.get().brain.openjarvisUrl;
    if (!this.oj || this.oj.baseUrl !== url.replace(/\/+$/, '').replace(/\/v1$/, '')) this.oj = new OpenJarvisClient(url);
    return this.oj;
  }

  /** Load OpenJarvis's state: reachable, models, voice. The brain is ready when a local model is there. */
  /** Health of the local engine itself (Ollama), shaped like OpenJarvis health — for via: 'engine'. */
  private async engineHealth(): Promise<OpenJarvisHealth> {
    const url = this.settings.get().brain.engineUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    try {
      const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(4000) });
      const d = (await r.json()) as { models?: Array<{ name: string }> };
      const models = (d.models ?? []).map((m) => ({ id: m.name, ownedBy: 'ollama' }));
      const voice = this.localVoice?.available() ?? false;
      return {
        reachable: true,
        detail: `Local engine at ${url} — ${models.length ? models.map((m) => m.id).slice(0, 4).join(', ') : 'no model pulled yet'} (direct, no OpenJarvis server)`,
        models,
        speech: { available: voice, detail: voice ? 'local Whisper, on demand' : 'needs the local voice Python (run the local setup)' },
        tts: { available: voice, detail: voice ? 'local Kokoro, on demand' : 'needs the local voice Python (run the local setup)', voiceId: null },
      };
    } catch (err) {
      return { reachable: false, detail: `The local engine isn't reachable at ${url} (${(err as Error).message}). Start Ollama.`, models: [], speech: null, tts: null };
    }
  }

  private async loadOpenJarvis(stamp: string): Promise<void> {
    const viaEngine = this.settings.get().brain.via === 'engine';
    const h = viaEngine ? await this.engineHealth() : await this.openJarvis().health();
    this.ojHealth = h;
    const wanted = this.settings.get().brain.model.trim();
    const localOnly = this.localOnly();
    const usable = h.models.filter((m) => !(localOnly && isCloudModel(m.id, m.ownedBy)));
    const owner = (id: string) => h.models.find((m) => m.id === id)?.ownedBy ?? null;
    let problem: string | null = null;
    let warning: string | null = null;
    let model: string | null = null;
    if (!h.reachable && viaEngine) problem = h.detail;
    else if (!h.reachable) problem = `OpenJarvis isn't running at ${this.settings.get().brain.openjarvisUrl}. Start it (\`jarvis serve\`, or the "Jarvis Brain" service from the local setup) and Jarvis connects within 30 seconds.`;
    else if (wanted && localOnly && isCloudModel(wanted, owner(wanted))) problem = `"${wanted}" is a cloud model, and Jarvis is set to local-only (no API spending). Pick a local model in Settings → Model.`;
    else if (wanted) model = wanted;
    else if (usable.length) model = usable[0].id;
    else problem = 'OpenJarvis is running but has no local model yet. Pull one (e.g. `ollama pull qwen3:8b`) or run the local setup.';
    if (model && !h.models.some((m) => m.id === model)) warning = `OpenJarvis doesn't list "${model}" — it may still be downloading.`;
    const prevModel = this.target?.model;
    this.caps = model ? await ollamaCapabilities(this.settings.get().brain.engineUrl, model) : null;
    if (model !== prevModel) this.direct = false;
    if (viaEngine) this.direct = true;
    if (h.reachable && !h.speech?.available) warning = [warning, `Local listening isn't ready (${h.speech?.detail ?? 'unknown'}).`].filter(Boolean).join(' ');
    this.target = !problem && model ? { provider: 'openjarvis', model, source: 'openjarvis', route: 'api' } : null;
    this.snapshot = {
      ready: Boolean(this.target),
      provider: { id: 'openjarvis', name: providerName('openjarvis') },
      model: model ? { id: model, name: model } : null,
      source: 'openjarvis',
      route: model ? 'api' : null,
      signedIn: [],
      models: usable.map((m) => ({ id: m.id, name: m.id, provider: 'openjarvis', tools: true })),
      tools: Boolean(this.target),
      local: [],
      warning,
      problem,
      configPath: this.settings.get().brain.openjarvisUrl,
      look: null,
      backend: 'openjarvis',
      localOnly,
      openjarvis: h,
      capabilities: this.caps,
      toolMode: model ? (this.promptedTools() ? 'prompted' : 'native') : null,
    };
    const was = this.stamp ? this.lastReady : null;
    this.lastReady = Boolean(this.target);
    if (was !== null && was !== this.lastReady) this.activity.log(this.lastReady ? 'success' : 'warning', 'llm', this.lastReady ? `Thinking locally with ${model} through OpenJarvis` : `Local brain unavailable: ${problem}`);
    else if (was === null && this.lastReady) this.activity.log('success', 'llm', `Thinking locally with ${model} through OpenJarvis — no API keys, no usage limits`);
    this.stamp = stamp;
  }

  private authStorage(): InstanceType<GgCore['AuthStorage']> {
    const path = join(this.gate.detection().ggDir, 'auth.json');
    if (!this.auth || this.authPath !== path) {
      this.auth = new (core().AuthStorage)(path);
      this.authPath = path;
    }
    return this.auth;
  }

  private roamiesConfig(): RoamiesConfig {
    const raw = readJsonFile(this.gate.detection().configPath) ?? {};
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return { provider: str(raw.provider), model: str(raw.model), look: str(raw.look) };
  }

  /** The local servers Jarvis looks at: Ollama (where Roamies connects it, or OLLAMA_HOST) plus servers added in Settings. */
  localEndpoints(): LocalEndpoint[] {
    const ollama = core().DEFAULT_LOCAL_ENDPOINTS.find((e) => e.id === 'ollama')!;
    const list: LocalEndpoint[] = [{ ...ollama, baseUrl: ollamaBaseUrl() }];
    for (const url of this.settings.get().llm.localServers) {
      const id = serverId(url);
      if (list.some((e) => e.id === id)) continue;
      list.push({ id, label: `Local server (${new URL(url).host})`, baseUrl: url.replace(/\/+$/, ''), kind: 'custom', custom: true });
    }
    return list;
  }

  /** Ask the local servers what they serve (gg-core caches answers for 30 s; `force` re-asks). */
  async discoverLocal(force = false): Promise<void> {
    try {
      const { probes, models } = await core().discoverLocalModels(this.localEndpoints(), { timeoutMs: 1500, force });
      core().clearRuntimeModels((m) => m.provider === 'local');
      core().registerRuntimeModels(models);
      this.probes = probes;
    } catch {
      this.probes = [];
    }
  }

  private localStatus(): LocalServerStatus[] {
    const endpoints = this.localEndpoints();
    return endpoints.map((e) => {
      const p = this.probes.find((x) => x.endpoint.id === e.id && x.endpoint.baseUrl === e.baseUrl);
      return {
        id: e.id,
        label: e.label,
        baseUrl: e.baseUrl,
        kind: e.custom ? 'custom' : 'ollama',
        reachable: Boolean(p?.reachable),
        reason: p ? (p.reachable ? null : p.reason ?? 'not reachable') : 'not checked yet',
        models: (p?.reachable ? p.models : []).map((m) => ({
          id: `local/${e.id}/${m.rawId}`,
          name: core().localModelShortName(m.rawId),
          tools: m.supportsTools,
          thinking: m.supportsThinking,
          contextWindow: m.contextWindow,
          contextKnown: m.contextWindowKnown,
        })),
      };
    });
  }

  private localModelInfo(id: string): LocalServerStatus['models'][number] | undefined {
    return this.localStatus().flatMap((s) => s.models).find((m) => m.id === id);
  }

  /**
   * Re-reads Roamies' model choice and sign-ins when either file (or Jarvis's model setting) changed.
   * Cheap when nothing changed: two stat calls.
   */
  async refresh(force = false): Promise<void> {
    // A load already under way may have read the files before they changed: wait, then look again.
    while (this.refreshing) await this.refreshing.catch(() => {});
    const d = this.gate.detection();
    const s = this.settings.get().llm;
    // Local servers start and stop on their own: look again at most every 30 s.
    const b = this.settings.get().brain;
    const stamp = [b.backend, b.via, b.engineUrl, b.toolMode, b.openjarvisUrl, b.model, b.localOnly, d.installed, d.configPath, fileStamp(d.configPath), fileStamp(join(d.ggDir, 'auth.json')), s.model, s.localServers.join(','), Math.floor(Date.now() / 30_000)].join('|');
    if (!force && stamp === this.stamp && this.snapshot) return;
    if (this.closing) return;
    this.refreshing = (b.backend === 'openjarvis' ? this.loadOpenJarvis(stamp) : loadRoamiesEngine().then(() => this.load(stamp))).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async load(stamp: string): Promise<void> {
    const d = this.gate.detection();
    const cfg = this.roamiesConfig();
    const base = { configPath: d.configPath, look: cfg.look, backend: 'roamies' as const, localOnly: this.localOnly(), openjarvis: null, capabilities: null, toolMode: null };
    if (!d.installed) {
      this.target = null;
      this.snapshot = { ...base, ready: false, provider: null, model: null, source: null, route: null, signedIn: [], models: [], tools: false, local: [], warning: null, problem: 'Roamies is not installed.' };
      this.stamp = stamp;
      return;
    }
    const auth = this.authStorage();
    await this.discoverLocal();
    const local = this.localStatus();
    const localModels = local.flatMap((l) => l.models);
    const claude = await auth.hasClaudeCodeLogin().catch(() => false);
    const providers = [...new Set([...PREFERRED, ...core().AUTH_PROVIDERS.map((p) => p.value)])];
    const signedIn: EngineStatus['signedIn'] = [];
    for (const p of providers) {
      const has = (p === 'anthropic' && claude) || (await auth.hasProviderAuth(p).catch(() => false));
      if (has) signedIn.push({ id: p, name: providerName(p), ...(p === 'anthropic' && claude ? { claude: true } : {}) });
    }
    // Local models need no sign-in: connected in Roamies, or simply running on this computer.
    if (localModels.length || (await auth.hasProviderAuth('local').catch(() => false))) signedIn.push({ id: 'local', name: providerName('local') });
    if (cfg.provider && !signedIn.some((s) => s.id === cfg.provider) && cfg.provider === 'palsu') signedIn.push({ id: 'palsu', name: 'Test provider' });

    const override = this.settings.get().llm.model.trim();
    let provider: string | null = null;
    let model: string | null = null;
    let source: Target['source'] | null = null;
    if (override) {
      provider = core().parseLocalModelId(override) ? 'local' : core().getModel(override)?.provider ?? cfg.provider;
      model = override;
      source = 'jarvis';
    } else if (cfg.provider && cfg.model) {
      provider = cfg.provider;
      model = cfg.model;
      source = 'roamies';
    } else {
      const first = signedIn.find((s) => s.id !== 'local' && s.id !== 'palsu');
      if (first) {
        provider = first.id;
        model = cfg.provider === first.id && cfg.model ? cfg.model : core().getDefaultModel(first.id as Provider)?.id ?? null;
        source = 'auto';
      } else if (localModels.length) {
        // Nothing signed in, but a local model is running: use it (one that can use tools, if any).
        provider = 'local';
        model = (localModels.find((m) => m.tools) ?? localModels[0]).id;
        source = 'auto';
      }
    }

    let problem: string | null = null;
    let warning: string | null = null;
    let route: Target['route'] | null = null;
    const pickedLocal = provider === 'local' && model ? core().parseLocalModelId(model) : undefined;
    if (!provider || !model) problem = signedIn.length ? 'No model is picked in Roamies yet. Pick one on the Model page in Roamies.' : 'Roamies has no AI sign-in yet. Open Roamies and sign in on its Model page (Claude, ChatGPT or an API key), or start a local model server such as Ollama.';
    else if (provider === 'local') {
      const server = local.find((l) => l.id === pickedLocal?.endpointId);
      const m = this.localModelInfo(model);
      if (!pickedLocal) problem = `“${model}” is not a local model id.`;
      else if (!server) problem = `The local server for ${modelName(model)} isn't set up in Jarvis. Add it under Integrations → Model.`;
      else if (!server.reachable) problem = `${server.label} isn't running (${server.reason ?? 'not reachable'}). Start it and Jarvis will pick it up within 30 seconds.`;
      else if (!m) problem = `${server.label} doesn't have ${modelName(model)}. Pull it (e.g. ollama pull ${pickedLocal.rawId}) or pick another model.`;
      else {
        route = 'api';
        if (!m.tools) warning = `${m.name} can't use tools, so Jarvis can talk with it but can't search memory, plan tasks or act through it. Direct commands still work. Pick a model with tool support (e.g. qwen3, llama3.1) for everything else.`;
        else if (m.contextWindow < MIN_LOCAL_CONTEXT) warning = `${server.label} gives ${m.name} only ${Math.round(m.contextWindow / 1024)}k tokens of context, which is too little for Jarvis to work well. Raise the context length (Ollama: Settings → Context length 32k, or OLLAMA_CONTEXT_LENGTH=32768).`;
      }
    } else if (this.localOnly() && provider !== 'palsu') problem = `${providerName(provider)} is a cloud model, and Jarvis is set to local-only (no API spending). Pick a local model, or switch the brain to OpenJarvis.`;
    else if (!signedIn.some((s) => s.id === provider)) problem = `${providerName(provider)} isn't signed in. Sign in on the Model page in Roamies.`;
    else {
      route = provider === 'anthropic' && claude ? 'claude-code' : 'api';
      if (route === 'claude-code' && !core().resolveClaudeCodeBinary()) problem = "Claude Code isn't installed for Roamies anymore. Sign in with Claude again on the Model page in Roamies.";
    }

    this.target = !problem && provider && model && route ? { provider, model, source: source!, route } : null;
    const models = [
      ...signedIn.filter((s) => s.id !== 'local' && s.id !== 'palsu').flatMap((s) => core().getModelsForProvider(s.id as Provider).map((m) => ({ id: m.id, name: m.name, provider: s.id, tools: true }))),
      ...localModels.map((m) => ({ id: m.id, name: m.name, provider: 'local', tools: m.tools })),
    ];
    this.snapshot = {
      ...base,
      ready: Boolean(this.target),
      provider: provider ? { id: provider, name: providerName(provider) } : null,
      model: model ? { id: model, name: modelName(model) } : null,
      source,
      route,
      signedIn,
      models,
      tools: provider === 'local' && model ? Boolean(this.localModelInfo(model)?.tools) : Boolean(this.target),
      local,
      warning,
      problem,
    };
    const was = this.stamp ? this.lastReady : null;
    this.lastReady = Boolean(this.target);
    if (was !== null && was !== this.lastReady) {
      this.activity.log(this.lastReady ? 'success' : 'warning', 'llm', this.lastReady ? `Thinking with ${modelName(model!)} through Roamies` : `Model unavailable: ${problem}`);
    }
    this.stamp = stamp;
  }
  private lastReady: boolean | null = null;

  private closing = false;

  /** Shutdown: no new refreshes start, and the one in flight (if any) finishes before the database closes. */
  async idle(): Promise<void> {
    this.closing = true;
    while (this.refreshing) await this.refreshing.catch(() => {});
  }

  /** Whether a model can be used right now (from the last refresh; call refresh() first when it matters). */
  available(): boolean {
    if (!this.snapshot) return false;
    void this.refresh().catch(() => {});
    return Boolean(this.target) && (this.backend() === 'openjarvis' || this.gate.detection().installed);
  }

  activeProvider(): { id: string; model: string } | null {
    return this.target ? { id: this.target.provider, model: this.target.model } : null;
  }

  status(): EngineStatus {
    const s = this.snapshot ?? {
      ready: false,
      provider: null,
      model: null,
      source: null,
      route: null,
      signedIn: [],
      models: [],
      tools: false,
      local: [],
      warning: null,
      problem: 'Not checked yet',
      configPath: this.gate.detection().configPath,
      look: null,
      backend: this.backend(),
      localOnly: this.localOnly(),
      openjarvis: this.ojHealth,
      capabilities: this.caps,
      toolMode: null,
    };
    return { ...s, health: this.health, lastError: this.lastError, lastUsedAt: this.lastUsedAt };
  }

  private thinking(model: string): ThinkingLevel | undefined {
    const wanted = this.settings.get().llm.thinking;
    const info = core().getModel(model);
    if (wanted === 'off' || !info?.supportsThinking) return undefined;
    const max = core().getMaxThinkingLevel(model);
    const maxIdx = THINKING_ORDER.indexOf(max as ThinkingLevel);
    const idx = THINKING_ORDER.indexOf(wanted);
    return maxIdx >= 0 && idx > maxIdx ? THINKING_ORDER[maxIdx] : wanted;
  }

  private async requireTarget(): Promise<Target> {
    if (this.backend() === 'roamies' && !this.gate.detection().installed) throw new ProviderError('Roamies is not installed. Jarvis runs on Roamies — install it, then choose Check again.', { retryable: false });
    await this.refresh();
    if (!this.target) throw new ProviderError(this.snapshot?.problem ?? 'No model is available.', { retryable: !this.snapshot?.problem || /isn't running|not reachable/i.test(this.snapshot.problem) });
    return this.target;
  }

  /** Whether the model in use can call tools. Jarvis only offers tools to models that can use them. */
  supportsTools(): boolean {
    if (!this.target) return false;
    if (this.target.provider === 'openjarvis') return true;
    return this.target.provider === 'local' ? Boolean(this.localModelInfo(this.target.model)?.tools) : true;
  }

  private async credentials(t: Target): Promise<{ apiKey?: string; baseUrl?: string; accountId?: string }> {
    if (t.provider === 'palsu') return {};
    if (t.provider === 'local') {
      // The server Jarvis found it on; a key Roamies saved for that server, if any.
      const parsed = core().parseLocalModelId(t.model);
      const endpoint = this.localEndpoints().find((e) => e.id === parsed?.endpointId);
      const saved = parsed ? await this.authStorage().getCredentials(core().localAuthStorageKey(parsed.endpointId)).catch(() => undefined) : undefined;
      return { apiKey: endpoint?.apiKey || saved?.accessToken || core().LOCAL_API_KEY_PLACEHOLDER, baseUrl: endpoint?.baseUrl ?? saved?.baseUrl };
    }
    const c = await this.authStorage().resolveCredentials(t.provider, { storageKeys: core().getAuthStorageKeys(t.provider as Provider, t.model) });
    return { apiKey: c.accessToken, ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}), ...(c.accountId !== undefined ? { accountId: c.accountId } : {}) };
  }

  private signal(signal?: AbortSignal, minSec = 0): AbortSignal {
    const timeout = AbortSignal.timeout(Math.max(minSec, this.settings.get().llm.requestTimeoutSec) * 1000);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  /** One model call through gg-ai (API route only). */
  private async callApi(t: Target, req: LlmRequest): Promise<LlmResponse> {
    const rawId = `${t.provider}:${t.model}`;
    if (t.provider === 'openjarvis') {
      if (this.localOnly() && isCloudModel(t.model, this.ojHealth?.models.find((m) => m.id === t.model)?.ownedBy)) throw new ProviderError(`Refusing cloud model ${t.model}: Jarvis is local-only.`, { retryable: false });
      // Reasoning models (DeepSeek R1, Qwen thinking…) spend tokens thinking before they answer.
      const maxTokens = this.caps?.thinking ? Math.max(req.maxTokens ?? 0, 8192) : Math.min(req.maxTokens ?? 4096, 8192);
      // A local model costs nothing per token but can be slow: a reasoning model on a CPU mini PC may
      // think for minutes. Give it up to 15 minutes before calling it a timeout.
      const call = { model: t.model, system: req.system, messages: req.messages, tools: req.tools, maxTokens, signal: this.signal(req.signal, 900), promptedTools: this.promptedTools() };
      const engine = new OpenJarvisClient(this.settings.get().brain.engineUrl);
      let r = this.direct ? await engine.complete(call) : await this.openJarvis().complete(call);
      if (r.empty && !this.direct && !req.signal?.aborted) {
        // A thinking-only model through a server that turns thinking off answers with nothing: ask the
        // local engine directly (same model, same tools — it returns the answer after the reasoning).
        const viaEngine = await engine.complete(call).catch(() => null);
        if (viaEngine && !viaEngine.empty) {
          this.direct = true;
          this.activity.log('info', 'llm', `${t.model} reasons before answering; Jarvis now talks to it on the local engine directly (still fully local).`);
          r = viaEngine;
        }
      }
      return { text: r.text, toolCalls: r.toolCalls, stopReason: r.stopReason, providerId: rawId, model: r.model, raw: null, usage: r.usage };
    }
    const tools: Tool[] | undefined = req.tools?.length
      ? req.tools.map((spec) => ({ name: spec.name, description: spec.description, parameters: z.looseObject({}), rawInputSchema: spec.inputSchema }))
      : undefined;
    const info = core().getModel(t.model);
    let res;
    try {
      const creds = await this.credentials(t);
      res = await ggAi!.stream({
        provider: t.provider as Provider,
        model: t.model,
        messages: [{ role: 'system', content: req.system }, ...toGgMessages(req.messages, rawId)],
        ...(tools ? { tools, toolChoice: 'auto' as const } : {}),
        maxTokens: Math.min(req.maxTokens ?? 16_000, info?.maxOutputTokens ?? 16_000),
        thinking: this.thinking(t.model),
        signal: this.signal(req.signal),
        ...creds,
      });
    } catch (err) {
      throw toProviderError(err, t.provider);
    }
    const parts = typeof res.message.content === 'string' ? [{ type: 'text' as const, text: res.message.content }] : res.message.content;
    const toolCalls = parts.flatMap((p) => (p.type === 'tool_call' ? [{ id: p.id, name: p.name, input: p.args }] : []));
    return {
      text: textOf(parts),
      toolCalls,
      stopReason: mapStop(res.stopReason, toolCalls.length > 0),
      providerId: rawId,
      model: t.model,
      raw: parts,
      usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens },
    };
  }

  /**
   * Runs the model with tools until it answers. Jarvis's own loop on the API route; Roamies' Claude Code
   * bridge (no Claude Code tools, only these) when Roamies is signed in with Claude.
   */
  async run(req: RunRequest): Promise<RunResult> {
    const t = await this.requireTarget();
    try {
      const out = t.route === 'claude-code' ? await this.runClaudeCode(t, req) : await this.runApi(t, req);
      this.lastUsedAt = Date.now();
      this.lastError = null;
      return out;
    } catch (err) {
      if (!req.signal?.aborted) this.lastError = errorMessage(err);
      throw err;
    }
  }

  private async runApi(t: Target, req: RunRequest): Promise<RunResult> {
    const messages = [...req.messages];
    const maxTurns = req.maxTurns ?? this.settings.get().llm.maxToolIterations;
    const specs = this.supportsTools() ? req.tools?.map((x) => x.spec) : undefined;
    let text = '';
    let stop: StopReason = 'end';
    let turns = 0;
    for (let i = 0; i < maxTurns; i++) {
      turns++;
      const res = await this.callApi(t, { system: req.system, messages, tools: specs, maxTokens: req.maxTokens, signal: req.signal });
      stop = res.stopReason;
      text = res.text;
      if (res.stopReason === 'refusal' || !res.toolCalls.length) break;
      messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls, raw: { providerId: res.providerId, content: res.raw } });
      const results = [];
      for (const call of res.toolCalls) {
        const tool = req.tools?.find((x) => x.spec.name === call.name);
        const r = tool ? await tool.execute((call.input ?? {}) as Record<string, unknown>, call.id) : { content: `Unknown tool ${call.name}`, isError: true };
        results.push({ toolCallId: call.id, content: r.content, isError: r.isError });
      }
      messages.push({ role: 'tool_results', results });
      if (req.stopAfter && res.toolCalls.some((c) => c.name === req.stopAfter)) break;
    }
    return { text, stopReason: stop, provider: t.provider, model: t.model, route: 'api', turns };
  }

  private async runClaudeCode(t: Target, req: RunRequest): Promise<RunResult> {
    // The Claude Agent SDK (~33 MB) is only loaded for this route.
    const { ClaudeCodeAgent } = await import('./claudecode.mjs');
    const executable = core().resolveClaudeCodeBinary();
    if (!executable) throw new ProviderError("Claude Code isn't installed for Roamies anymore. Sign in with Claude again on the Model page in Roamies.", { retryable: false });
    const history = [...req.messages];
    const last = history.pop();
    if (!last || last.role !== 'user') throw new ProviderError('A request must end with a user message', { retryable: false });
    const cwd = join(this.dataDir, 'engine');
    mkdirSync(cwd, { recursive: true });
    const tools: AgentTool[] = (req.tools ?? []).map((x) => ({
      name: x.spec.name,
      description: x.spec.description,
      parameters: z.looseObject({}),
      rawInputSchema: x.spec.inputSchema,
      executionMode: 'sequential',
      async execute(args: Record<string, unknown>, ctx: { toolCallId: string }) {
        const r = await x.execute(args ?? {}, ctx.toolCallId);
        if (r.isError) throw new Error(r.content);
        return r.content;
      },
    })) as unknown as AgentTool[];
    const agent = new ClaudeCodeAgent({
      model: t.model,
      system: req.system,
      priorMessages: toGgMessages(history, ''),
      tools,
      maxTurns: req.maxTurns ?? this.settings.get().llm.maxToolIterations,
      thinking: this.thinking(t.model),
      signal: this.signal(req.signal),
      executable,
      cwd,
      env: core().claudeCodeEnv(),
      resume: null,
      ...(this.claudeCodeQuery ? { query: this.claudeCodeQuery } : {}),
    });
    const run = agent.prompt(last.content);
    let truncated = false;
    for await (const ev of run) {
      if (ev.type === 'truncated' || ev.type === 'max_turns') truncated = true;
      if (ev.type === 'error') throw toProviderError(ev.error, t.provider);
    }
    let result;
    try {
      result = await run;
    } catch (err) {
      throw toProviderError(err, t.provider);
    }
    const stopRaw = (result.message as { stopReason?: string }).stopReason;
    return {
      text: textOf(result.message.content as string | ContentPart[]),
      stopReason: stopRaw === 'refusal' ? 'refusal' : truncated ? 'max_tokens' : 'end',
      provider: t.provider,
      model: t.model,
      route: 'claude-code',
      turns: result.totalTurns,
    };
  }

  /** A single answer without tools. */
  async generate(req: { system: string; prompt: string; maxTokens?: number; signal?: AbortSignal }): Promise<RunResult> {
    return this.run({ system: req.system, messages: [{ role: 'user', content: req.prompt }], maxTurns: 1, maxTokens: req.maxTokens, signal: req.signal });
  }

  /** Checks the sign-in without running the model (refreshes an expiring token, finds Claude Code). */
  async checkHealth(): Promise<void> {
    await this.refresh(true);
    const prev = this.health;
    let result: { ok: boolean; detail: string };
    if (!this.target) result = { ok: false, detail: this.snapshot?.problem ?? 'No model available' };
    else if (this.target.provider === 'openjarvis') result = { ok: true, detail: `${this.target.model} is running locally through OpenJarvis` };
    else if (this.target.route === 'claude-code') result = { ok: true, detail: `Signed in with Claude through Claude Code (${modelName(this.target.model)})` };
    else if (this.target.provider === 'local') result = { ok: true, detail: `${modelName(this.target.model)} is running locally` };
    else {
      try {
        await this.credentials(this.target);
        result = { ok: true, detail: `Signed in to ${providerName(this.target.provider)} (${modelName(this.target.model)})` };
      } catch (err) {
        result = { ok: false, detail: toProviderError(err, this.target.provider).message };
      }
    }
    this.health = { ...result, checkedAt: Date.now() };
    if (prev && prev.ok !== result.ok) this.activity.log(result.ok ? 'success' : 'warning', 'llm', result.ok ? 'Model sign-in works again' : `Model sign-in problem: ${result.detail}`);
  }

  // ------------------------------------------------------------------ memory embeddings

  embeddings(): EmbeddingProvider | null {
    if (!this.settings.get().embeddings.enabled) return null;
    return this.localModel?.get() ?? null;
  }

  // ------------------------------------------------------------------ voice transcription

  /** Which transcription service voice recordings would use, if one is usable. */
  async transcriptionTarget(): Promise<{ name: string; baseUrl: string; key?: string } | null> {
    const t = this.settings.get().voice.transcription;
    if (t.service === 'openjarvis') {
      if (this.localVoice?.available()) return { name: 'local Whisper (on demand)', baseUrl: 'worker' };
      const h = this.ojHealth ?? (await this.openJarvis().health());
      this.ojHealth = h;
      return h.reachable && h.speech?.available ? { name: 'OpenJarvis (local Whisper)', baseUrl: this.openJarvis().baseUrl } : null;
    }
    if (t.service === 'custom') {
      if (this.localOnly() && t.baseUrl && !isLocalAddress(t.baseUrl)) return null;
      if (!t.baseUrl) return null;
      return { name: 'your transcription server', baseUrl: t.baseUrl, key: this.secrets.get(TRANSCRIPTION_SECRET) ?? undefined };
    }
    if (t.service === 'openai') {
      if (this.localOnly() || !this.gate.detection().installed) return null;
      try {
        await loadRoamiesEngine();
        const c = await this.authStorage().resolveApiKey('openai');
        return { name: 'OpenAI (your key in Roamies)', baseUrl: c.baseUrl || OPENAI_API, key: c.accessToken };
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Speech to text through an OpenAI-compatible /audio/transcriptions endpoint. */
  async transcribe(audio: Buffer, mimeType: string, opts: { language?: string; signal?: AbortSignal } = {}): Promise<{ text: string; provider: string }> {
    const target = await this.transcriptionTarget();
    if (!target) throw new ProviderError(this.settings.get().voice.transcription.service === 'openjarvis' ? `Local listening isn't ready: ${this.ojHealth?.speech?.detail ?? 'OpenJarvis is not running'}.` : 'No transcription service is configured. Choose one under Settings → Voice (OpenJarvis on this computer, or your own Whisper server).', { retryable: false });
    if (this.settings.get().voice.transcription.service === 'openjarvis') {
      const r = target.baseUrl === 'worker' && this.localVoice ? await this.localVoice.transcribe(audio, mimeType, opts) : await this.openJarvis().transcribe(audio, mimeType, opts);
      return { text: r.text, provider: target.name };
    }
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${ext}`);
    form.append('model', this.settings.get().voice.transcription.model);
    if (opts.language) form.append('language', opts.language.split('-')[0]);
    form.append('response_format', 'json');
    let res: Response;
    try {
      res = await fetch(`${target.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: target.key ? { authorization: `Bearer ${target.key}` } : {},
        body: form,
        signal: opts.signal ?? AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new ProviderError(`Cannot reach ${target.name}: ${errorMessage(err)}`, { retryable: true });
    }
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`${target.name} transcription failed (HTTP ${res.status}): ${text.slice(0, 200)}`, { retryable: false, status: res.status });
    let parsed: { text?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
    return { text: (parsed.text ?? '').trim(), provider: target.name };
  }
}
