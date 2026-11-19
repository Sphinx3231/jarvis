import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LlmMessage, StopReason, ToolSpec } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * OpenJarvis — Jarvis's local brain and voice (https://github.com/open-jarvis/OpenJarvis).
 *
 * OpenJarvis runs on this computer (`jarvis serve`, default http://127.0.0.1:8000). It picks and runs
 * local models (Ollama / llama.cpp / vLLM …) and exposes:
 *   - POST /v1/chat/completions   OpenAI-compatible; client-supplied `tools` are passed straight to the
 *                                  model and its tool calls come back verbatim (Jarvis runs the tools,
 *                                  so every action still goes through Jarvis's permission engine)
 *   - GET  /v1/models, /health, /v1/info
 *   - POST /v1/speech/transcribe  local speech-to-text (faster-whisper)
 *   - POST /v1/speech/synthesize  local text-to-speech (Kokoro) → WAV
 *
 * Nothing here talks to a cloud service: no API keys, no tokens billed, no usage limits.
 */

export interface OpenJarvisModel {
  id: string;
  ownedBy: string | null;
}

export interface OpenJarvisHealth {
  reachable: boolean;
  detail: string;
  models: OpenJarvisModel[];
  speech: { available: boolean; detail: string } | null;
  tts: { available: boolean; detail: string; voiceId: string | null } | null;
}

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** Cloud model ids OpenJarvis can route to; refused when Jarvis is in local-only mode. */
const CLOUD_MODEL = /^(gpt-|o[1-9]|chatgpt|claude|gemini|grok|openai\/|anthropic\/|google\/|xai\/|openrouter\/|deepseek-chat|mistral-(large|medium)|command-r)/i;

/** Who serves a model in OpenJarvis's list. Local engines run on this computer; the rest are cloud catalogues. */
const LOCAL_OWNERS = new Set(['openjarvis', 'ollama', 'llamacpp', 'llama.cpp', 'vllm', 'sglang', 'lmstudio', 'mlx', 'exo', 'nexa', 'uzu', 'apple_fm', 'gemma_cpp', 'local']);

/**
 * Is this a cloud model? By its owner when OpenJarvis says (e.g. "nim" = NVIDIA's hosted catalogue,
 * "openai", "anthropic"…), otherwise by its id. Anything unknown is treated as cloud in local-only mode.
 */
export function isCloudModel(model: string, ownedBy?: string | null): boolean {
  if (ownedBy) return !LOCAL_OWNERS.has(ownedBy.toLowerCase());
  return CLOUD_MODEL.test(model.trim());
}

/** Only this computer or the local network: Jarvis never sends its brain traffic to the internet. */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (['localhost', '127.0.0.1', '::1'].includes(h)) return true;
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(h)) return true;
    return h.endsWith('.local') || h.endsWith('.lan');
  } catch {
    return false;
  }
}

function toOpenAi(system: string, messages: LlmMessage[], prompted = false): OaiMessage[] {
  const out: OaiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (prompted) {
        // Models without native tool calling see their own calls as the text they wrote.
        const calls = m.toolCalls.map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.input ?? {} })}</tool_call>`).join('\n');
        out.push({ role: 'assistant', content: [m.text, calls].filter(Boolean).join('\n') || '(no content)' });
      } else {
        out.push({
          role: 'assistant',
          content: m.text || '', // OpenJarvis requires a string even when the turn is only tool calls
          ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
        });
      }
    } else if (prompted) {
      out.push({ role: 'user', content: m.results.map((r) => `<tool_result id="${r.toolCallId}"${r.isError ? ' error="true"' : ''}>\n${r.content}\n</tool_result>`).join('\n') });
    } else for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.isError ? `ERROR: ${r.content}` : r.content });
  }
  return out;
}

/** The tool catalogue written into the prompt for models that can't take tools natively. */
export function promptedToolsInstructions(tools: ToolSpec[]): string {
  const list = tools.map((t) => `- ${t.name}: ${t.description.slice(0, 300)}\n  arguments (JSON Schema): ${JSON.stringify(t.inputSchema)}`).join('\n');
  return [
    '',
    '# Tools',
    'You can use these tools. To use one, reply with ONLY this, nothing else:',
    '<tool_call>{"name": "<tool name>", "arguments": { ... }}</tool_call>',
    'You will get the result in a <tool_result> message; then continue. When you have the answer, reply normally without any <tool_call>.',
    '',
    list,
  ].join('\n');
}

/** What the local engine (Ollama) says a model can do — from /api/show. */
export interface ModelCapabilities {
  tools: boolean;
  thinking: boolean;
  vision: boolean;
  contextLength: number | null;
  family: string | null;
  parameterSize: string | null;
}

/** Ask Ollama what a model supports. Never throws; null when the engine isn't Ollama or can't be reached. */
export async function ollamaCapabilities(engineUrl: string, model: string, fetchImpl: typeof fetch = fetch): Promise<ModelCapabilities | null> {
  try {
    const res = await fetchImpl(`${engineUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const d = (await res.json()) as { capabilities?: string[]; model_info?: Record<string, unknown>; details?: { family?: string; parameter_size?: string } };
    const caps = d.capabilities ?? [];
    const ctxKey = Object.keys(d.model_info ?? {}).find((k) => k.endsWith('.context_length'));
    return {
      tools: caps.includes('tools'),
      thinking: caps.includes('thinking'),
      vision: caps.includes('vision'),
      contextLength: ctxKey ? Number(d.model_info![ctxKey]) || null : null,
      family: d.details?.family ?? null,
      parameterSize: d.details?.parameter_size ?? null,
    };
  } catch {
    return null;
  }
}

