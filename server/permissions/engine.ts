import type { Database } from '../db/database.ts';
import type { ActivityLog } from '../core/activity.ts';
import type { EventBus } from '../core/events.ts';
import type { Policy, SettingsStore } from '../core/settings.ts';
import { newId, now, parseJson, redact, sha256, stableStringify, UserError } from '../core/util.ts';
import type { Skill } from '../skills/types.ts';

export interface ScopeDefinition {
  id: string;
  label: string;
  description: string;
  /** External scopes touch things outside Jarvis and default to requiring approval. */
  external: boolean;
  defaultPolicy: Policy;
  /** Consequential scopes can never be set to "allow" globally — only narrow grants. */
  allowPermitted: boolean;
}

export const SCOPES: ScopeDefinition[] = [
  { id: 'internal', label: 'Internal operations', description: 'Notifications, task bookkeeping and system status.', external: false, defaultPolicy: 'allow', allowPermitted: true },
  { id: 'memory.read', label: 'Read memory', description: 'Search and recall stored memories.', external: false, defaultPolicy: 'allow', allowPermitted: true },
  { id: 'memory.write', label: 'Save memory', description: 'Store new (unverified) memories from conversations.', external: false, defaultPolicy: 'allow', allowPermitted: true },
  { id: 'memory.delete', label: 'Delete memory', description: 'Jarvis deleting a memory on its own. (You can always delete memories yourself.)', external: false, defaultPolicy: 'ask', allowPermitted: true },
  { id: 'model', label: 'Use language model', description: 'Send task content to the model picked in Roamies.', external: false, defaultPolicy: 'allow', allowPermitted: true },
  { id: 'files.read', label: 'Read workspace files', description: 'List, read and search files inside the Jarvis workspace folder.', external: true, defaultPolicy: 'allow', allowPermitted: true },
  { id: 'files.write', label: 'Write workspace files', description: 'Create or modify files inside the Jarvis workspace folder.', external: true, defaultPolicy: 'ask', allowPermitted: true },
  { id: 'network.read', label: 'Fetch web pages', description: 'HTTP GET requests to public websites.', external: true, defaultPolicy: 'ask', allowPermitted: true },
  { id: 'email.read', label: 'Read email', description: 'Search and read messages in your mailbox.', external: true, defaultPolicy: 'ask', allowPermitted: true },
  { id: 'email.send', label: 'Send email', description: 'Send messages from your account.', external: true, defaultPolicy: 'ask', allowPermitted: false },
  { id: 'calendar.read', label: 'Read calendar', description: 'List events from your calendars and subscribed feeds.', external: true, defaultPolicy: 'ask', allowPermitted: true },
  { id: 'calendar.write', label: 'Add calendar events', description: 'Create events in your CalDAV calendar.', external: true, defaultPolicy: 'ask', allowPermitted: true },
  { id: 'obsidian.read', label: 'Read Obsidian notes', description: 'Search and read notes in your Obsidian vault.', external: true, defaultPolicy: 'ask', allowPermitted: true },
  { id: 'obsidian.write', label: 'Write Obsidian notes', description: 'Create notes in the Jarvis folder of your vault when you ask (automatic documentation sync is controlled on the Integrations page).', external: true, defaultPolicy: 'ask', allowPermitted: true },
  { id: 'hackerone.read', label: 'Read HackerOne pipeline', description: 'Read your HackerOne earnings and reports and discover programs (read-only).', external: true, defaultPolicy: 'allow', allowPermitted: true },
  { id: 'shell.exec', label: 'Run shell commands', description: 'Execute commands on this computer (inside the workspace folder).', external: true, defaultPolicy: 'ask', allowPermitted: false },
];

export const mcpScope = (serverId: string): string => `mcp.${serverId}`;

export type Decision =
  | { kind: 'allow'; via: 'policy' | 'approval' | 'grant'; approvalId?: string; grantId?: string }
  | { kind: 'ask'; scope: string }
  | { kind: 'deny'; reason: string };

export interface Approval {
  id: string;
  taskId: string;
  stepIndex: number;
  skill: string;
  input: unknown;
  inputHash: string;
  summary: string;
  scope: string;
  status: 'pending' | 'approved' | 'denied' | 'used' | 'expired';
  createdAt: number;
  decidedAt: number | null;
  decisionNote: string | null;
  /** user: you decided; request: covered by what you asked for. */
  decidedBy: 'user' | 'request' | null;
  /** Why this needs your approval (e.g. it is not part of what you asked for). */
  reason: string | null;
}

export interface Grant {
  id: string;
  skill: string;
  inputHash: string;
  description: string;
  createdAt: number;
  expiresAt: number | null;
  uses: number;
  revoked: boolean;
}

export const inputHash = (skill: string, input: unknown): string => sha256(`${skill}\n${stableStringify(input)}`);

export class PermissionEngine {
  private db: Database;
  private settings: SettingsStore;
  private bus: EventBus;
  private activity: ActivityLog;

