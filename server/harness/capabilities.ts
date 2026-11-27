import type { PermissionEngine } from '../permissions/engine.ts';
import { jsonSchemaOf, type SkillRegistry } from '../skills/registry.ts';
import type { Skill } from '../skills/types.ts';
import { PROFILES, skillsFor } from './profiles.ts';

/**
 * The unified capability view: every action Jarvis can take, wherever it comes from, with the
 * facts that decide who may use it. It is a view over the one skill registry (native skills and MCP
 * tools are both registered there), not a second registry: execution always goes through the skill
 * runner and the permission engine.
 *
 * Hermes's own tools and OpenJarvis's are deliberately not capabilities here — see `sources`.
 */
export interface Capability {
  id: string;
  name: string;
  /** jarvis = built into Jarvis; mcp = a tool from a connected MCP server. */
  source: 'jarvis' | 'mcp';
  provider: string | null;
  description: string;
  category: Skill['category'];
  inputSchema: Record<string, unknown>;
  output: string;
  risk: Skill['risk'];
  scope: string;
  scopeLabel: string;
  /** allow / ask / deny — the user's policy for this scope. */
  policy: string;
  /** Some inputs (send, pay, delete, install…) always need the user's own approval. */
  hasCriticalInputs: boolean;
  timeoutMs: number | null;
  /** Every skill runs under an AbortSignal; whether the action itself can be undone is separate. */
  cancellable: true;
  idempotent: boolean;
  runsOn: 'this computer' | 'external service';
  untrustedOutput: boolean;
  available: boolean;
  unavailableReason: string | null;
  /** Agent identities whose Hermes runs are offered this capability. */
  offeredTo: string[];
}

const EXTERNAL = new Set<Skill['category']>(['web', 'email', 'calendar', 'pipeline']);

export function listCapabilities(registry: SkillRegistry, permissions: PermissionEngine, agent?: string | null): Capability[] {
  const all = registry.all();
  const offered = new Map<string, string[]>();
  for (const p of Object.values(PROFILES)) for (const s of skillsFor(p, all, () => true)) offered.set(s.name, [...(offered.get(s.name) ?? []), p.id]);
  return all
    .map((s): Capability => {
      const a = registry.availability(s);
      return {
        id: s.name,
        name: s.title,
        source: s.category === 'mcp' ? 'mcp' : 'jarvis',
        provider: s.category === 'mcp' ? (s.dependsOn ?? null) : null,
        description: s.description,
        category: s.category,
        inputSchema: jsonSchemaOf(s),
        output: s.outputDescription,
        risk: s.risk,
        scope: s.scope,
        scopeLabel: permissions.scopeDefinition(s.scope).label,
        policy: permissions.policyFor(s.scope),
        hasCriticalInputs: typeof s.critical === 'function',
        timeoutMs: s.timeoutMs ?? null,
        cancellable: true,
        idempotent: s.idempotent,
        runsOn: s.category === 'mcp' || EXTERNAL.has(s.category) ? 'external service' : 'this computer',
        untrustedOutput: s.untrustedOutput,
        available: a.available,
        unavailableReason: a.available ? null : (a.reason ?? 'Unavailable'),
        offeredTo: offered.get(s.name) ?? [],
      };
    })
    .filter((c) => !agent || c.offeredTo.includes(agent));
}

/** Where capabilities could come from, and what Jarvis does with each source. */
export const CAPABILITY_SOURCES = [
  { id: 'jarvis', label: 'Jarvis skills', use: 'Native skills, run by Jarvis\'s skill runner under the permission engine.' },
  { id: 'mcp', label: 'MCP servers', use: 'Tools of connected MCP servers, registered as skills: same runner, same permissions.' },
  {
    id: 'hermes',
    label: 'Hermes Agent tools',
    use: 'Not used. Hermes runs the agent loop only; its own tools (terminal, files, browser, memory, skills, cron, delegation and the rest) are never given to it. It gets Jarvis skills instead.',
  },
  {
    id: 'openjarvis',
    label: 'OpenJarvis',
    use: 'Used as Jarvis\'s local model and voice (chat, speech-to-text, text-to-speech). Its own agents, tools, schedulers and memory are not used, because Jarvis and Hermes already own those roles.',
  },
] as const;