/** Some local models put <think>…</think> reasoning in the content; Jarvis only shows the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

/**
 * Local models sometimes write the tool call as JSON text instead of a structured call. Recover the
 * common shapes so a small model can still act — never invents a call that isn't in the text.
 */
export function recoverTextToolCalls(text: string, tools: ToolSpec[]): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  if (!tools.length) return [];
  const names = new Set(tools.map((t) => t.name));
  const out: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const blocks = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((m) => m[1]);
  const fenced = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]);
  for (const raw of [...blocks, ...fenced, ...(blocks.length || fenced.length ? [] : [text.trim()])]) {
    try {
      const v = JSON.parse(raw) as { name?: string; arguments?: unknown; parameters?: unknown };
      if (v && typeof v.name === 'string' && names.has(v.name)) {
        const args = typeof v.arguments === 'string' ? JSON.parse(v.arguments) : (v.arguments ?? v.parameters ?? {});
        out.push({ id: `call_${out.length}_${Date.now().toString(36)}`, name: v.name, input: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> });
      }
    } catch {
      /* not a tool call */
    }
  }
  return out;
}

export class OpenJarvisClient {
  readonly baseUrl: string;
  fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.fetchImpl = fetchImpl;
  }

  private async json<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    let res: Response;
    try {
      const signal = init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 10_000);
      // Node's fetch gives up when response headers take over 5 minutes, which a slow local model
      // easily does on a long answer. Long calls go over node:http, bounded only by our own timeout.
      const long = (init.timeoutMs ?? 0) > 290_000 && typeof init.body === 'string' && this.fetchImpl === fetch;
      res = long ? await longPost(`${this.baseUrl}${path}`, init.body as string, (init.headers ?? {}) as Record<string, string>, signal) : await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal });
    } catch (err) {
        if (init.signal?.aborted || (err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') throw new ProviderError(`The local model at ${this.baseUrl} did not answer in time (${(err as Error).message}).`, { retryable: false });
      throw new ProviderError(`The brain server isn't reachable at ${this.baseUrl} (${(err as Error).message}). Start OpenJarvis (\`jarvis serve\`) or Ollama, or run the Jarvis local setup.`, { retryable: true });
    }
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`OpenJarvis ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`, { retryable: res.status >= 500 || res.status === 429, status: res.status });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError(`OpenJarvis ${path} returned something that isn't JSON.`, { retryable: false });
    }
  }

  async models(signal?: AbortSignal): Promise<OpenJarvisModel[]> {
    const r = await this.json<{ data?: Array<{ id: string; owned_by?: string }> }>('/v1/models', { signal });
    return (r.data ?? []).map((m) => ({ id: m.id, ownedBy: m.owned_by ?? null }));
  }

  /** Is OpenJarvis up, which models does it serve, and is its local voice ready? Never throws. */
  async health(): Promise<OpenJarvisHealth> {
    try {
      await this.json('/health', { timeoutMs: 4000 });
    } catch (err) {
      return { reachable: false, detail: (err as Error).message, models: [], speech: null, tts: null };
    }
    const models = await this.models().catch(() => []);
    const speech = await this.json<{ available?: boolean; reason?: string; backend?: string }>('/v1/speech/health', { timeoutMs: 6000 })
      .then((s) => ({ available: Boolean(s.available), detail: s.available ? `speech-to-text: ${s.backend ?? 'local'}` : (s.reason ?? 'not configured') }))
      .catch((e: Error) => ({ available: false, detail: e.message }));
    const tts = await this.json<{ available?: boolean; reason?: string; backend?: string; voice_id?: string }>('/v1/speech/tts/health', { timeoutMs: 6000 })
      .then((s) => ({ available: Boolean(s.available), detail: s.available ? `voice: ${s.backend ?? 'kokoro'}` : (s.reason ?? 'not configured'), voiceId: s.voice_id ?? null }))
      .catch((e: Error & { status?: number }) => ({ available: false, detail: e.status === 404 ? 'this OpenJarvis version has no voice endpoint (newer than 1.0.4 needed) — re-run the local setup' : e.message, voiceId: null }));
    const local = models.filter((m) => !isCloudModel(m.id, m.ownedBy));
    const cloud = models.length - local.length;
    const detail = `OpenJarvis at ${this.baseUrl}${local.length ? ` — local: ${local.map((m) => m.id).slice(0, 4).join(', ')}` : ' — no local model yet'}${cloud ? ` (${cloud} cloud catalogue model${cloud === 1 ? '' : 's'} hidden; they need API keys)` : ''}`;
    return { reachable: true, detail, models, speech, tts };
  }

  /** One model turn (OpenAI-compatible). Tools are the client's (Jarvis's) — they come back as calls. */
  async complete(req: { model: string; system: string; messages: LlmMessage[]; tools?: ToolSpec[]; maxTokens?: number; temperature?: number; signal?: AbortSignal; promptedTools?: boolean }): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>; stopReason: StopReason; usage: { inputTokens: number; outputTokens: number }; model: string; empty: boolean }> {
    const prompted = Boolean(req.promptedTools && req.tools?.length);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAi(prompted ? req.system + promptedToolsInstructions(req.tools!) : req.system, req.messages, prompted),
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.3,
      stream: false,
    };
    if (req.tools?.length && !prompted) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const r = await this.json<{
      model?: string;
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: req.signal, timeoutMs: 900_000 });
    const choice = r.choices?.[0];
    const raw = choice?.message?.content ?? '';
    let toolCalls = (choice?.message?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c, i) => {
        let input: Record<string, unknown> = {};
        const a = c.function!.arguments;
        if (typeof a === 'string') {
          try {
            input = a.trim() ? JSON.parse(a) : {};
          } catch {
            input = {};
          }
        } else if (a && typeof a === 'object') input = a;
        return { id: c.id || `call_${i}_${Date.now().toString(36)}`, name: c.function!.name!, input };
      });
    if (!toolCalls.length && req.tools?.length && raw) toolCalls = recoverTextToolCalls(stripThinking(raw), req.tools);
    const text = toolCalls.length && recoverTextToolCalls(stripThinking(raw), req.tools ?? []).length ? '' : stripThinking(raw);
    const finish = choice?.finish_reason ?? 'stop';
    const stopReason: StopReason = toolCalls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end';
    return { text, toolCalls, stopReason, usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 }, model: r.model ?? req.model, empty: !text.trim() && !toolCalls.length };
  }

  /** Local speech-to-text (faster-whisper inside OpenJarvis). */
  async transcribe(audio: Buffer, mimeType: string, opts: { language?: string; signal?: AbortSignal } = {}): Promise<{ text: string; language: string | null }> {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${ext}`);
    if (opts.language) form.append('language', opts.language.split('-')[0]);
    const r = await this.json<{ text?: string; language?: string }>('/v1/speech/transcribe', { method: 'POST', body: form, signal: opts.signal, timeoutMs: 180_000 });
    return { text: (r.text ?? '').trim(), language: r.language ?? null };
  }

  /** Local text-to-speech (Kokoro inside OpenJarvis). Returns WAV bytes. */
  async synthesize(text: string, opts: { voiceId?: string; speed?: number; signal?: AbortSignal } = {}): Promise<{ audio: Buffer; mime: string; voiceId: string | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/speech/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 4000), ...(opts.voiceId ? { voice_id: opts.voiceId } : {}), ...(opts.speed ? { speed: opts.speed } : {}) }),
        signal: opts.signal ?? AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new ProviderError(`OpenJarvis voice isn't reachable at ${this.baseUrl} (${(err as Error).message}).`, { retryable: true });
    }
    if (res.status === 404) throw new ProviderError('This OpenJarvis has no speaking voice yet (its /v1/speech/synthesize endpoint is newer than release 1.0.4). Re-run the Jarvis local setup, which installs a version with Kokoro voice.', { retryable: false, status: 404 });
    if (!res.ok) throw new ProviderError(`OpenJarvis voice failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`, { retryable: res.status >= 500 });
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 44) throw new ProviderError('OpenJarvis returned no audio.', { retryable: false });
    return { audio, mime: res.headers.get('content-type')?.split(';')[0] || 'audio/wav', voiceId: res.headers.get('x-voice-id') };
  }
}

/** POST over node:http(s) with no header timeout (only `signal` ends it), returned as a fetch Response. */
function longPost(url: string, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 })));
      res.on('error', reject);
    });
    const onAbort = () => req.destroy(Object.assign(new Error(String((signal.reason as Error)?.message ?? 'aborted')), { name: (signal.reason as Error)?.name ?? 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal.removeEventListener('abort', onAbort));
    req.on('error', reject);
    req.end(body);
  });
}