  constructor(db: Database, settings: SettingsStore, bus: EventBus, activity: ActivityLog) {
    this.db = db;
    this.settings = settings;
    this.bus = bus;
    this.activity = activity;
  }

  private dynamicScopes: () => ScopeDefinition[] = () => [];

  /** Integrations (e.g. MCP servers) contribute their own scopes. */
  setDynamicScopes(provider: () => ScopeDefinition[]): void {
    this.dynamicScopes = provider;
  }

  scopes(): Array<ScopeDefinition & { policy: Policy }> {
    return [...SCOPES, ...this.dynamicScopes()].map((s) => ({ ...s, policy: this.policyFor(s.id) }));
  }

  scopeDefinition(scope: string): ScopeDefinition {
    const known = [...SCOPES, ...this.dynamicScopes()].find((s) => s.id === scope);
    if (known) return known;
    // Unknown scopes (e.g. a newly connected MCP server) are treated as consequential.
    return { id: scope, label: scope, description: 'External integration', external: true, defaultPolicy: 'ask', allowPermitted: true };
  }

  policyFor(scope: string): Policy {
    const def = this.scopeDefinition(scope);
    const configured = this.settings.get().permissions.policies[scope];
    const policy = configured ?? def.defaultPolicy;
    if (policy === 'allow' && !def.allowPermitted) return 'ask';
    return policy;
  }

  validatePolicyPatch(policies: Record<string, unknown>): void {
    for (const [scope, policy] of Object.entries(policies)) {
      const def = this.scopeDefinition(scope);
      if (policy === 'allow' && !def.allowPermitted) {
        throw new UserError(`"${def.label}" cannot be allowed automatically. Approve individual actions instead (you can allow an exact action to repeat).`);
      }
    }
  }

  /** The single authorization check every skill execution goes through. */
  decide(skill: Skill, input: unknown, ctx: { taskId?: string; stepIndex?: number; approvalId?: string }): Decision {
    const policy = this.policyFor(skill.scope);
    if (policy === 'deny') return { kind: 'deny', reason: `Permission "${skill.scope}" is set to deny` };
    if (policy === 'allow') return { kind: 'allow', via: 'policy' };

    const hash = inputHash(skill.name, input);
    if (ctx.approvalId) {
      const approval = this.getApproval(ctx.approvalId);
      const matches = approval && approval.skill === skill.name && approval.inputHash === hash && approval.taskId === ctx.taskId && approval.stepIndex === ctx.stepIndex;
      if (matches && approval.status === 'approved') return { kind: 'allow', via: 'approval', approvalId: approval.id };
      // An automatic retry of a step that is safe to repeat, with byte-identical input, is still
      // covered by the approval the user gave for that step. Non-repeatable steps are never retried.
      if (matches && approval.status === 'used' && skill.idempotent) return { kind: 'allow', via: 'approval' };
    }
    const grant = this.db.get<{ id: string }>(
      'SELECT id FROM grants WHERE skill = ? AND input_hash = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1',
      skill.name,
      hash,
      now(),
    );
    if (grant) return { kind: 'allow', via: 'grant', grantId: grant.id };
    return { kind: 'ask', scope: skill.scope };
  }

  /** Mark an approval as consumed so it cannot authorize a second execution. */
  consume(decision: Decision): void {
    if (decision.kind !== 'allow') return;
    if (decision.approvalId) this.db.run("UPDATE approvals SET status = 'used' WHERE id = ? AND status = 'approved'", decision.approvalId);
    if (decision.grantId) this.db.run('UPDATE grants SET uses = uses + 1 WHERE id = ?', decision.grantId);
  }

  /**
   * The step is part of what the user asked for: their request authorizes it. Recorded as an approval
   * (single-use, bound to this exact input, task and step) so the audit trail shows why it ran.
   */
  approveByRequest(params: { taskId: string; stepIndex: number; skill: Skill; input: unknown; reason: string }): Approval {
    const approval = this.requestApproval({ ...params, silent: true });
    this.db.run("UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = 'request', decision_note = ? WHERE id = ? AND status = 'pending'", now(), params.reason, approval.id);
    this.activity.log('info', 'permissions', `Part of your request, so no extra approval: ${approval.summary}`, { taskId: params.taskId, skill: approval.skill });
    return this.getApproval(approval.id)!;
  }

