import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorMessage } from '../core/util.ts';
import type { RoamiesEngine } from '../llm/engine.ts';
import type { LlmMessage, LlmResponse, ToolSpec } from '../llm/types.ts';
import { ProviderError } from '../llm/types.ts';
import { readBody, safeEqual } from '../api/http.ts';

/**
 * Hermes thinks with Jarvis's model. This loopback OpenAI-compatible endpoint
 * (POST /harness/v1/chat/completions) turns each of Hermes's model calls into one call on Jarvis's
 * engine — the model the user picked, with Jarvis's local-only rules and provider workarounds.
 * Only a live Hermes run holds a token for it, and the token dies with the run.
 */

interface OaiToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string };
}
interface OaiMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | null | Array<{ type: string; text?: string }>;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}
interface OaiTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

const textOf = (c: OaiMessage['content']): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('') : '');

const parseArgs = (raw: string): unknown => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { _raw: raw };
  }
};

/** OpenAI chat messages → Jarvis's provider-neutral request. */
export function fromOpenAi(messages: OaiMessage[], tools?: OaiTool[]): { system: string; messages: LlmMessage[]; tools?: ToolSpec[] } {
  const system: string[] = [];
  const out: LlmMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') system.push(textOf(m.content));
    else if (m.role === 'user') out.push({ role: 'user', content: textOf(m.content) });
    else if (m.role === 'assistant') {
      out.push({ role: 'assistant', text: textOf(m.content), toolCalls: (m.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) })) });
    } else if (m.role === 'tool') {
      const result = { toolCallId: String(m.tool_call_id ?? ''), content: textOf(m.content) };
      const last = out[out.length - 1];
      if (last?.role === 'tool_results') last.results.push(result);
      else out.push({ role: 'tool_results', results: [result] });
    }
  }
  const specs = tools?.filter((t) => t.type === 'function').map((t) => ({ name: t.function.name, description: t.function.description ?? '', inputSchema: t.function.parameters ?? { type: 'object', properties: {} } }));
  return { system: system.join('\n\n'), messages: out, tools: specs?.length ? specs : undefined };
}

/** Jarvis's model answer → an OpenAI chat.completion. */
export function toOpenAi(res: LlmResponse, model: string) {
  const toolCalls = res.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
  const finish = toolCalls.length ? 'tool_calls' : res.stopReason === 'max_tokens' ? 'length' : 'stop';
  return {
    id: `chatcmpl-${randomBytes(6).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: res.text || (toolCalls.length ? null : ''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
    usage: { prompt_tokens: res.usage?.inputTokens ?? 0, completion_tokens: res.usage?.outputTokens ?? 0, total_tokens: (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0) },
  };
}

/** The same answer as server-sent chunks, for clients that ask to stream (Hermes always does). */
export function toOpenAiStream(res: LlmResponse, model: string, includeUsage: boolean): string {
  const full = toOpenAi(res, model);
  const base = { id: full.id, object: 'chat.completion.chunk', created: full.created, model };
  const msg = full.choices[0].message;
  const chunks: unknown[] = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(msg.content ? { content: msg.content } : {}) }, finish_reason: null }] }];
  if ('tool_calls' in msg && msg.tool_calls) chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: msg.tool_calls.map((tc, index) => ({ index, ...tc })) }, finish_reason: null }] });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: full.choices[0].finish_reason }] });
  if (includeUsage) chunks.push({ ...base, choices: [], usage: full.usage });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

export interface ModelGrant {
  token: string;
  runId: string;
  /** Model calls made under this grant (for the task's record). */
  calls: number;
  signal: AbortSignal;
  /** Jarvis's own description of the last model failure in this run (clearer than Hermes's wording). */
  lastError: string | null;
}

/** A busy local model server can miss a health check; wait this long for it before telling Hermes. */
const MODEL_PATIENCE_MS = 120_000;

export class HarnessModelEndpoint {
  private grants = new Map<string, ModelGrant>();
  private engine: RoamiesEngine;

  constructor(engine: RoamiesEngine) {
    this.engine = engine;
  }

  /** A token that lets one Hermes run call the model until it is revoked. */
  grant(runId: string, signal: AbortSignal): ModelGrant {
    const g: ModelGrant = { token: `hrn_${randomBytes(24).toString('hex')}`, runId, calls: 0, signal, lastError: null };
    this.grants.set(g.token, g);
    return g;
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  /** Handles /harness/v1/*; returns false for any other path. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith('/harness/v1/')) return false;
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const grant = [...this.grants.values()].find((g) => safeEqual(auth, g.token));
    if (!grant) {
      send(401, { error: { message: 'No live harness run holds this token', type: 'invalid_request_error' } });
      return true;
    }
    const model = this.engine.activeProvider()?.model ?? 'jarvis';
    if (req.method === 'GET' && path === '/harness/v1/models') {
      send(200, { object: 'list', data: [{ id: model, object: 'model', owned_by: 'jarvis' }] });
      return true;
    }
    if (req.method !== 'POST' || path !== '/harness/v1/chat/completions') {
      send(404, { error: { message: 'Not found', type: 'invalid_request_error' } });
      return true;
    }
    let body: { messages?: OaiMessage[]; tools?: OaiTool[]; stream?: boolean; max_tokens?: number; max_completion_tokens?: number; stream_options?: { include_usage?: boolean } };
    try {
      body = ((await readBody(req, 8_000_000)) ?? {}) as typeof body;
    } catch (err) {
      send(400, { error: { message: errorMessage(err), type: 'invalid_request_error' } });
      return true;
    }
    if (!Array.isArray(body.messages)) {
      send(400, { error: { message: 'messages is required', type: 'invalid_request_error' } });
      return true;
    }
    grant.calls++;
    const call = fromOpenAi(body.messages, body.tools);
    let out: LlmResponse | null = null;
    const deadline = Date.now() + MODEL_PATIENCE_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        out = await this.engine.completeOnce({ ...call, maxTokens: body.max_completion_tokens ?? body.max_tokens, signal: grant.signal });
        grant.lastError = null;
        break;
      } catch (err) {
        const retryable = err instanceof ProviderError && err.retryable;
        grant.lastError = errorMessage(err);
        // Hermes gives up after a few quick retries; a local server that is busy (or a moment from
        // being reachable again) usually answers within a minute or two, so Jarvis waits for it here.
        if (retryable && !grant.signal.aborted && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, Math.min(15_000, 2_000 * 2 ** attempt)));
          if (!grant.signal.aborted) continue;
        }
        send(retryable ? 503 : 400, { error: { message: grant.lastError, type: retryable ? 'server_error' : 'invalid_request_error' } });
        return true;
      }
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(toOpenAiStream(out, out.model, Boolean(body.stream_options?.include_usage)));
    } else send(200, toOpenAi(out, out.model));
    return true;
  }
}
