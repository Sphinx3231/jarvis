import type { ActivityLog } from '../core/activity.ts';
import type { EventBus } from '../core/events.ts';
import type { SecretStore } from '../core/secrets.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage, now } from '../core/util.ts';
import { HACKERONE_SECRET } from '../integrations/hackerone.ts';
import type { HackerOneService } from '../integrations/hackerone.ts';
import { FISH_SECRET } from '../integrations/fishaudio.ts';
import { findCapabilities, knowledgeSummary } from './knowledge/index.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { TaskStore } from '../tasks/store.ts';

/**
 * Jarvis's sub-agents: small, named specialists that run in the background, each with its own job,
 * its own colour and its own memory (every finding is stored tagged `agent:<id>` so it persists and
 * can be recalled). They are shown as colored satellite cores orbiting the main Jarvis core.
 *
 * They observe and reason over what Jarvis itself can see — the bug-bounty pipeline, its tasks, its
 * memory and its keys. They do NOT watch other apps or the desktop; that would need a capability
 * Jarvis doesn't have, and nothing here pretends otherwise.
 */

export interface AgentContext {
  pipeline: HackerOneService;
  memory: MemoryStore;
  tasks: TaskStore;
  settings: SettingsStore;
  secrets: SecretStore;
  activity: ActivityLog;
  /** Latest one-line summary from each other agent (for the digest agent). */
  peers: () => Record<string, string>;
}

export interface SubAgentDef {
  id: string;
  name: string;
  /** Hex colour for this agent's orb. */
  color: string;
  role: string;
  intervalMs: number;
  run(ctx: AgentContext): Promise<string>;
}

const money = (n: number, c: string) => `${c} ${n.toLocaleString()}`;
const remember = (ctx: AgentContext, id: string, content: string, extraTags: string[] = []) =>
  ctx.memory.add({ kind: 'fact', content: content.slice(0, 4000), source: `agent:${id}`, tags: [`agent:${id}`, ...extraTags], verified: true });

