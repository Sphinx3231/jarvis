import type { ActivityLog } from '../core/activity.ts';
import type { EventBus } from '../core/events.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage, now, sleep, truncate, UserError } from '../core/util.ts';
import type { DraftStep, Planner } from '../agents/planner.ts';
import type { PermissionEngine } from '../permissions/engine.ts';
import type { SkillRegistry } from '../skills/registry.ts';
import type { SkillRunner } from '../skills/runner.ts';
import { boundOutput, type PlanStep, type Recurrence, type Task, type TaskStore } from './store.ts';

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: number;
  origin: Task['origin'];
  conversationId?: string | null;
  steps?: DraftStep[] | null;
  scheduledFor?: number | null;
  recurrence?: Recurrence | null;
  dedupeKey?: string | null;
}

/** Resolve {{steps.N.output.path}} / {{steps.N.text}} references against completed steps. */
export function resolveTemplates(value: unknown, steps: PlanStep[]): unknown {
  const lookup = (index: number, path: string): unknown => {
    const step = steps[index];
    if (!step || step.status !== 'done') throw new Error(`Step ${index + 1} has no output yet`);
    if (path === 'text') return step.outputText ?? '';
    const parts = path.split('.');
    if (parts[0] !== 'output') throw new Error(`Unknown template path "${path}"`);
    let cur: unknown = step.output;
    for (const p of parts.slice(1)) {
      if (cur === null || typeof cur !== 'object') throw new Error(`Step ${index + 1} output has no field "${p}"`);
      cur = (cur as Record<string, unknown>)[p];
    }
    if (cur === undefined) throw new Error(`Step ${index + 1} output has no field "${parts.slice(1).join('.')}"`);
    return cur;
  };
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*steps\.(\d+)\.([\w.]+)\s*\}\}$/);
    if (whole) return lookup(Number(whole[1]), whole[2]);
    return value.replace(/\{\{\s*steps\.(\d+)\.([\w.]+)\s*\}\}/g, (_, i, p) => {
      const v = lookup(Number(i), p);
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, steps));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, steps)]));
  return value;
}

