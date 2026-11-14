import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stream, type ContentPart, type Message, type Provider, type ThinkingLevel, type Tool } from '@kenkaiiii/gg-ai';
import type { AgentTool } from '@kenkaiiii/gg-agent';
import { AUTH_PROVIDERS, AuthStorage, claudeCodeEnv, getAuthStorageKeys, getDefaultModel, getMaxThinkingLevel, getModel, getModelsForProvider, resolveClaudeCodeBinary } from '@kenkaiiii/gg-core';
import { z } from 'zod';
import type { ActivityLog } from '../core/activity.ts';
import type { SecretStore } from '../core/secrets.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage } from '../core/util.ts';
import type { RoamiesGate } from '../roamies/gate.ts';
import { ClaudeCodeAgent, type ClaudeCodeAgentOptions } from './claudecode.mjs';
import type { LocalModelManager } from './local-embeddings.ts';
import type { EmbeddingProvider, LlmMessage, LlmRequest, LlmResponse, StopReason, ToolSpec } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * Jarvis's model layer is the Roamies engine: the GG framework (gg-ai / gg-agent / gg-core), with the
 * provider and model the user picked in Roamies and the sign-ins Roamies saved in ~/.gg/auth.json.
 * When Roamies is signed in with Claude, Jarvis runs through Claude Code exactly as Roamies does.
 * Jarvis never shows, copies or stores those credentials; it asks gg-core for them per request.
 */

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

export interface EngineStatus {
  ready: boolean;
  provider: { id: string; name: string } | null;
  model: { id: string; name: string } | null;
  /** roamies: the model picked in Roamies; jarvis: a model chosen in Jarvis's settings; auto: Roamies has none picked yet. */
  source: 'roamies' | 'jarvis' | 'auto' | null;
  route: 'api' | 'claude-code' | null;
  signedIn: Array<{ id: string; name: string; claude?: boolean }>;
  models: Array<{ id: string; name: string; provider: string }>;
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
  source: 'roamies' | 'jarvis' | 'auto';
  route: 'api' | 'claude-code';
}

interface RoamiesConfig {
  provider: string | null;
  model: string | null;
  look: string | null;
}

const providerName = (id: string): string => (id === 'local' ? 'Local models' : AUTH_PROVIDERS.find((p) => p.value === id)?.label ?? id);
const modelName = (id: string): string => getModel(id)?.name ?? id;

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

export class RoamiesEngine {
  private settings: SettingsStore;
  private secrets: SecretStore;
  private activity: ActivityLog;
  private gate: RoamiesGate;
  private dataDir: string;
  readonly localModel: LocalModelManager | null;

  private auth: AuthStorage | null = null;
  private authPath = '';
  private stamp = '';
  private target: Target | null = null;
  private snapshot: Omit<EngineStatus, 'health' | 'lastError' | 'lastUsedAt'> | null = null;
  private refreshing: Promise<void> | null = null;
  private health: EngineStatus['health'] = null;
  private lastError: string | null = null;
  private lastUsedAt: number | null = null;
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

  private authStorage(): AuthStorage {
    const path = join(this.gate.detection().ggDir, 'auth.json');
    if (!this.auth || this.authPath !== path) {
      this.auth = new AuthStorage(path);
      this.authPath = path;
    }
    return this.auth;
  }

  private roamiesConfig(): RoamiesConfig {
    const raw = readJsonFile(this.gate.detection().configPath) ?? {};
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return { provider: str(raw.provider), model: str(raw.model), look: str(raw.look) };
  }