export const SUB_AGENTS: SubAgentDef[] = [
  {
    id: 'friday',
    name: 'Friday',
    color: '#ef4444',
    role: 'Scout — tracks what we earn, what we spend and whether we are in profit.',
    intervalMs: 10 * 60_000,
    async run(ctx) {
      const e = ctx.pipeline.summary().earnings;
      const spend = ctx.settings.get().agents.spendUsd;
      const net = Math.round((e.total - spend) * 100) / 100;
      remember(
        ctx,
        'friday',
        `Profit check: earned ${money(e.total, e.currency)} across ${e.count} bounties; estimated spend ${money(spend, e.currency)}; net ${money(net, e.currency)}. Last 30 days earned ${money(e.last30d, e.currency)}, average bounty ${money(e.averageBounty, e.currency)}.`,
        ['profit'],
      );
      if (net < 0) ctx.activity.log('warning', 'agents', `Friday: running at a loss (net ${money(net, e.currency)})`);
      return net >= 0 ? `In profit: net ${money(net, e.currency)} (${e.count} bounties)` : `At a loss: net ${money(net, e.currency)} — spend exceeds earnings`;
    },
  },
  {
    id: 'tom',
    name: 'Tom',
    color: '#22d3ee',
    role: 'Hunter — finds newly launched, small bug-bounty programs (the ones most likely to still hold unfound bugs).',
    intervalMs: 15 * 60_000,
    async run(ctx) {
      const programs = ctx.pipeline.programs({ bountyOnly: true, limit: 300 });
      // We can't see report counts, so "small & promising" = pays bounties and newly discovered.
      const promising = programs.filter((p) => p.offersBounties && p.isNew);
      for (const p of promising.slice(0, 10)) {
        remember(ctx, 'tom', `Promising program to look at: ${p.name} (${p.handle}) — newly discovered and pays bounties, so likely to have unfound bugs. ${p.url}`, ['program', p.handle]);
      }
      if (!promising.length) return `${programs.length} paying program(s) tracked; no new small ones yet`;
      return `${promising.length} promising new program(s); newest: ${promising[0].name}`;
    },
  },
  {
    id: 'neo',
    name: 'Neo',
    color: '#15803d',
    role: "Monitor — watches Jarvis's pipeline and tasks, keeps the keys, and documents every run.",
    intervalMs: 5 * 60_000,
    async run(ctx) {
      const c = ctx.tasks.counts();
      const fullAccess = ctx.settings.get().permissions.fullAccess;
      const h1 = ctx.secrets.has(HACKERONE_SECRET);
      const fish = ctx.secrets.has(FISH_SECRET);
      const missing = [!h1 ? 'HackerOne token' : null, ctx.settings.get().integrations.hackerone.enabled && !h1 ? null : null].filter(Boolean);
      remember(
        ctx,
        'neo',
        `Pipeline watch: ${c.running} running, ${c.queued} queued, ${c.awaiting_approval} awaiting approval, ${c.completed} completed, ${c.failed} failed. Full access ${fullAccess ? 'ON' : 'off'}. Keys — HackerOne ${h1 ? 'present' : 'MISSING'}, Fish Audio ${fish ? 'present' : 'not set'}.`,
        ['pipeline', 'report'],
      );
      return `Watching ${c.running + c.queued} task(s); keys ${h1 ? 'ok' : 'HackerOne MISSING'}${fullAccess ? '; FULL ACCESS ON' : ''}${missing.length ? '' : ''}`;
    },
  },
  {
    id: 'sentinel',
    name: 'Sentinel',
    color: '#f59e0b',
    role: 'Guard — keeps the list of authorized, in-scope programs so Jarvis never tests out of scope.',
    intervalMs: 30 * 60_000,
    async run(ctx) {
      const programs = ctx.pipeline.programs({ limit: 500 });
      const handles = programs.map((p) => p.handle);
      remember(ctx, 'sentinel', `Authorized, in-scope programs (${handles.length}): ${handles.slice(0, 60).join(', ')}${handles.length > 60 ? '…' : ''}. Only test targets that belong to one of these.`, ['scope']);
      const fullAccess = ctx.settings.get().permissions.fullAccess;
      return `${handles.length} program(s) in scope${fullAccess ? ' — full access on, stay in scope' : ''}`;
    },
  },
  {
    id: 'echo',
    name: 'Echo',
    color: '#a855f7',
    role: 'Reporter — compiles the team’s findings into one running digest.',
    intervalMs: 20 * 60_000,
    async run(ctx) {
      const peers = ctx.peers();
      const lines = Object.entries(peers)
        .filter(([id]) => id !== 'echo')
        .map(([id, s]) => `${id[0].toUpperCase() + id.slice(1)}: ${s}`);
      if (!lines.length) return 'Nothing to report yet';
      remember(ctx, 'echo', `Team digest — ${lines.join(' · ')}`, ['digest']);
      return `Digest of ${lines.length} agent(s) updated`;
    },
  },
  {
    id: 'trinity',
    name: 'Trinity',
    color: '#f43f5e',
    role: 'Operator — the security specialist. Knows all 90 Kali tools and the ethical-hacking methodology; plans and (when authorized) runs live testing against in-scope bug-bounty programs.',
    intervalMs: 30 * 60_000,
    async run(ctx) {
      const ks = knowledgeSummary();
      // Every program Jarvis discovered from HackerOne is a bug-bounty program that authorizes testing
      // within its scope; this is the authorized target set (the methodology's authorization layer).
      const authorized = ctx.pipeline.programs({ bountyOnly: false, limit: 200 });
      const fullAccess = ctx.settings.get().permissions.fullAccess;
      const active = fullAccess && ctx.settings.get().agents.offensive;
      if (!authorized.length) {
        remember(ctx, 'trinity', `Operator armed: ${ks.tools} Kali tools across ${ks.families} capability families and the ethical-hacking methodology are loaded. No authorized in-scope programs yet — waiting for Tom to surface targets.`, ['operator']);
        return `Armed: ${ks.tools} tools / ${ks.families} families; no authorized targets yet`;
      }
      // Prioritise a target Tom newly surfaced, else the first known program. Start lowest-impact.
      const target = authorized.find((p) => p.isNew) ?? authorized[0];
      const caps = findCapabilities('OSINT');
      const first = caps.tools[0];
      remember(
        ctx,
        'trinity',
        `Testing plan for ${target.name} (${target.handle}) — ${target.url}. Start at the lowest impact: ${caps.families[0]?.name ?? 'Asset discovery & OSINT'} using ${first?.name ?? 'passive recon'} (${first?.impact ?? 'low'} impact), then follow Observe → Model → Hypothesize → Test → Validate → Assess → Report → Learn, staying inside the program's scope. Live active testing is ${active ? 'ENABLED' : 'OFF — planning/passive only until full access + offensive mode are on'}.`,
        ['plan', target.handle, active ? 'active' : 'passive'],
      );
      return `${authorized.length} authorized target(s); next: ${first?.name ?? 'passive recon'} on ${target.handle}${active ? ' — live testing ON' : ' — planning only'}`;
    },
  },
];

