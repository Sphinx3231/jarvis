import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.ts';
import type { EventBus } from '../core/events.ts';
import type { CriticalFinding } from './guard.ts';

/**
 * What Jarvis is doing on this computer right now, and what it has done.
 *
 *  - A small state machine (IDLE → OBSERVING/ANALYZING/PLANNING/INTERACTING/VERIFYING/LEARNING →
 *    COMPLETED/ERROR, plus WAITING_FOR_APPROVAL and PAUSED) that the UI shows as the live indicator.
 *  - A persistent action log (`computer_actions`) — every observe/control/browser action with its
 *    outcome, verification and whether it was critical. It survives restarts and backs the panel's
 *    "recent actions" list.
 *  - Pending confirmations for critical actions. A confirmation authorizes one exact action
 *    (by fingerprint), once, for a short time — a web page can't create or approve one, only the
 *    user via the authenticated local API/UI.
 */

export type ComputerState =
  | 'IDLE'
  | 'OBSERVING'
  | 'ANALYZING'
  | 'PLANNING'
  | 'INTERACTING'
  | 'VERIFYING'
  | 'LEARNING'
  | 'WAITING_FOR_APPROVAL'
  | 'PAUSED'
  | 'COMPLETED'
  | 'ERROR';

export interface ComputerActionRecord {
  id: number;
  ts: number;
  kind: string;
  target: string | null;
  detail: string;
  outcome: 'ok' | 'failed' | 'blocked' | 'needs_confirmation' | 'cancelled' | 'unverified';
  verified: boolean | null;
  critical: string | null;
  task: string | null;
  durationMs: number | null;
}

export interface PendingConfirmation {
  id: string;
  fingerprint: string;
  kind: string;
  summary: string;
  finding: CriticalFinding;
  createdAt: number;
  status: 'pending' | 'approved' | 'denied' | 'used' | 'expired';
}

export interface LiveStatus {
  state: ComputerState;
  task: string | null;
  detail: string | null;
  activeApp: string | null;
  learningSession: { id: string; course: string; lesson: string | null } | null;
  since: number;
  pendingConfirmations: PendingConfirmation[];
}

const CONFIRM_TTL_MS = 5 * 60_000;

export class ComputerActivity {
  private db: Database | null;
  private bus: EventBus;
  private live: Omit<LiveStatus, 'pendingConfirmations'> = { state: 'IDLE', task: null, detail: null, activeApp: null, learningSession: null, since: Date.now() };
  private confirmations = new Map<string, PendingConfirmation>();
  /** In-memory fallback when no DB (unit tests). */
  private memLog: ComputerActionRecord[] = [];

  constructor(opts: { db?: Database | null; bus: EventBus }) {
    this.db = opts.db ?? null;
    this.bus = opts.bus;
  }

  setState(state: ComputerState, patch: Partial<Omit<LiveStatus, 'state' | 'since' | 'pendingConfirmations'>> = {}): void {
    const changed = state !== this.live.state;
    this.live = { ...this.live, ...patch, state, since: changed ? Date.now() : this.live.since };
    this.bus.emit('computer.changed', { state, task: this.live.task });
  }

  setActiveApp(app: string | null): void {
    if (app === this.live.activeApp) return;
    this.live.activeApp = app;
  }

  setLearning(session: LiveStatus['learningSession']): void {
    this.live.learningSession = session;
    this.bus.emit('computer.changed', { learning: session ? session.course : null });
  }

  state(): ComputerState {
    return this.live.state;
  }

  status(): LiveStatus {
    this.expireConfirmations();
    return { ...this.live, pendingConfirmations: [...this.confirmations.values()].filter((c) => c.status === 'pending') };
  }

