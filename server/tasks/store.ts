import type { Database } from '../db/database.ts';
import type { EventBus } from '../core/events.ts';
import { newId, now, parseJson, truncate, UserError } from '../core/util.ts';
import type { AgentName } from '../agents/agents.ts';

export const TASK_STATUSES = ['queued', 'running', 'paused', 'awaiting_approval', 'completed', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const ACTIVE_STATUSES: TaskStatus[] = ['queued', 'running', 'paused', 'awaiting_approval'];

export type StepStatus = 'pending' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'skipped' | 'uncertain';

export interface PlanStep {
  skill: string;
  input: Record<string, unknown>;
  description: string;
  agent: AgentName;
  status: StepStatus;
  attempts: number;
  output?: unknown;
  outputText?: string;
  untrusted?: boolean;
  verification?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface Recurrence {
  everyMinutes?: number;
  dailyAt?: string;
}

export interface TaskResult {
  summary: string;
  verified: boolean;
  completedSteps: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: TaskStatus;
  origin: 'user' | 'chat' | 'voice' | 'schedule' | 'system';
  agent: string | null;
  conversationId: string | null;
  plan: PlanStep[] | null;
  currentStep: number;
  progress: number;
  result: TaskResult | null;
  error: string | null;
  /** Why the task needs the user's attention (e.g. uncertain outcome after a crash). */
  attention: string | null;
  attempts: number;
  maxAttempts: number;
  requiredPermissions: string[];
  scheduledFor: number | null;
  recurrence: Recurrence | null;
  parentId: string | null;
  dedupeKey: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  heartbeatAt: number | null;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  ts: number;
  type: string;
  message: string;
  data: unknown;
}

export const PRIORITY_LABELS: Record<number, string> = { 1: 'low', 2: 'normal', 3: 'high', 4: 'urgent' };

const MAX_STORED_OUTPUT = 60_000;

/** Keep persisted step outputs bounded so the database doesn't balloon. */
export function boundOutput(output: unknown): unknown {
  const json = JSON.stringify(output ?? null);
  if (json.length <= MAX_STORED_OUTPUT) return output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
      copy[k] = typeof v === 'string' ? truncate(v, 20_000) : v;
    }
    if (JSON.stringify(copy).length <= MAX_STORED_OUTPUT) return copy;
  }
  return { truncated: true, preview: truncate(json, 20_000) };
}

export class TaskStore {
  private db: Database;
  private bus: EventBus;