  requestApproval(params: { taskId: string; stepIndex: number; skill: Skill; input: unknown; reason?: string; silent?: boolean }): Approval {
    const hash = inputHash(params.skill.name, params.input);
    const existing = this.db.get<Record<string, unknown>>(
      "SELECT * FROM approvals WHERE task_id = ? AND step_index = ? AND input_hash = ? AND status IN ('pending', 'approved')",
      params.taskId,
      params.stepIndex,
      hash,
    );
    if (existing) return this.mapApproval(existing);
    const approval: Approval = {
      id: newId('apr'),
      taskId: params.taskId,
      stepIndex: params.stepIndex,
      skill: params.skill.name,
      input: redact(params.input),
      inputHash: hash,
      summary: params.skill.summarize(params.input),
      scope: params.skill.scope,
      status: 'pending',
      createdAt: now(),
      decidedAt: null,
      decisionNote: null,
      decidedBy: null,
      reason: params.reason ?? null,
    };
    this.db.run(
      'INSERT INTO approvals (id, task_id, step_index, skill, input, input_hash, summary, scope, status, created_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      approval.id,
      approval.taskId,
      approval.stepIndex,
      approval.skill,
      JSON.stringify(approval.input),
      hash,
      approval.summary,
      approval.scope,
      'pending',
      approval.createdAt,
      approval.reason,
    );
    if (params.silent) return approval;
    this.activity.log('warning', 'permissions', `Approval needed: ${approval.summary}${approval.reason ? ` — ${approval.reason}` : ''}`, { taskId: approval.taskId, skill: approval.skill });
    this.bus.emit('approval.updated', { id: approval.id, taskId: approval.taskId, status: 'pending' });
    return approval;
  }

  private mapApproval(r: Record<string, unknown>): Approval {
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      stepIndex: Number(r.step_index),
      skill: String(r.skill),
      input: parseJson(r.input as string, null),
      inputHash: String(r.input_hash),
      summary: String(r.summary),
      scope: String(r.scope),
      status: r.status as Approval['status'],
      createdAt: Number(r.created_at),
      decidedAt: r.decided_at === null ? null : Number(r.decided_at),
      decisionNote: (r.decision_note as string | null) ?? null,
      decidedBy: (r.decided_by as Approval['decidedBy']) ?? null,
      reason: (r.reason as string | null) ?? null,
    };
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM approvals WHERE id = ?', id);
    return row ? this.mapApproval(row) : undefined;
  }

  listApprovals(status?: Approval['status'], limit = 100): Approval[] {
    const rows = status
      ? this.db.all<Record<string, unknown>>('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, limit)
      : this.db.all<Record<string, unknown>>('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((r) => this.mapApproval(r));
  }

  approvalForStep(taskId: string, stepIndex: number): Approval | undefined {
    const row = this.db.get<Record<string, unknown>>(
      "SELECT * FROM approvals WHERE task_id = ? AND step_index = ? AND status IN ('pending', 'approved') ORDER BY created_at DESC LIMIT 1",
      taskId,
      stepIndex,
    );
    return row ? this.mapApproval(row) : undefined;
  }

  /**
   * Record the user's decision. `remember` creates a narrowly scoped grant: the same skill with
   * byte-identical input may run again without asking (e.g. for a recurring task), optionally
   * until `expiresInDays`.
   */
  decideApproval(id: string, decision: 'approve' | 'deny', opts: { remember?: boolean; expiresInDays?: number; note?: string } = {}): Approval {
    const approval = this.getApproval(id);
    if (!approval) throw new UserError('Approval not found', 404);
    if (approval.status !== 'pending') throw new UserError(`Approval is already ${approval.status}`, 409);
    const status = decision === 'approve' ? 'approved' : 'denied';
    this.db.run("UPDATE approvals SET status = ?, decided_at = ?, decision_note = ?, decided_by = 'user' WHERE id = ?", status, now(), opts.note ?? null, id);
    if (decision === 'approve' && opts.remember) {
      const scope = this.scopeDefinition(approval.scope);
      this.db.run(
        'INSERT INTO grants (id, skill, input_hash, description, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        newId('grt'),
        approval.skill,
        approval.inputHash,
        `${approval.summary} (${scope.label})`,
        now(),
        opts.expiresInDays ? now() + opts.expiresInDays * 86_400_000 : null,
      );
    }
    this.activity.log(decision === 'approve' ? 'success' : 'info', 'permissions', `${decision === 'approve' ? 'Approved' : 'Denied'}: ${approval.summary}${opts.remember ? ' (exact action remembered)' : ''}`, {
      taskId: approval.taskId,
    });
    this.bus.emit('approval.updated', { id, taskId: approval.taskId, status });
    return this.getApproval(id)!;
  }

  expireApprovalsForTask(taskId: string): void {
    const { changes } = this.db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE task_id = ? AND status IN ('pending', 'approved')", now(), taskId);
    if (changes) this.bus.emit('approval.updated', { taskId, status: 'expired' });
  }

  listGrants(): Grant[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM grants WHERE revoked = 0 ORDER BY created_at DESC')
      .map((r) => ({
        id: String(r.id),
        skill: String(r.skill),
        inputHash: String(r.input_hash),
        description: String(r.description),
        createdAt: Number(r.created_at),
        expiresAt: r.expires_at === null ? null : Number(r.expires_at),
        uses: Number(r.uses),
        revoked: false,
      }));
  }

  revokeGrant(id: string): void {
    const { changes } = this.db.run('UPDATE grants SET revoked = 1 WHERE id = ?', id);
    if (!changes) throw new UserError('Grant not found', 404);
    this.activity.log('info', 'permissions', 'Revoked a remembered authorization', { grantId: id });
  }
}