  record(entry: Omit<ComputerActionRecord, 'id' | 'ts'> & { ts?: number }): ComputerActionRecord {
    const ts = entry.ts ?? Date.now();
    const clip = (s: string | null, n: number) => (s === null ? null : s.slice(0, n));
    let id = this.memLog.length + 1;
    if (this.db) {
      const res = this.db.run(
        'INSERT INTO computer_actions (ts, kind, target, detail, outcome, verified, critical, task, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ts,
        entry.kind,
        clip(entry.target, 300),
        entry.detail.slice(0, 1000),
        entry.outcome,
        entry.verified === null ? null : entry.verified ? 1 : 0,
        entry.critical,
        clip(entry.task, 300),
        entry.durationMs,
      );
      id = Number(res.lastInsertRowid);
    }
    const rec: ComputerActionRecord = { id, ts, kind: entry.kind, target: clip(entry.target, 300), detail: entry.detail.slice(0, 1000), outcome: entry.outcome, verified: entry.verified, critical: entry.critical, task: clip(entry.task, 300), durationMs: entry.durationMs };
    if (!this.db) {
      this.memLog.push(rec);
      if (this.memLog.length > 500) this.memLog.shift();
    }
    this.bus.emit('computer.changed', { action: rec.kind, outcome: rec.outcome });
    return rec;
  }

  recent(limit = 50): ComputerActionRecord[] {
    if (!this.db) return this.memLog.slice(-limit).reverse();
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM computer_actions ORDER BY id DESC LIMIT ?', Math.min(500, Math.max(1, limit)))
      .map((r) => ({
        id: Number(r.id),
        ts: Number(r.ts),
        kind: String(r.kind),
        target: (r.target as string | null) ?? null,
        detail: String(r.detail),
        outcome: r.outcome as ComputerActionRecord['outcome'],
        verified: r.verified === null || r.verified === undefined ? null : Number(r.verified) === 1,
        critical: (r.critical as string | null) ?? null,
        task: (r.task as string | null) ?? null,
        durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
      }));
  }

  // ------------------------------------------------------------- confirmations

  private expireConfirmations(): void {
    const cutoff = Date.now() - CONFIRM_TTL_MS;
    for (const c of this.confirmations.values()) if (c.status === 'pending' && c.createdAt < cutoff) c.status = 'expired';
    for (const [id, c] of this.confirmations) if (c.status !== 'pending' && c.createdAt < cutoff - CONFIRM_TTL_MS) this.confirmations.delete(id);
  }

  /**
   * Is this exact critical action confirmed? Consumes the confirmation (single use). Otherwise creates
   * (or reuses) a pending confirmation and returns it so the caller can stop and ask the user.
   */
  checkConfirmation(fingerprint: string, kind: string, summary: string, finding: CriticalFinding): { confirmed: true } | { confirmed: false; pending: PendingConfirmation } {
    this.expireConfirmations();
    for (const c of this.confirmations.values()) {
      if (c.fingerprint === fingerprint && c.status === 'approved') {
        c.status = 'used';
        return { confirmed: true };
      }
    }
    for (const c of this.confirmations.values()) if (c.fingerprint === fingerprint && c.status === 'pending') return { confirmed: false, pending: c };
    const pending: PendingConfirmation = { id: randomUUID(), fingerprint, kind, summary: summary.slice(0, 300), finding, createdAt: Date.now(), status: 'pending' };
    this.confirmations.set(pending.id, pending);
    this.bus.emit('computer.changed', { confirmation: pending.id });
    return { confirmed: false, pending };
  }

  /** The user's decision. Only reachable from the authenticated local API / UI. */
  decide(id: string, approve: boolean): PendingConfirmation | null {
    this.expireConfirmations();
    const c = this.confirmations.get(id);
    if (!c || c.status !== 'pending') return null;
    c.status = approve ? 'approved' : 'denied';
    // Approval stays valid for the TTL from now, so the agent can re-issue the action.
    c.createdAt = Date.now();
    this.bus.emit('computer.changed', { confirmation: id, decision: c.status });
    return c;
  }

  /** STOP / toggle-off: every pending confirmation is void. */
  clearConfirmations(): void {
    for (const c of this.confirmations.values()) if (c.status === 'pending' || c.status === 'approved') c.status = 'expired';
  }
}