export interface AgentStatus {
  id: string;
  name: string;
  color: string;
  role: string;
  state: 'idle' | 'working';
  lastRunAt: number | null;
  lastSummary: string;
  runs: number;
  error: string | null;
}

export class SubAgentManager {
  private deps: Omit<AgentContext, 'peers'> & { bus: EventBus };
  private status = new Map<string, AgentStatus>();
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(deps: Omit<AgentContext, 'peers'> & { bus: EventBus }) {
    this.deps = deps;
    for (const a of SUB_AGENTS) this.status.set(a.id, { id: a.id, name: a.name, color: a.color, role: a.role, state: 'idle', lastRunAt: null, lastSummary: 'Not run yet', runs: 0, error: null });
  }

  private ctx(): AgentContext {
    return {
      pipeline: this.deps.pipeline,
      memory: this.deps.memory,
      tasks: this.deps.tasks,
      settings: this.deps.settings,
      secrets: this.deps.secrets,
      activity: this.deps.activity,
      peers: () => Object.fromEntries([...this.status.values()].map((s) => [s.id, s.lastSummary])),
    };
  }

  list(): AgentStatus[] {
    return SUB_AGENTS.map((a) => this.status.get(a.id)!);
  }

  enabled(): boolean {
    return this.deps.settings.get().agents.enabled;
  }

  /** Run one agent now and record its result. */
  async runAgent(id: string): Promise<AgentStatus> {
    const def = SUB_AGENTS.find((a) => a.id === id);
    const st = this.status.get(id);
    if (!def || !st) throw new Error(`No sub-agent "${id}"`);
    if (this.running.has(id)) return st;
    this.running.add(id);
    st.state = 'working';
    this.deps.bus.emit('agents.changed', { id });
    try {
      st.lastSummary = await def.run(this.ctx());
      st.error = null;
    } catch (err) {
      st.error = errorMessage(err);
      st.lastSummary = `Error: ${st.error}`;
      this.deps.activity.log('warning', 'agents', `${def.name} failed: ${st.error}`);
    } finally {
      st.state = 'idle';
      st.lastRunAt = now();
      st.runs++;
      this.running.delete(id);
      this.deps.bus.emit('agents.changed', { id });
    }
    return st;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.enabled() && this.deps.settings.get().background.enabled) {
        const t = now();
        for (const a of SUB_AGENTS) {
          const st = this.status.get(a.id)!;
          if (st.state === 'working') continue;
          if (st.lastRunAt === null || t - st.lastRunAt >= a.intervalMs) void this.runAgent(a.id).catch(() => {});
        }
      }
      this.timer = setTimeout(tick, 60_000);
      this.timer.unref?.();
    };
    // First pass shortly after start so the orbs have data.
    this.timer = setTimeout(tick, 4000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
