import type { z } from 'zod';
import type { ActivityLog } from '../core/activity.ts';
import type { SettingsStore } from '../core/settings.ts';
import type { RoamiesEngine } from '../llm/engine.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { AgentName } from '../agents/agents.ts';

/**
 * internal       — only touches Jarvis's own state (memory, tasks, notifications)
 * read           — reads external data (files, web) without changing anything
 * write          — changes external state in a recoverable way (writing a file)
 * consequential  — actions with real-world side effects (running commands, third-party tools)
 */
export type RiskLevel = 'internal' | 'read' | 'write' | 'consequential';

export interface SkillServices {
  memory: MemoryStore;
  settings: SettingsStore;
  activity: ActivityLog;
  llm: RoamiesEngine;
  workspaceDir: () => string;
  listTasks: (status?: string) => Array<{ id: string; title: string; status: string; priority: number; progress: number }>;
  pipeline: import('../integrations/hackerone.ts').HackerOneService;
  computer: import('../computer/manager.ts').ComputerAccessManager;
  statusSnapshot: () => Record<string, unknown>;
}

export interface SkillContext {
  agent: AgentName;
  taskId?: string;
  stepIndex?: number;
  conversationId?: string;
  signal: AbortSignal;
  services: SkillServices;
}

export interface Verification {
  ok: boolean;
  detail: string;
}

export interface Skill<I = any, O = any> {
  name: string;
  title: string;
  description: string;
  category: 'memory' | 'tasks' | 'system' | 'model' | 'files' | 'web' | 'shell' | 'email' | 'calendar' | 'mcp' | 'pipeline';
  /** Permission scope checked by the permission engine before every execution. */
  scope: string;
  risk: RiskLevel;
  /** Safe to run again if a previous attempt's outcome is unknown (e.g. after a crash). */
  idempotent: boolean;
  /** May be called directly inside a chat turn (read-only/internal) when its policy is "allow". */
  inlineSafe: boolean;
  /** Output contains content from outside Jarvis (web pages, files, tool output) — treat as data. */
  untrustedOutput: boolean;
  input: z.ZodType<I>;
  /** JSON Schema shown to models and the UI. Derived from `input` when omitted. */
  inputJsonSchema?: Record<string, unknown>;
  outputDescription: string;
  timeoutMs?: number;
  /** Integration this skill depends on, shown on the Skills page. */
  dependsOn?: string;
  availability(services: SkillServices): { available: boolean; reason?: string };
  /** One-line human description of what this call will do (shown in approval prompts). */
  summarize(input: I): string;
  /** Resources that must not be touched concurrently (e.g. a file path). */
  lockKey?(input: I): string | null;
  execute(input: I, ctx: SkillContext): Promise<O>;
  /** Independent check that the action actually did what it claims. */
  verify(input: I, output: O, ctx: SkillContext): Promise<Verification>;
  /** Short text rendering of the output for task results and model context. */
  describe(output: O): string;
}
