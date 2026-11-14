import type { Skill } from '../skills/types.ts';

/**
 * Specialised roles with explicit boundaries. The central coordinator (Jarvis) assigns each
 * task step to one role; the skill runner refuses any skill outside that role's allowlist, and
 * every call still passes through the permission engine — no role can bypass it.
 */
export type AgentName = 'jarvis' | 'planner' | 'researcher' | 'executor' | 'memory' | 'verifier';

export interface AgentDefinition {
  name: AgentName;
  title: string;
  responsibility: string;
  canInvoke(skill: Skill): boolean;
}

export const AGENTS: Record<AgentName, AgentDefinition> = {
  jarvis: {
    name: 'jarvis',
    title: 'Jarvis (coordinator)',
    responsibility: 'Understands requests, retrieves context, delegates work and answers the user. Inside a conversation it may only use read-only/internal skills directly; everything else becomes a task.',
    canInvoke: (s) => s.inlineSafe,
  },
  planner: {
    name: 'planner',
    title: 'Planning agent',
    responsibility: 'Breaks a request into a validated plan of skill steps. Plans only — never executes.',
    canInvoke: () => false,
  },
  researcher: {
    name: 'researcher',
    title: 'Research agent',
    responsibility: 'Gathers information: reads files, fetches web pages, searches memory and summarises with the model. Read-only.',
    canInvoke: (s) => s.risk === 'internal' || s.risk === 'read',
  },
  executor: {
    name: 'executor',
    title: 'Execution agent',
    responsibility: 'Performs actions that change things (writing files, running commands, external tools) after authorization.',
    canInvoke: () => true,
  },
  memory: {
    name: 'memory',
    title: 'Memory agent',
    responsibility: 'Stores, organises and deduplicates long-term memory; records task history.',
    canInvoke: (s) => s.category === 'memory',
  },
  verifier: {
    name: 'verifier',
    title: 'Verification agent',
    responsibility: 'Independently checks every step result before a task is reported as successful.',
    canInvoke: () => false,
  },
};

/** Least-privileged role that can run a skill. */
export function assignAgent(skill: Skill): AgentName {
  if (skill.category === 'memory') return 'memory';
  if (skill.risk === 'internal' || skill.risk === 'read') return 'researcher';
  return 'executor';
}
