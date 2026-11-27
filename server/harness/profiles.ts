import { SUB_AGENTS } from '../agents/subagents.ts';
import type { Skill } from '../skills/types.ts';

/**
 * Who a Hermes run works as. Jarvis (the coordinator) or one of the six named agents: the run gets
 * that agent's role as its brief and only the Jarvis skills that agent is allowed to use. The agents'
 * own background jobs stay native (see agents/subagents.ts); this is how they take on a task.
 *
 * An allow-list here only narrows what the model is offered. Every call still goes through the skill
 * runner and the permission engine, so it can never widen what is permitted.
 */
export interface HarnessProfile {
  id: string;
  name: string;
  brief: string;
  allows(skill: Skill): boolean;
}

const only = (...names: string[]) => (s: Skill) => names.includes(s.name);
/** Offensive tooling and report filing are Trinity's authority alone. */
const SECURITY_ONLY = new Set(['security.operate', 'hackerone.submit_report']);
/** The harness is the model loop already; it never calls the model as a tool. */
const NEVER = new Set(['llm.generate']);

const roleOf = (id: string) => SUB_AGENTS.find((a) => a.id === id)?.role ?? '';

export const PROFILES: Record<string, HarnessProfile> = {
  jarvis: {
    id: 'jarvis',
    name: 'Jarvis',
    brief: 'You are working as Jarvis, the user\'s personal AI operating system, carrying out a task the user asked for.',
    allows: (s) => !SECURITY_ONLY.has(s.name),
  },
  friday: {
    id: 'friday',
    name: 'Friday',
    brief: `You are working as Friday, Jarvis's ${roleOf('friday')}`,
    allows: only('hackerone.earnings', 'hackerone.reports', 'hackerone.programs', 'memory.search', 'memory.remember', 'tasks.list', 'system.status', 'notify.user'),
  },
  tom: {
    id: 'tom',
    name: 'Tom',
    brief: `You are working as Tom, Jarvis's ${roleOf('tom')}`,
    allows: only('hackerone.programs', 'hackerone.scopes', 'web.fetch', 'memory.search', 'memory.remember', 'notify.user'),
  },
  neo: {
    id: 'neo',
    name: 'Neo',
    brief: `You are working as Neo, Jarvis's ${roleOf('neo')}`,
    allows: only('tasks.list', 'system.status', 'computer.telemetry', 'computer.capabilities', 'files.list', 'files.read', 'files.search', 'memory.search', 'memory.remember', 'notify.user'),
  },
  sentinel: {
    id: 'sentinel',
    name: 'Sentinel',
    brief: `You are working as Sentinel, Jarvis's ${roleOf('sentinel')}`,
    allows: only('hackerone.scopes', 'hackerone.programs', 'memory.search', 'memory.remember', 'notify.user'),
  },
  echo: {
    id: 'echo',
    name: 'Echo',
    brief: `You are working as Echo, Jarvis's ${roleOf('echo')}`,
    allows: only('memory.search', 'memory.remember', 'tasks.list', 'hackerone.reports', 'obsidian.search', 'obsidian.read', 'obsidian.write_note', 'notify.user'),
  },
  trinity: {
    id: 'trinity',
    name: 'Trinity',
    brief: `You are working as Trinity, Jarvis's ${roleOf('trinity')} Only ever test programs that Sentinel lists as authorized and in scope; anything live needs the user's approval.`,
    allows: only(
      'security.toolkit',
      'security.operate',
      'hackerone.programs',
      'hackerone.scopes',
      'hackerone.reports',
      'hackerone.submit_report',
      'web.fetch',
      'files.read',
      'files.write',
      'memory.search',
      'memory.remember',
      'notify.user',
    ),
  },
};

export const PROFILE_IDS = Object.keys(PROFILES);

export function profileFor(owner: string | null | undefined): HarnessProfile {
  return (owner && PROFILES[owner]) || PROFILES.jarvis;
}

/** The skills a profile may be offered: allowed by the profile, never the model itself, and available now. */
export function skillsFor(profile: HarnessProfile, all: Skill[], available: (s: Skill) => boolean): Skill[] {
  return all.filter((s) => !NEVER.has(s.name) && profile.allows(s) && available(s));
}
