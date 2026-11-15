import type { ActivityLog } from '../core/activity.ts';
import type { EventBus } from '../core/events.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage } from '../core/util.ts';
import type { RoamiesEngine } from '../llm/engine.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { HackerOneService, ProgramRow, Severity, SubmitResult } from '../integrations/hackerone.ts';
import { SEVERITIES } from '../integrations/hackerone.ts';
import type { SkillRunner } from '../skills/runner.ts';

/**
 * The autonomous bug-bounty orchestrator.
 *
 * It drives the whole loop by composing the pieces that already exist — Tom/Sentinel surface the
 * in-scope programs, security.operate (the local model + the Kali arsenal) does the testing, Trinity
 * records findings, and the HackerOne service submits behind its two fail-closed gates. It is NOT a
 * new agent or a second scheduler; one cycle is: pick the next in-scope target → test it → draft a
 * report from a validated finding → submit it (scope- and authorization-gated) → move to the next.
 *
 * Nothing here is a model guardrail. The authorization layer (Full access + Offensive + Auto-hunt to
 * run; + Auto-submit to ship) is what the user turns on to say "go", and the in-scope gate keeps
 * every submission inside a program's rules.
 */

export interface CycleResult {
  ran: boolean;
  reason: string;
  target: string | null;
  tested: boolean;
  submitted: boolean;
  held: boolean;
  reportId: string | null;
  draftTitle: string | null;
}

export interface OrchestratorStatus {
  authorized: { canHunt: boolean; canSubmit: boolean; reason: string };
  lastCycle: (CycleResult & { at: number }) | null;
  cyclesRun: number;
  targetsHunted: number;
}

