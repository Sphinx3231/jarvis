import type { EmbeddingProvider, LlmMessage, LlmProvider, LlmRequest, LlmResponse, StopReason } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * Adapter for any OpenAI-compatible Chat Completions endpoint (OpenAI, Ollama, LM Studio,
 * vLLM, OpenRouter, ...). Uses plain fetch so no extra SDK is needed.
 */
export interface OpenAiCompatOptions {
  id: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

function toChatMessages(system: string, messages: LlmMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool_results') for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.isError ? `ERROR: ${r.content}` : r.content });
    else
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {}),
      });
  }
  return out;
}

function mapFinish(reason: string | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

async function postJson(url: string, body: unknown, opts: { apiKey?: string; timeoutMs: number; signal?: AbortSignal; method?: string }): Promise<unknown> {
  const signals = [AbortSignal.timeout(opts.timeoutMs)];
  if (opts.signal) signals.push(opts.signal);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    throw new ProviderError(`Cannot reach ${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`, { retryable: true });
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = text.slice(0, 300).replace(/\s+/g, ' ');
    throw new ProviderError(`HTTP ${res.status} from ${new URL(url).host}: ${detail}`, {
      retryable: res.status === 401 || res.status === 403 || res.status === 404 || res.status === 408 || res.status === 429 || res.status >= 500,
      status: res.status,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`Invalid JSON from ${new URL(url).host}`, { retryable: true });
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private opts: OpenAiCompatOptions;

  constructor(opts: OpenAiCompatOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.opts = opts;
  }

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toChatMessages(req.system, req.messages),
      max_tokens: req.maxTokens ?? 4096,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    }
    const json = (await postJson(this.url('/chat/completions'), body, { apiKey: this.opts.apiKey, timeoutMs: this.opts.timeoutMs, signal: req.signal })) as {
      model?: string;
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    if (!choice?.message) throw new ProviderError('Provider returned no choices', { retryable: true });
    const toolCalls = (choice.message.tool_calls ?? []).map((c) => {
      let input: unknown = {};
      try {
        input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        input = { __invalid_json: c.function.arguments };
      }
      return { id: c.id, name: c.function.name, input };
    });
    return {
      text: choice.message.content ?? '',
      toolCalls,
      stopReason: toolCalls.length ? 'tool_use' : mapFinish(choice.finish_reason),
      providerId: this.id,
      model: json.model ?? this.model,
      raw: choice.message,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    try {
      const json = (await postJson(this.url('/models'), undefined, { apiKey: this.opts.apiKey, timeoutMs: 10_000, signal, method: 'GET' })) as { data?: Array<{ id: string }> };
      const ids = (json.data ?? []).map((m) => m.id);
      if (ids.length && !ids.some((id) => id === this.model || id.startsWith(`${this.model}:`))) {
        return { ok: false, detail: `Reachable, but model "${this.model}" is not in the provider's model list` };
      }
      return { ok: true, detail: `Reachable${ids.length ? `; ${ids.length} models listed` : ''}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

export class OpenAiCompatibleEmbeddings implements EmbeddingProvider {
  readonly model: string;
  private opts: { baseUrl: string; apiKey?: string };

  constructor(opts: { baseUrl: string; apiKey?: string; model: string }) {
    this.model = opts.model;
    this.opts = opts;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const json = (await postJson(
      `${this.opts.baseUrl.replace(/\/+$/, '')}/embeddings`,
      { model: this.model, input: texts },
      { apiKey: this.opts.apiKey, timeoutMs: 60_000, signal },
    )) as { data?: Array<{ embedding: number[]; index: number }> };
    const data = json.data ?? [];
    if (data.length !== texts.length) throw new ProviderError('Embedding count mismatch', { retryable: false });
    return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