export function nextOccurrence(rec: Recurrence, from: number): number | null {
  if (rec.everyMinutes && rec.everyMinutes >= 1) return from + rec.everyMinutes * 60_000;
  if (rec.dailyAt && /^\d{2}:\d{2}$/.test(rec.dailyAt)) {
    const [h, m] = rec.dailyAt.split(':').map(Number);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

interface RunningTask {
  controller: AbortController;
  promise: Promise<void>;
  pauseRequested: boolean;
}

export interface MonitorReport {
  stalled: number;
  remindersSent: number;
  dispatched: number;
  message: string;
}

export class TaskEngine {
  private store: TaskStore;
  private runner: SkillRunner;
  private registry: SkillRegistry;
  private permissions: PermissionEngine;
  private planner: Planner;
  private activity: ActivityLog;
  private bus: EventBus;
  private settings: SettingsStore;
  private onCompleted: (task: Task) => void;

  private running = new Map<string, RunningTask>();
  private locks = new Map<string, string>();
  private scheduleTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;
  private unsubscribe: (() => void) | null = null;

  constructor(deps: {
    store: TaskStore;
    runner: SkillRunner;
    registry: SkillRegistry;
    permissions: PermissionEngine;
    planner: Planner;
    activity: ActivityLog;
    bus: EventBus;
    settings: SettingsStore;
    onCompleted?: (task: Task) => void;
  }) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.registry = deps.registry;
    this.permissions = deps.permissions;
    this.planner = deps.planner;
    this.activity = deps.activity;
    this.bus = deps.bus;
    this.settings = deps.settings;
    this.onCompleted = deps.onCompleted ?? (() => {});
  }

  get runningCount(): number {
    return this.running.size;
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.recover();
    this.unsubscribe = this.bus.on('approval.updated', (e) => {
      const taskId = e.data.taskId as string | undefined;
      const status = e.data.status as string;
      if (!taskId || (status !== 'approved' && status !== 'denied')) return;
      this.onApprovalDecision(taskId, status);
    });
    this.kick();
  }

  /** Graceful shutdown: stop dispatching, signal running tasks and wait briefly for them. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    for (const r of this.running.values()) r.controller.abort(new Error('Jarvis is shutting down'));
    await Promise.race([Promise.allSettled([...this.running.values()].map((r) => r.promise)), sleep(5000)]);
    this.started = false;
  }

  /**
   * Crash recovery. A task left "running" means Jarvis stopped mid-step. Idempotent steps are
   * simply re-queued; non-idempotent ones (commands, writes, external tools) are NEVER repeated
   * automatically — the task is paused and the user decides whether to retry or skip.
   */
  recover(): number {
    let recovered = 0;
    for (const task of this.store.list({ status: 'running', limit: 1000 })) {
      if (this.running.has(task.id)) continue;
      this.recoverOne(task, 'Jarvis was restarted while this task was running');
      recovered++;
    }
    return recovered;
  }

  private recoverOne(task: Task, why: string): void {
    const plan = task.plan ?? [];
    const step = plan[task.currentStep];
    if (step && step.status === 'running') {
      const skill = this.registry.get(step.skill);
      if (skill?.idempotent) {
        step.status = 'pending';
        this.store.update(task.id, { status: 'queued', plan, heartbeatAt: null });
        this.store.addEvent(task.id, 'recovered', `${why}. Step ${task.currentStep + 1} (${step.skill}) is safe to repeat, so the task was re-queued.`);
      } else {
        step.status = 'uncertain';
        const attention = `${why} during step ${task.currentStep + 1}: "${skill ? skill.summarize(step.input) : step.skill}". Its outcome is unknown, so Jarvis will not repeat it automatically. Check the result, then choose Retry step or Skip step.`;
        this.store.update(task.id, { status: 'paused', plan, attention, heartbeatAt: null });
        this.store.addEvent(task.id, 'interrupted', attention);
        this.activity.notify('warning', 'Task needs your review', `"${task.title}" was interrupted during an action that may or may not have completed.`, {
          taskId: task.id,
          dedupeKey: `uncertain:${task.id}:${task.currentStep}`,
        });
      }
    } else {
      this.store.update(task.id, { status: 'queued', heartbeatAt: null });
      this.store.addEvent(task.id, 'recovered', `${why}; re-queued (no step was in progress).`);
    }
    this.activity.log('warning', 'tasks', `Recovered task "${task.title}"`, { taskId: task.id });
  }

  createTask(input: CreateTaskInput): { task: Task; deduplicated: boolean } {
    if (input.dedupeKey) {
      const existing = this.store.findActiveByDedupeKey(input.dedupeKey);
      if (existing) return { task: existing, deduplicated: true };
    }
    let plan: PlanStep[] | null = null;
    let requiredPermissions: string[] = [];
    if (input.steps?.length) {
      const validated = this.planner.validate(input.steps);
      plan = validated.steps;
      requiredPermissions = validated.requiredPermissions;
    }
    if (input.recurrence && !nextOccurrence(input.recurrence, now())) throw new UserError('Invalid recurrence (use everyMinutes ≥ 1 or dailyAt "HH:MM")');
    const task = this.store.create({
      title: input.title,
      description: input.description,
      priority: input.priority,
      origin: input.origin,
      conversationId: input.conversationId,
      plan,
      requiredPermissions,
      scheduledFor: input.scheduledFor ?? null,
      recurrence: input.recurrence ?? null,
      dedupeKey: input.dedupeKey ?? null,
      maxAttempts: this.settings.get().tasks.maxAttempts,
    });
    this.activity.log('info', 'tasks', `New task: ${task.title}${plan ? ` (${plan.length} step${plan.length === 1 ? '' : 's'})` : ' (needs planning)'}`, { taskId: task.id });
    this.kick();
    return { task, deduplicated: false };
  }

  /** Start as many due tasks as concurrency allows. Event-driven; also called by the monitor. */
  kick(): void {
    if (!this.started || this.stopping) return;
    const max = this.settings.get().background.maxConcurrentTasks;
    const free = max - this.running.size;
    if (free > 0) {
      for (const candidate of this.store.due(free, new Set(this.running.keys()))) {
        const task = this.store.claim(candidate.id);
        if (!task) continue;
        const controller = new AbortController();
        const entry: RunningTask = { controller, pauseRequested: false, promise: Promise.resolve() };
        this.running.set(task.id, entry);
        entry.promise = this.execute(task, entry)
          .catch((err) => {
            this.activity.log('error', 'tasks', `Task engine error: ${errorMessage(err)}`, { taskId: task.id });
            try {
              this.finish(task.id, 'failed', { error: `Internal error: ${errorMessage(err)}` });
            } catch {
              /* task may have been deleted */
            }
          })
          .finally(() => {
            this.running.delete(task.id);
            this.bus.emit('task.updated', { id: task.id });
            setImmediate(() => this.kick());
          });
      }
    }
    this.armScheduleTimer();
  }

  private armScheduleTimer(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    const next = this.store.nextScheduledAt();
    if (next === null) return;
    const delay = Math.min(Math.max(next - now() + 50, 50), 2_147_000_000);
    this.scheduleTimer = setTimeout(() => this.kick(), delay);
    this.scheduleTimer.unref?.();
  }

  private async execute(initial: Task, entry: RunningTask): Promise<void> {
    let task = initial;
    const signal = entry.controller.signal;
    const heartbeat = setInterval(() => this.store.heartbeat(task.id), 10_000);
    heartbeat.unref?.();
    try {
      // Planning phase for tasks created from a plain description.
      if (!task.plan) {
        this.store.addEvent(task.id, 'planning', 'Planning agent is breaking the task into steps');
        task = this.store.update(task.id, { agent: 'planner' });
        let planned: { steps: DraftStep[] } | { error: string };
        try {
          planned = await this.planner.plan(task.title, task.description, signal);
        } catch (err) {
          planned = { error: `Planning failed: ${errorMessage(err)}` };
        }
        if (signal.aborted) return this.handleAbort(task.id, entry);
        if ('error' in planned) {
          this.store.update(task.id, { status: 'paused', agent: null, attention: planned.error, heartbeatAt: null });
          this.store.addEvent(task.id, 'needs_plan', planned.error);
          return;
        }
        try {
          const v = this.planner.validate(planned.steps);
          task = this.store.update(task.id, { plan: v.steps, requiredPermissions: v.requiredPermissions });
          this.store.addEvent(task.id, 'planned', `Plan ready: ${v.steps.map((s, i) => `${i + 1}. ${s.description}`).join('; ')}`, { steps: v.steps.map((s) => s.skill) });
        } catch (err) {
          const msg = `The proposed plan was invalid: ${errorMessage(err)}`;
          this.store.update(task.id, { status: 'paused', agent: null, attention: msg, heartbeatAt: null });
          this.store.addEvent(task.id, 'needs_plan', msg);
          return;
        }
      }

      const plan = task.plan!;
      for (let i = task.currentStep; i < plan.length; i++) {
        const step = plan[i];
        if (step.status === 'done' || step.status === 'skipped') continue;
        if (signal.aborted) return this.handleAbort(task.id, entry);
        if (entry.pauseRequested) {
          this.store.update(task.id, { status: 'paused', currentStep: i, plan, agent: null, heartbeatAt: null });
          this.store.addEvent(task.id, 'paused', `Paused before step ${i + 1}`);
          return;
        }

        let input: unknown;
        try {
          input = resolveTemplates(step.input, plan);
        } catch (err) {
          step.status = 'failed';
          step.error = errorMessage(err);
          return this.finish(task.id, 'failed', { plan, currentStep: i, error: `Step ${i + 1}: ${step.error}` });
        }

        const skill = this.registry.get(step.skill);
        const lockKey = skill?.lockKey?.(input as never) ?? null;
        if (lockKey) {
          while (this.locks.has(lockKey) && this.locks.get(lockKey) !== task.id) {
            if (signal.aborted) return this.handleAbort(task.id, entry);
            await sleep(250, signal).catch(() => {});
          }
          this.locks.set(lockKey, task.id);
        }

        try {
          // Persist the "running" marker before acting so a crash can be detected and handled safely.
          step.status = 'running';
          step.startedAt = now();
          step.attempts += 1;
          task = this.store.update(task.id, { currentStep: i, plan, agent: step.agent, heartbeatAt: now(), attention: null });
          this.store.addEvent(task.id, 'step_started', `Step ${i + 1}/${plan.length}: ${step.description} (${step.agent} → ${step.skill})`);

          const approval = this.permissions.approvalForStep(task.id, i);
          const result = await this.runner.invoke({
            agent: step.agent,
            skill: step.skill,
            input,
            taskId: task.id,
            stepIndex: i,
            approvalId: approval?.status === 'approved' ? approval.id : undefined,
            signal,
            timeoutMs: skill?.timeoutMs ?? this.settings.get().tasks.stepTimeoutSec * 1000,
          });

          if (result.status === 'needs_approval') {
            // Waiting for approval is not an execution attempt.
            step.attempts -= 1;
            step.startedAt = undefined;
            step.status = 'awaiting_approval';
            this.store.update(task.id, { status: 'awaiting_approval', plan, agent: null, heartbeatAt: null });
            const req = this.permissions.requestApproval({ taskId: task.id, stepIndex: i, skill: skill!, input });
            this.store.addEvent(task.id, 'approval_requested', `Waiting for your approval: ${req.summary}`, { approvalId: req.id });
            this.activity.notify('warning', 'Approval needed', req.summary, { taskId: task.id, dedupeKey: `approval:${req.id}` });
            return;
          }
          if (result.status === 'denied') {
            step.status = 'failed';
            step.error = result.reason;
            step.finishedAt = now();
            return this.finish(task.id, 'failed', { plan, currentStep: i, error: `Not permitted: ${result.reason}` });
          }
          if (result.status === 'failed') {
            if (signal.aborted) {
              step.status = 'pending';
              step.attempts -= 1;
              return this.handleAbort(task.id, entry, { plan, index: i });
            }
            const maxAttempts = this.settings.get().tasks.maxAttempts;
            if (result.retryable && step.attempts < maxAttempts) {
              step.status = 'pending';
              step.error = result.error;
              this.store.update(task.id, { plan });
              this.store.addEvent(task.id, 'step_retry', `Step ${i + 1} failed (${result.error}); retrying (attempt ${step.attempts + 1}/${maxAttempts})`);
              await sleep(1000 * step.attempts, signal).catch(() => {});
              i--;
              continue;
            }
            step.status = 'failed';
            step.error = result.error;
            step.finishedAt = now();
            this.store.addEvent(task.id, 'step_failed', `Step ${i + 1} failed: ${result.error}`);
            return this.finish(task.id, 'failed', { plan, currentStep: i, error: `Step ${i + 1} (${step.description}) failed: ${result.error}` });
          }

          step.status = 'done';
          step.output = boundOutput(result.output);
          step.outputText = truncate(result.description, 20_000);
          step.untrusted = result.untrusted;
          step.verification = result.verification.detail;
          step.error = undefined;
          step.finishedAt = now();
          const progress = (i + 1) / plan.length;
          task = this.store.update(task.id, { plan, currentStep: i + 1, progress, heartbeatAt: now() });
          this.store.addEvent(task.id, 'step_completed', `Step ${i + 1} completed and verified: ${result.verification.detail}`);
        } finally {
          if (lockKey && this.locks.get(lockKey) === task.id) this.locks.delete(lockKey);
        }
      }

      if (signal.aborted) return this.handleAbort(task.id, entry);
      const last = [...plan].reverse().find((s) => s.status === 'done');
      this.finish(task.id, 'completed', {
        plan,
        progress: 1,
        result: {
          summary: truncate(last?.outputText ?? 'Completed', 8000),
          verified: plan.every((s) => s.status === 'skipped' || (s.status === 'done' && Boolean(s.verification))),
          completedSteps: plan.filter((s) => s.status === 'done').length,
        },
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private handleAbort(taskId: string, entry: RunningTask, ctx?: { plan: PlanStep[]; index: number }): void {
    const task = this.store.get(taskId);
    if (!task) return;
    if (task.status === 'cancelled') return;
    if (this.stopping) {
      // Shutting down: put the task back so it resumes on the next start.
      const plan = ctx?.plan ?? task.plan;
      const step = plan && ctx ? plan[ctx.index] : undefined;
      const skill = step ? this.registry.get(step.skill) : undefined;
      if (step && skill && !skill.idempotent && step.startedAt) {
        // The action may already have had an effect; let recovery treat it as uncertain.
        step.status = 'running';
        this.store.update(taskId, { status: 'running', plan });
        this.recoverOne(this.store.get(taskId)!, 'Jarvis was shut down');
      } else {
        this.store.update(taskId, { status: 'queued', plan: plan ?? null, heartbeatAt: null });
        this.store.addEvent(taskId, 'interrupted', 'Jarvis shut down; the task will continue on next start');
      }
      return;
    }
    if (entry.pauseRequested) {
      this.store.update(taskId, { status: 'paused', plan: ctx?.plan ?? task.plan, agent: null, heartbeatAt: null });
      this.store.addEvent(taskId, 'paused', 'Paused');
    }
  }

  private finish(taskId: string, status: 'completed' | 'failed', patch: Partial<Task>): void {
    const task = this.store.update(taskId, { ...patch, status, agent: null, finishedAt: now(), heartbeatAt: null });
    if (status === 'completed') {
      this.store.addEvent(taskId, 'completed', `Completed: ${truncate(task.result?.summary ?? '', 200)}`);
      this.activity.log('success', 'tasks', `Completed: ${task.title}`, { taskId });
      if (this.settings.get().notifications.taskCompletion && task.origin !== 'system') {
        // Reminder tasks already notify through their own step.
        if (!task.plan?.every((s) => s.skill === 'notify.user')) this.activity.notify('success', 'Task completed', task.title, { taskId, dedupeKey: `done:${taskId}` });
      }
      this.scheduleNextOccurrence(task);
    } else {
      this.store.addEvent(taskId, 'failed', task.error ?? 'Failed');
      this.activity.log('error', 'tasks', `Failed: ${task.title} — ${task.error ?? ''}`, { taskId });
      this.activity.notify('error', 'Task failed', `${task.title}: ${task.error ?? ''}`, { taskId, dedupeKey: `failed:${taskId}:${task.attempts}` });
      this.scheduleNextOccurrence(task);
    }
    try {
      this.onCompleted(task);
    } catch (err) {
      this.activity.log('warning', 'memory', `Could not record task history: ${errorMessage(err)}`);
    }
  }

  private scheduleNextOccurrence(task: Task): void {
    if (!task.recurrence || !task.plan) return;
    const next = nextOccurrence(task.recurrence, Math.max(now(), task.scheduledFor ?? 0));
    if (!next) return;
    const draft = task.plan.map((s) => ({ skill: s.skill, input: s.input, description: s.description }));
    try {
      const { task: created } = this.createTask({
        title: task.title,
        description: task.description,
        priority: task.priority,
        origin: 'schedule',
        steps: draft,
        scheduledFor: next,
        recurrence: task.recurrence,
        dedupeKey: task.dedupeKey,
      });
      this.store.addEvent(task.id, 'rescheduled', `Next occurrence scheduled as ${created.id} for ${new Date(next).toLocaleString()}`);
    } catch (err) {
      this.activity.log('warning', 'tasks', `Could not schedule next occurrence of "${task.title}": ${errorMessage(err)}`);
    }
  }

  private onApprovalDecision(taskId: string, status: 'approved' | 'denied'): void {
    const task = this.store.get(taskId);
    if (!task || task.status !== 'awaiting_approval' || !task.plan) return;
    const step = task.plan[task.currentStep];
    if (status === 'approved') {
      if (step) step.status = 'pending';
      this.store.update(taskId, { status: 'queued', plan: task.plan });
      this.store.addEvent(taskId, 'approved', `You approved step ${task.currentStep + 1}; continuing`);
      this.kick();
    } else {
      if (step) {
        step.status = 'failed';
        step.error = 'Denied by user';
      }
      this.store.update(taskId, { status: 'cancelled', plan: task.plan, finishedAt: now(), error: `You denied step ${task.currentStep + 1}` });
      this.store.addEvent(taskId, 'denied', `You denied step ${task.currentStep + 1}; the task was cancelled and nothing further was done`);
      this.activity.log('info', 'tasks', `Cancelled after denial: ${task.title}`, { taskId });
    }
  }

  pause(id: string): Task {
    const task = this.store.require(id);
    const running = this.running.get(id);
    if (running) {
      running.pauseRequested = true;
      this.store.addEvent(id, 'pause_requested', 'Pause requested — the current step will finish first');
      return task;
    }
    if (task.status !== 'queued' && task.status !== 'awaiting_approval') throw new UserError(`Cannot pause a ${task.status} task`, 409);
    this.store.addEvent(id, 'paused', 'Paused by you');
    return this.store.update(id, { status: 'paused' });
  }

  resume(id: string, opts: { uncertain?: 'retry' | 'skip' } = {}): Task {
    const task = this.store.require(id);
    if (task.status !== 'paused') throw new UserError(`Only paused tasks can be resumed (this one is ${task.status})`, 409);
    const plan = task.plan;
    const step = plan?.[task.currentStep];
    if (step?.status === 'uncertain') {
      if (!opts.uncertain) throw new UserError('This task stopped during an action with an unknown outcome. Choose "retry" or "skip" for that step.', 409);
      if (opts.uncertain === 'skip') {
        step.status = 'skipped';
        step.error = 'Skipped by user after interruption';
        this.store.addEvent(id, 'step_skipped', `You chose to skip step ${task.currentStep + 1}`);
      } else {
        step.status = 'pending';
        this.store.addEvent(id, 'step_retry', `You chose to retry step ${task.currentStep + 1}`);
      }
    }
    if (step?.status === 'awaiting_approval') step.status = 'pending';
    const pending = plan ? this.permissions.approvalForStep(id, task.currentStep) : undefined;
    const next = this.store.update(id, { status: pending?.status === 'pending' ? 'awaiting_approval' : 'queued', plan, attention: null });
    this.store.addEvent(id, 'resumed', 'Resumed by you');
    this.kick();
    return next;
  }

  cancel(id: string): Task {
    const task = this.store.require(id);
    if (!['queued', 'running', 'paused', 'awaiting_approval'].includes(task.status)) throw new UserError(`Cannot cancel a ${task.status} task`, 409);
    const updated = this.store.update(id, { status: 'cancelled', finishedAt: now(), heartbeatAt: null, error: 'Cancelled by you' });
    this.running.get(id)?.controller.abort(new Error('Cancelled by user'));
    this.permissions.expireApprovalsForTask(id);
    this.store.addEvent(id, 'cancelled', 'Cancelled by you');
    this.activity.log('info', 'tasks', `Cancelled: ${task.title}`, { taskId: id });
    return updated;
  }

  /** Retry a failed or cancelled task from the step that failed. */
  retry(id: string): Task {
    const task = this.store.require(id);
    if (task.status !== 'failed' && task.status !== 'cancelled') throw new UserError(`Only failed or cancelled tasks can be retried`, 409);
    const plan = task.plan;
    if (plan) {
      for (const s of plan) {
        if (s.status === 'failed' || s.status === 'running' || s.status === 'awaiting_approval' || s.status === 'uncertain') {
          s.status = 'pending';
          s.attempts = 0;
          s.error = undefined;
        }
      }
    }
    const updated = this.store.update(id, { status: 'queued', plan, error: null, attention: null, finishedAt: null, attempts: task.attempts + 1 });
    this.store.addEvent(id, 'retried', 'Retry requested by you');
    this.kick();
    return updated;
  }

  /**
   * Background monitor (runs on the scheduler). Detects stalled tasks, dispatches due work and
   * sends one reminder per long-pending approval. No model calls.
   */
  monitor(): MonitorReport {
    const s = this.settings.get().background;
    let stalled = 0;
    let remindersSent = 0;
    const cutoff = now() - s.stalledAfterSec * 1000;
    for (const task of this.store.list({ status: 'running', limit: 1000 })) {
      const last = task.heartbeatAt ?? task.updatedAt;
      if (this.running.has(task.id)) {
        if (last < cutoff) {
          const sent = this.activity.notify('warning', 'Task is taking a long time', `"${task.title}" has been on step ${task.currentStep + 1} for a while.`, {
            taskId: task.id,
            dedupeKey: `slow:${task.id}:${task.currentStep}`,
          });
          if (sent) stalled++;
        }
      } else {
        // Marked running in the database but not executing in this process: orphaned.
        this.recoverOne(task, 'The task stopped responding');
        stalled++;
      }
    }
    const reminderCutoff = now() - s.approvalReminderMin * 60_000;
    for (const a of this.permissions.listApprovals('pending', 200)) {
      if (a.createdAt > reminderCutoff) continue;
      const sent = this.activity.notify('warning', 'Still waiting for your approval', a.summary, { taskId: a.taskId, dedupeKey: `remind:${a.id}` });
      if (sent) remindersSent++;
    }
    const before = this.running.size;
    this.kick();
    const dispatched = this.running.size - before;
    return {
      stalled,
      remindersSent,
      dispatched,
      message: `${this.running.size} running, ${stalled} stalled handled, ${remindersSent} reminder(s), ${dispatched} dispatched`,
    };
  }
}