interface Deps {
  pipeline: HackerOneService;
  llm: RoamiesEngine;
  settings: SettingsStore;
  activity: ActivityLog;
  memory: MemoryStore;
  bus: EventBus;
  runner: SkillRunner;
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class BountyOrchestrator {
  private deps: Deps;
  private huntedAt = new Map<string, number>();
  private lastCycle: (CycleResult & { at: number }) | null = null;
  private cyclesRun = 0;
  private running = false;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** What the configured switches permit right now. */
  authorization(): { canHunt: boolean; canSubmit: boolean; reason: string } {
    const cfg = this.deps.settings.get();
    const missing: string[] = [];
    if (!cfg.agents.enabled) missing.push('sub-agents');
    if (!cfg.permissions.fullAccess) missing.push('Full access');
    if (!cfg.agents.offensive) missing.push('Offensive mode');
    if (!cfg.agents.autoHunt) missing.push('Autonomous hunting');
    const canHunt = missing.length === 0;
    const canSubmit = canHunt && cfg.agents.autoSubmit;
    const reason = canHunt ? (canSubmit ? 'Hunting and auto-submitting.' : 'Hunting; reports are drafted but held until Auto-submit is on.') : `Paused — needs: ${missing.join(', ')}.`;
    return { canHunt, canSubmit, reason };
  }

  status(): OrchestratorStatus {
    return { authorized: this.authorization(), lastCycle: this.lastCycle, cyclesRun: this.cyclesRun, targetsHunted: this.huntedAt.size };
  }

  /** The next program to work, round-robin by least-recently hunted, preferring new & paying ones. */
  nextTarget(): ProgramRow | null {
    const progs = this.deps.pipeline.programs({ limit: 500 });
    if (!progs.length) return null;
    const scored = progs
      .map((p) => ({ p, last: this.huntedAt.get(p.handle) ?? 0 }))
      .sort((a, b) => a.last - b.last || Number(b.p.isNew) - Number(a.p.isNew) || Number(b.p.offersBounties) - Number(a.p.offersBounties));
    const pick = scored[0].p;
    this.huntedAt.set(pick.handle, Date.now());
    return pick;
  }

  /** Validated findings Trinity has recorded for a program (plain memories tagged with the handle). */
  findingsFor(handle: string): string[] {
    return this.deps.memory
      .list({ kind: 'fact', limit: 2000 })
      .filter((m) => m.tags.includes(handle) && m.tags.includes('finding'))
      .map((m) => m.content);
  }

  /** Ask the local model to turn findings into a submittable report, constrained to an in-scope asset. */
  private async draftReport(target: ProgramRow, findings: string[], signal: AbortSignal): Promise<{ title: string; severity: Severity; asset: string; vulnerabilityInformation: string; impact?: string } | null> {
    const eligible = this.deps.pipeline.scopes(target.handle).filter((s) => s.eligible).map((s) => s.identifier);
    if (!eligible.length) return null;
    const system = [
      'You write a single HackerOne vulnerability report from verified findings. You never invent a vulnerability that the findings do not support.',
      `In-scope assets (use exactly one, verbatim, as "asset"): ${eligible.join(', ')}.`,
      'Reply with ONLY a JSON object: {"report": true|false, "title": "...", "severity": "none|low|medium|high|critical", "asset": "<one in-scope asset>", "vulnerability_information": "<full writeup: summary, steps to reproduce, PoC, remediation>", "impact": "<impact>"}.',
      'Set report=false if the findings do not justify a real, in-scope report.',
    ].join('\n');
    const prompt = `Program: ${target.name} (${target.handle}) ${target.url}\n\nVerified findings:\n${findings.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
    let text: string;
    try {
      const res = await this.deps.llm.generate({ system, prompt, maxTokens: 1500, signal });
      if (res.stopReason === 'refusal') return null;
      text = res.text;
    } catch {
      return null;
    }
    const j = extractJson(text);
    if (!j || j.report === false) return null;
    const severity = String(j.severity ?? '').toLowerCase();
    const asset = String(j.asset ?? '').trim();
    const title = String(j.title ?? '').trim();
    const info = String(j.vulnerability_information ?? '').trim();
    if (!title || !asset || info.length < 10 || !SEVERITIES.includes(severity as Severity)) return null;
    return { title: title.slice(0, 300), severity: severity as Severity, asset, vulnerabilityInformation: info, impact: String(j.impact ?? '').trim() || undefined };
  }

  /** Run one full cycle. Safe to call manually or from the scheduler. */
  async runCycle(opts: { skipTesting?: boolean; signal?: AbortSignal } = {}): Promise<CycleResult> {
    const signal = opts.signal ?? AbortSignal.timeout(20 * 60_000);
    const none = (reason: string, extra: Partial<CycleResult> = {}): CycleResult => ({ ran: false, reason, target: null, tested: false, submitted: false, held: false, reportId: null, draftTitle: null, ...extra });
    if (this.running) return none('A cycle is already running.');
    const auth = this.authorization();
    if (!auth.canHunt) return this.finish(none(auth.reason));
    if (this.deps.pipeline.missing()) return this.finish(none(`Pipeline not ready: ${this.deps.pipeline.missing()}`));

    this.running = true;
    try {
      const target = this.nextTarget();
      if (!target) return this.finish(none('No programs in the pipeline yet.'));
      this.deps.activity.log('info', 'agents', `Autonomous hunt: working ${target.handle}`);
      await this.deps.pipeline.ensureScopes(target.handle, signal).catch(() => {});

      let tested = false;
      // Testing: hand the program to the operator (security.operate) for a live pass. Under Full
      // access the permission engine allows it; findings land in Trinity's memory.
      if (!opts.skipTesting) {
        try {
          await this.deps.runner.invoke({ agent: 'executor', skill: 'security.operate', input: { program: target.handle, execute: true, maxSteps: 3 } });
          tested = true;
        } catch (err) {
          this.deps.activity.log('warning', 'agents', `Operator pass failed on ${target.handle}: ${errorMessage(err)}`);
        }
      }

      const findings = this.findingsFor(target.handle);
      if (!findings.length) return this.finish({ ran: true, reason: `No reportable finding for ${target.handle} yet.`, target: target.handle, tested, submitted: false, held: false, reportId: null, draftTitle: null });

      const draft = await this.draftReport(target, findings, signal);
      if (!draft) return this.finish({ ran: true, reason: `Findings for ${target.handle} did not justify an in-scope report.`, target: target.handle, tested, submitted: false, held: false, reportId: null, draftTitle: null });

      let result: SubmitResult;
      try {
        result = await this.deps.pipeline.submitReport({ program: target.handle, ...draft }, { autonomous: true, signal });
      } catch (err) {
        return this.finish({ ran: true, reason: `Submission error: ${errorMessage(err)}`, target: target.handle, tested, submitted: false, held: false, reportId: null, draftTitle: draft.title });
      }
      this.deps.memory.add({
        kind: 'fact',
        content: `[${target.handle}] Autonomous report ${result.ok ? `SUBMITTED${result.reportId ? ` #${result.reportId}` : ''}` : `HELD`}: "${draft.title}" (${draft.severity}, asset ${draft.asset}). ${result.reason}`.slice(0, 4000),
        source: 'agent:trinity',
        tags: ['agent:trinity', target.handle, 'submission', result.ok ? 'submitted' : 'held'],
        verified: result.ok,
      });
      return this.finish({ ran: true, reason: result.reason, target: target.handle, tested, submitted: result.ok, held: result.held, reportId: result.reportId, draftTitle: draft.title });
    } finally {
      this.running = false;
    }
  }

  private finish(r: CycleResult): CycleResult {
    this.lastCycle = { ...r, at: Date.now() };
    if (r.ran) this.cyclesRun++;
    this.deps.bus.emit('pipeline.updated', { cycle: true });
    return r;
  }
}
