import type { Database } from '../db/database.ts';
import type { ActivityLog } from '../core/activity.ts';
import { errorMessage, now, redact, TimeoutError, truncate, withTimeout } from '../core/util.ts';
import { AGENTS, type AgentName } from '../agents/agents.ts';
import type { PermissionEngine } from '../permissions/engine.ts';
import type { SkillRegistry } from './registry.ts';
import type { SkillServices, Verification } from './types.ts';

export type InvokeResult =
  | { status: 'ok'; output: unknown; verification: Verification; description: string; untrusted: boolean; durationMs: number }
  | { status: 'needs_approval'; scope: string; summary: string }
  | { status: 'denied'; reason: string }
  | { status: 'failed'; error: string; retryable: boolean; durationMs: number };

export interface InvokeRequest {
  agent: AgentName;
  skill: string;
  input: unknown;
  taskId?: string;
  stepIndex?: number;
  conversationId?: string;
  approvalId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The only code path that executes skills. Order of checks:
 *   1. skill exists and is available  2. agent role may use it  3. input validates
 *   4. permission engine decision     5. execute with timeout/cancellation
 *   6. verification agent check       7. audit log entry
 */
export class SkillRunner {
  private db: Database;
  private registry: SkillRegistry;
  private permissions: PermissionEngine;
  private services: SkillServices;
  private activity: ActivityLog;
  private defaultTimeoutMs: () => number;

  constructor(opts: {
    db: Database;
    registry: SkillRegistry;
    permissions: PermissionEngine;
    services: SkillServices;
    activity: ActivityLog;
    defaultTimeoutMs: () => number;
  }) {
    this.db = opts.db;
    this.registry = opts.registry;
    this.permissions = opts.permissions;
    this.services = opts.services;
    this.activity = opts.activity;
    this.defaultTimeoutMs = opts.defaultTimeoutMs;
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const skill = this.registry.get(req.skill);
    if (!skill) return this.refuse(req, 'denied', `Unknown skill "${req.skill}"`);
    const availability = this.registry.availability(skill);
    if (!availability.available) return this.fail(req, `${skill.name} is unavailable: ${availability.reason ?? 'not configured'}`, false, 0);
    const role = AGENTS[req.agent];
    if (!role.canInvoke(skill)) return this.refuse(req, 'denied', `${role.title} is not permitted to use ${skill.name}`);

    const parsed = skill.input.safeParse(req.input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return this.fail(req, `Invalid input for ${skill.name}: ${issue.path.join('.') || 'input'} — ${issue.message}`, false, 0);
    }
    const input = parsed.data;

    const decision = this.permissions.decide(skill, input, { taskId: req.taskId, stepIndex: req.stepIndex, approvalId: req.approvalId });
    if (decision.kind === 'deny') return this.refuse(req, 'denied', decision.reason);
    if (decision.kind === 'ask') {
      this.audit(req, input, 'ask', 'awaiting_approval', null, null);
      return { status: 'needs_approval', scope: decision.scope, summary: skill.summarize(input) };
    }
    // Consume single-use approvals before running so a crash can never replay them.
    this.permissions.consume(decision);

    const controller = new AbortController();
    const onAbort = () => controller.abort(req.signal?.reason);
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const started = now();
    const ctx = { agent: req.agent, taskId: req.taskId, stepIndex: req.stepIndex, conversationId: req.conversationId, signal: controller.signal, services: this.services, explicitlyApproved: decision.kind === 'allow' && decision.via === 'approval' && Boolean(decision.approvalId) && this.permissions.getApproval(decision.approvalId!)?.decidedBy === 'user' };
    try {
      if (req.signal?.aborted) throw req.signal.reason ?? new Error('Cancelled');
      const timeout = req.timeoutMs ?? skill.timeoutMs ?? this.defaultTimeoutMs();
      const output = await withTimeout(timeout, controller, () => skill.execute(input, ctx));
      let verification: Verification;
      try {
        verification = await skill.verify(input, output, ctx);
      } catch (err) {
        verification = { ok: false, detail: `Verification error: ${errorMessage(err)}` };
      }
      const durationMs = now() - started;
      this.audit(req, input, `allow:${decision.via}`, verification.ok ? 'success' : 'unverified', verification.ok, null, durationMs, decision);
      if (!verification.ok) {
        return { status: 'failed', error: `Result could not be verified: ${verification.detail}`, retryable: skill.idempotent, durationMs };
      }
      return { status: 'ok', output, verification, description: skill.describe(output), untrusted: skill.untrustedOutput, durationMs };
    } catch (err) {
      const durationMs = now() - started;
      const cancelled = req.signal?.aborted ?? false;
      const msg = cancelled ? `Cancelled: ${errorMessage(req.signal?.reason ?? 'cancelled')}` : errorMessage(err);
      this.audit(req, input, `allow:${decision.via}`, cancelled ? 'cancelled' : err instanceof TimeoutError ? 'timeout' : 'error', null, msg, durationMs, decision);
      return { status: 'failed', error: msg, retryable: !cancelled && skill.idempotent, durationMs };
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  private refuse(req: InvokeRequest, status: 'denied', reason: string): InvokeResult {
    this.audit(req, req.input, 'deny', 'denied', null, reason);
    this.activity.log('warning', 'permissions', `Blocked ${req.skill} for ${req.agent}: ${reason}`, { taskId: req.taskId });
    return { status, reason };
  }

  private fail(req: InvokeRequest, error: string, retryable: boolean, durationMs: number): InvokeResult {
    this.audit(req, req.input, 'n/a', 'error', null, error, durationMs);
    return { status: 'failed', error, retryable, durationMs };
  }

  private audit(
    req: InvokeRequest,
    input: unknown,
    decision: string,
    outcome: string,
    verified: boolean | null,
    error: string | null,
    durationMs?: number,
    d?: { kind: string; approvalId?: string; grantId?: string },
  ): void {
    this.db.run(
      'INSERT INTO audit_log (ts, actor, skill, task_id, input, decision, approval_id, grant_id, outcome, verified, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      now(),
      req.agent,
      req.skill,
      req.taskId ?? null,
      truncate(JSON.stringify(redact(input) ?? null), 4000),
      decision,
      d?.approvalId ?? null,
      d?.grantId ?? null,
      outcome,
      verified === null ? null : verified ? 1 : 0,
      durationMs ?? null,
      error ? truncate(String(redact(error)), 1000) : null,
    );
  }
}
