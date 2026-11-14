import Anthropic from '@anthropic-ai/sdk';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, StopReason } from './types.ts';
import { ProviderError } from './types.ts';

export interface AnthropicOptions {
  id: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  serverSideFallback: boolean;
  timeoutMs: number;
}

/** Models that accept `output_config.effort` (Sonnet 4.5 / Haiku 4.5 and older reject it). */
export function supportsEffort(model: string): boolean {
  return /claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model) || /claude-opus-4-[5-8]/.test(model) || /claude-sonnet-4-6/.test(model);
}

/** Models that support the server-side refusal fallback chain (`fallbacks: "default"`). */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(fable-5-[12]|opus-5-5|opus-5|sonnet-5-5)$/.test(model);
}

function toAnthropicMessages(messages: LlmMessage[], providerId: string): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'tool_results') {
      // All results for one assistant turn go back in a single user message.
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolCallId,
          content: r.content,
          is_error: r.isError ?? false,
        })),
      });
    } else if (m.raw && m.raw.providerId === providerId) {
      // Replay native content (thinking blocks included) unchanged.
      out.push({ role: 'assistant', content: m.raw.content as Anthropic.Beta.BetaContentBlockParam[] });
    } else {
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input as Record<string, unknown> });
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no content)' }] });
    }
  }
  return out;
}

function mapStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private client: Anthropic;
  private opts: AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.opts = opts;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      // Explicit so an unrelated ANTHROPIC_BASE_URL in the environment never redirects traffic.
      baseURL: opts.baseUrl || 'https://api.anthropic.com',
      maxRetries: 2,
      timeout: opts.timeoutMs,
    });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      // Stable system prompt first so it can be served from the prompt cache.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(req.messages, this.id),
    };
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      }));
    }
    if (supportsEffort(this.model)) params.output_config = { effort: this.opts.effort };
    if (this.opts.serverSideFallback && supportsServerFallback(this.model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(params, { signal: req.signal });
    } catch (err) {
      throw classifyError(err);
    }

    let text = '';
    const toolCalls: LlmResponse['toolCalls'] = [];
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    return {
      text,
      toolCalls,
      stopReason: mapStop(response.stop_reason),
      providerId: this.id,
      model: response.model,
      raw: response.content,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    try {
      const model = await this.client.models.retrieve(this.model, {}, { signal });
      return { ok: true, detail: `Reachable; model ${model.id} available` };
    } catch (err) {
      const e = classifyError(err);
      return { ok: false, detail: e.message };
    }
  }
}

function classifyError(err: unknown): ProviderError {
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError('Anthropic rejected the API key', { retryable: true, status: 401 });
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError('Anthropic denied access to this model', { retryable: true, status: 403 });
  if (err instanceof Anthropic.NotFoundError) return new ProviderError('Model not found on Anthropic', { retryable: true, status: 404 });
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('Anthropic rate limit reached', { retryable: true, status: 429 });
  if (err instanceof Anthropic.BadRequestError) return new ProviderError(`Anthropic rejected the request: ${err.message}`, { retryable: false, status: 400 });
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`Cannot reach Anthropic: ${err.message}`, { retryable: true });
  if (err instanceof Anthropic.APIError) return new ProviderError(`Anthropic API error ${err.status}: ${err.message}`, { retryable: (err.status ?? 500) >= 500, status: err.status });
  if (err instanceof Error && err.name === 'AbortError') return new ProviderError('Request aborted', { retryable: false });
  return new ProviderError(err instanceof Error ? err.message : String(err), { retryable: true });
}