  constructor(db: Database, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  private map(r: Record<string, unknown>): Task {
    return {
      id: String(r.id),
      title: String(r.title),
      description: String(r.description),
      priority: Number(r.priority),
      status: r.status as TaskStatus,
      origin: r.origin as Task['origin'],
      agent: (r.agent as string | null) ?? null,
      conversationId: (r.conversation_id as string | null) ?? null,
      plan: parseJson<PlanStep[] | null>(r.plan as string | null, null),
      currentStep: Number(r.current_step),
      progress: Number(r.progress),
      result: parseJson<TaskResult | null>(r.result as string | null, null),
      error: (r.error as string | null) ?? null,
      attention: (r.attention as string | null) ?? null,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      requiredPermissions: parseJson<string[]>(r.required_permissions as string, []),
      scheduledFor: r.scheduled_for === null ? null : Number(r.scheduled_for),
      recurrence: parseJson<Recurrence | null>(r.recurrence as string | null, null),
      parentId: (r.parent_id as string | null) ?? null,
      dedupeKey: (r.dedupe_key as string | null) ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      startedAt: r.started_at === null ? null : Number(r.started_at),
      finishedAt: r.finished_at === null ? null : Number(r.finished_at),
      heartbeatAt: r.heartbeat_at === null ? null : Number(r.heartbeat_at),
    };
  }

  create(t: {
    title: string;
    description?: string;
    priority?: number;
    origin: Task['origin'];
    conversationId?: string | null;
    plan: PlanStep[] | null;
    requiredPermissions?: string[];
    scheduledFor?: number | null;
    recurrence?: Recurrence | null;
    parentId?: string | null;
    dedupeKey?: string | null;
    maxAttempts?: number;
  }): Task {
    const id = newId('tsk');
    const ts = now();
    this.db.run(
      `INSERT INTO tasks (id, title, description, priority, status, origin, conversation_id, plan, required_permissions, scheduled_for, recurrence, parent_id, dedupe_key, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      t.title.slice(0, 200),
      (t.description ?? '').slice(0, 4000),
      Math.min(4, Math.max(1, t.priority ?? 2)),
      t.origin,
      t.conversationId ?? null,
      t.plan ? JSON.stringify(t.plan) : null,
      JSON.stringify(t.requiredPermissions ?? []),
      t.scheduledFor ?? null,
      t.recurrence ? JSON.stringify(t.recurrence) : null,
      t.parentId ?? null,
      t.dedupeKey ?? null,
      t.maxAttempts ?? 2,
      ts,
      ts,
    );
    this.addEvent(id, 'created', t.scheduledFor && t.scheduledFor > ts ? `Task created, scheduled for ${new Date(t.scheduledFor).toLocaleString()}` : 'Task created and queued');
    const task = this.get(id)!;
    this.bus.emit('task.updated', { id, status: task.status });
    return task;
  }

  get(id: string): Task | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', id);
    return row ? this.map(row) : undefined;
  }

  require(id: string): Task {
    const t = this.get(id);
    if (!t) throw new UserError('Task not found', 404);
    return t;
  }

  findActiveByDedupeKey(key: string): Task | undefined {
    const row = this.db.get<Record<string, unknown>>(
      `SELECT * FROM tasks WHERE dedupe_key = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) LIMIT 1`,
      key,
      ...ACTIVE_STATUSES,
    );
    return row ? this.map(row) : undefined;
  }

  list(opts: { status?: TaskStatus | 'active'; limit?: number } = {}): Task[] {
    const limit = opts.limit ?? 200;
    if (!opts.status) return this.db.all<Record<string, unknown>>('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?', limit).map((r) => this.map(r));
    const statuses = opts.status === 'active' ? ACTIVE_STATUSES : [opts.status];
    return this.db
      .all<Record<string, unknown>>(
        `SELECT * FROM tasks WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY priority DESC, created_at DESC LIMIT ?`,
        ...statuses,
        limit,
      )
      .map((r) => this.map(r));
  }

  counts(): Record<TaskStatus, number> {
    const out = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const r of this.db.all<{ status: TaskStatus; n: number }>('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')) out[r.status] = Number(r.n);
    return out;
  }

  update(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Task {
    const cols: Record<string, string> = {
      title: 'title',
      description: 'description',
      priority: 'priority',
      status: 'status',
      agent: 'agent',
      plan: 'plan',
      currentStep: 'current_step',
      progress: 'progress',
      result: 'result',
      error: 'error',
      attention: 'attention',
      attempts: 'attempts',
      maxAttempts: 'max_attempts',
      requiredPermissions: 'required_permissions',
      scheduledFor: 'scheduled_for',
      recurrence: 'recurrence',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      heartbeatAt: 'heartbeat_at',
    };
    const jsonCols = new Set(['plan', 'result', 'requiredPermissions', 'recurrence']);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      params.push(jsonCols.has(k) ? (v === null ? null : JSON.stringify(v)) : (v as string | number | null));
    }
    sets.push('updated_at = ?');
    params.push(now());
    this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    const task = this.require(id);
    this.bus.emit('task.updated', { id, status: task.status, progress: task.progress });
    return task;
  }

  /** Atomically move a queued, due task to running. Returns null if someone else got it first. */
  claim(id: string): Task | null {
    const ts = now();
    const { changes } = this.db.run(
      "UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?), heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
      ts,
      ts,
      ts,
      id,
    );
    if (!changes) return null;
    const task = this.require(id);
    this.bus.emit('task.updated', { id, status: task.status });
    return task;
  }

  /** Queued tasks that are due, highest priority first. */
  due(limit: number, exclude: Set<string>): Task[] {
    return this.db
      .all<Record<string, unknown>>(
        "SELECT * FROM tasks WHERE status = 'queued' AND (scheduled_for IS NULL OR scheduled_for <= ?) ORDER BY priority DESC, created_at ASC LIMIT ?",
        now(),
        limit + exclude.size,
      )
      .map((r) => this.map(r))
      .filter((t) => !exclude.has(t.id))
      .slice(0, limit);
  }

  nextScheduledAt(): number | null {
    const row = this.db.get<{ t: number | null }>("SELECT MIN(scheduled_for) AS t FROM tasks WHERE status = 'queued' AND scheduled_for > ?", now());
    return row?.t ?? null;
  }

  heartbeat(id: string): void {
    this.db.run('UPDATE tasks SET heartbeat_at = ? WHERE id = ?', now(), id);
  }

  addEvent(taskId: string, type: string, message: string, data?: unknown): void {
    this.db.run('INSERT INTO task_events (task_id, ts, type, message, data) VALUES (?, ?, ?, ?, ?)', taskId, now(), type, message, data === undefined ? null : JSON.stringify(data));
    this.bus.emit('task.event', { taskId, type, message });
  }

  events(taskId: string, limit = 500): TaskEvent[] {
    return this.db.all<Record<string, unknown>>('SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC LIMIT ?', taskId, limit).map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      ts: Number(r.ts),
      type: String(r.type),
      message: String(r.message),
      data: parseJson(r.data as string | null, null),
    }));
  }

  delete(id: string): void {
    this.db.run('DELETE FROM tasks WHERE id = ?', id);
    this.bus.emit('task.updated', { id, status: 'deleted' });
  }
}
