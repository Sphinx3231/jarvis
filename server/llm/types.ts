/** Provider-neutral shapes used by Jarvis. Each adapter converts to/from its native API. */

export interface ToolSpec {
  /** Wire-safe name ([a-zA-Z0-9_-]); skill names like "memory.search" are encoded as "memory__search". */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'tool_results'; results: ToolResult[] }
  | {
      role: 'assistant';
      text: string;
      toolCalls: ToolCall[];
      /** Native content from the provider that produced it (e.g. Claude thinking blocks), replayed unchanged. */
      raw?: { providerId: string; content: unknown };
    };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  providerId: string;
  model: string;
  raw: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** Cheap reachability/auth check that does not run a model inference. */
  healthCheck(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** Errors worth trying another provider for (network, rate limit, overload, auth misconfiguration). */
export class ProviderError extends Error {
  retryable: boolean;
  status?: number;
  constructor(message: string, opts: { retryable: boolean; status?: number }) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

export const encodeToolName = (skill: string): string => skill.replace(/\./g, '__');
export const decodeToolName = (name: string): string => name.replace(/__/g, '.');