  /**
   * Re-reads Roamies' model choice and sign-ins when either file (or Jarvis's model setting) changed.
   * Cheap when nothing changed: two stat calls.
   */
  async refresh(force = false): Promise<void> {
    // A load already under way may have read the files before they changed: wait, then look again.
    while (this.refreshing) await this.refreshing.catch(() => {});
    const d = this.gate.detection();
    const stamp = [d.installed, d.configPath, fileStamp(d.configPath), fileStamp(join(d.ggDir, 'auth.json')), this.settings.get().llm.model].join('|');
    if (!force && stamp === this.stamp && this.snapshot) return;
    this.refreshing = this.load(stamp).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async load(stamp: string): Promise<void> {
    const d = this.gate.detection();
    const cfg = this.roamiesConfig();
    const base = { configPath: d.configPath, look: cfg.look };
    if (!d.installed) {
      this.target = null;
      this.snapshot = { ...base, ready: false, provider: null, model: null, source: null, route: null, signedIn: [], models: [], problem: 'Roamies is not installed.' };
      this.stamp = stamp;
      return;
    }
    const auth = this.authStorage();
    const claude = await auth.hasClaudeCodeLogin().catch(() => false);
    const providers = [...new Set([...PREFERRED, ...AUTH_PROVIDERS.map((p) => p.value), 'local'])];
    const signedIn: EngineStatus['signedIn'] = [];
    for (const p of providers) {
      const has = (p === 'anthropic' && claude) || (await auth.hasProviderAuth(p).catch(() => false));
      if (has) signedIn.push({ id: p, name: providerName(p), ...(p === 'anthropic' && claude ? { claude: true } : {}) });
    }
    if (cfg.provider && !signedIn.some((s) => s.id === cfg.provider) && cfg.provider === 'palsu') signedIn.push({ id: 'palsu', name: 'Test provider' });

    const override = this.settings.get().llm.model.trim();
    let provider: string | null = null;
    let model: string | null = null;
    let source: Target['source'] | null = null;
    if (override) {
      provider = getModel(override)?.provider ?? cfg.provider;
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
        model = cfg.provider === first.id && cfg.model ? cfg.model : getDefaultModel(first.id as Provider)?.id ?? null;
        source = 'auto';
      }
    }

    let problem: string | null = null;
    let route: Target['route'] | null = null;
    if (!provider || !model) problem = signedIn.length ? 'No model is picked in Roamies yet. Pick one on the Model page in Roamies.' : 'Roamies has no AI sign-in yet. Open Roamies and sign in on its Model page (Claude, ChatGPT or an API key).';
    else if (!signedIn.some((s) => s.id === provider)) problem = `${providerName(provider)} isn't signed in. Sign in on the Model page in Roamies.`;
    else {
      route = provider === 'anthropic' && claude ? 'claude-code' : 'api';
      if (route === 'claude-code' && !resolveClaudeCodeBinary()) problem = "Claude Code isn't installed for Roamies anymore. Sign in with Claude again on the Model page in Roamies.";
    }

    this.target = !problem && provider && model && route ? { provider, model, source: source!, route } : null;
    const models = signedIn
      .filter((s) => s.id !== 'local' && s.id !== 'palsu')
      .flatMap((s) => getModelsForProvider(s.id as Provider).map((m) => ({ id: m.id, name: m.name, provider: s.id })));
    this.snapshot = {
      ...base,
      ready: Boolean(this.target),
      provider: provider ? { id: provider, name: providerName(provider) } : null,
      model: model ? { id: model, name: modelName(model) } : null,
      source,
      route,
      signedIn,
      models,
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

  /** Whether a model can be used right now (from the last refresh; call refresh() first when it matters). */
  available(): boolean {
    if (!this.snapshot) return false;
    void this.refresh().catch(() => {});
    return Boolean(this.target) && this.gate.detection().installed;
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
      problem: 'Not checked yet',
      configPath: this.gate.detection().configPath,
      look: null,
    };
    return { ...s, health: this.health, lastError: this.lastError, lastUsedAt: this.lastUsedAt };
  }

  private thinking(model: string): ThinkingLevel | undefined {
    const wanted = this.settings.get().llm.thinking;
    const info = getModel(model);
    if (wanted === 'off' || !info?.supportsThinking) return undefined;
    const max = getMaxThinkingLevel(model);
    const maxIdx = THINKING_ORDER.indexOf(max as ThinkingLevel);
    const idx = THINKING_ORDER.indexOf(wanted);
    return maxIdx >= 0 && idx > maxIdx ? THINKING_ORDER[maxIdx] : wanted;
  }

  private async requireTarget(): Promise<Target> {
    if (!this.gate.detection().installed) throw new ProviderError('Roamies is not installed. Jarvis runs on Roamies — install it, then choose Check again.', { retryable: false });
    await this.refresh();
    if (!this.target) throw new ProviderError(this.snapshot?.problem ?? 'No model is available from Roamies.', { retryable: false });
    return this.target;
  }

  private async credentials(t: Target): Promise<{ apiKey?: string; baseUrl?: string; accountId?: string }> {
    if (t.provider === 'palsu') return {};
    const c = await this.authStorage().resolveCredentials(t.provider, { storageKeys: getAuthStorageKeys(t.provider as Provider, t.model) });
    return { apiKey: c.accessToken, ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}), ...(c.accountId !== undefined ? { accountId: c.accountId } : {}) };
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.settings.get().llm.requestTimeoutSec * 1000);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  /** One model call through gg-ai (API route only). */
  private async callApi(t: Target, req: LlmRequest): Promise<LlmResponse> {
    const rawId = `${t.provider}:${t.model}`;
    const tools: Tool[] | undefined = req.tools?.length
      ? req.tools.map((spec) => ({ name: spec.name, description: spec.description, parameters: z.looseObject({}), rawInputSchema: spec.inputSchema }))
      : undefined;
    const info = getModel(t.model);
    let res;
    try {
      const creds = await this.credentials(t);
      res = await stream({
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
    const specs = req.tools?.map((x) => x.spec);
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
    const executable = resolveClaudeCodeBinary();
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
      env: claudeCodeEnv(),
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
    else if (this.target.route === 'claude-code') result = { ok: true, detail: `Signed in with Claude through Claude Code (${modelName(this.target.model)})` };
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
    if (t.service === 'custom') {
      if (!t.baseUrl) return null;
      return { name: 'your transcription server', baseUrl: t.baseUrl, key: this.secrets.get(TRANSCRIPTION_SECRET) ?? undefined };
    }
    if (t.service === 'openai') {
      if (!this.gate.detection().installed) return null;
      try {
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
    if (!target) throw new ProviderError('No transcription service is configured. Choose one under Settings → Voice (an OpenAI API key saved in Roamies, or your own Whisper server).', { retryable: false });
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
