// Types for the parts of the vendored Roamies Claude Code bridge (claudecode.mjs) that Jarvis uses.
import type { AgentTool } from '@kenkaiiii/gg-agent';
import type { Message, ThinkingLevel } from '@kenkaiiii/gg-ai';

export interface ClaudeCodeAgentOptions {
  model: string;
  system?: string;
  priorMessages?: Message[];
  tools?: AgentTool[];
  maxTurns?: number;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  executable: string;
  cwd: string;
  env: Record<string, string>;
  resume?: null;
  keepWarm?: boolean;
  /** Test seam: replaces the Claude Agent SDK's query(). */
  query?: (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => AsyncIterable<unknown> & { interrupt(): Promise<void>; close(): void };
}

export interface ClaudeCodeEvent {
  type: string;
  [key: string]: unknown;
}

export interface ClaudeCodeRunResult {
  message: Message & { role: 'assistant' };
  totalTurns: number;
  totalUsage: { inputTokens: number; outputTokens: number };
}

export declare class ClaudeCodeAgent {
  constructor(options: ClaudeCodeAgentOptions);
  getMessages(): Message[];
  setSignal(signal: AbortSignal): void;
  prompt(content: string): AsyncIterable<ClaudeCodeEvent> & PromiseLike<ClaudeCodeRunResult>;
}

export declare function closeSpare(): void;
export declare function effortForThinking(level: ThinkingLevel | undefined): string | undefined;
