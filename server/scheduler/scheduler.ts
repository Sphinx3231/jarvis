import type { Database } from '../db/database.ts';
import type { ActivityLog } from '../core/activity.ts';
import type { EventBus } from '../core/events.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage, now, truncate } from '../core/util.ts';

export interface JobDefinition {
  name: string;
  title: string;
  description: string;
  /** Interval in ms, read from settings each time so changes apply without a restart. */
  intervalMs: () => number;
  /** Background jobs pause when background operation is disabled; essential ones keep running. */
  essential?: boolean;
  run: (signal: AbortSignal) => Promise<string> | string;
}

export interface JobStatus {
  name: string;
  title: string;
  description: string;
  intervalMs: number;
  running: boolean;
  paused: boolean;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastMessage: string | null;
  lastDurationMs: number | null;
  runCount: number;
  nextRunAt: number | null;
}

/**
 * Lightweight in-process scheduler. One timer per job, no overlapping runs, a per-run timeout,
 * and persisted run statistics. Jobs are internal operations only — they never perform external
 * actions on their own.
 */
export class Scheduler {
  private db: Database;
  private settings: SettingsStore;
  private activity: ActivityLog;
  private bus: EventBus;
  private jobs = new Map<string, JobDefinition>();
  private timers = new Map<string, NodeJS.Timeout>();
  private nextRun = new Map<string, number>();
  private active = new Map<string, AbortController>();
  private started = false;

  constructor(db: Database, settings: SettingsStore, activity: ActivityLog, bus: EventBus) {
    this.db = db;
    this.settings = settings;
    this.activity = activity;
    this.bus = bus;
    bus.on('settings.changed', () => {
      if (this.started) this.rescheduleAll();
    });
  }

  register(job: JobDefinition): void {
    this.jobs.set(job.name, job);
    this.db.run('INSERT OR IGNORE INTO jobs (name) VALUES (?)', job.name);
  }

  start(): void {
    this.started = true;
    this.rescheduleAll(true);
  }

  stop(): void {
    this.started = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.nextRun.clear();
    for (const c of this.active.values()) c.abort(new Error('Scheduler stopped'));
  }

  private paused(job: JobDefinition): boolean {
    return !job.essential && !this.settings.get().background.enabled;
  }

  private rescheduleAll(initial = false): void {
    for (const job of this.jobs.values()) this.schedule(job, initial ? Math.min(5000, job.intervalMs()) : undefined);
  }

  private schedule(job: JobDefinition, delay?: number): void {
    const existing = this.timers.get(job.name);
    if (existing) clearTimeout(existing);
    this.timers.delete(job.name);
    this.nextRun.delete(job.name);
    if (!this.started || this.paused(job)) return;
    const wait = delay ?? job.intervalMs();
    this.nextRun.set(job.name, now() + wait);
    const timer = setTimeout(() => {
      void this.runJob(job.name).finally(() => this.schedule(job));
    }, wait);
    timer.unref?.();
    this.timers.set(job.name, timer);
  }

  async runJob(name: string, opts: { manual?: boolean } = {}): Promise<string> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown job ${name}`);
    if (this.active.has(name)) return 'already running';
    const controller = new AbortController();
    this.active.set(name, controller);
    const started = now();
    const timeout = setTimeout(() => controller.abort(new Error('Job timed out')), Math.max(60_000, job.intervalMs()));
    let status = 'ok';
    let message: string;
    try {
      message = await job.run(controller.signal);
    } catch (err) {
      status = 'error';
      message = errorMessage(err);
      this.activity.log('error', 'scheduler', `${job.title} failed: ${message}`);
    } finally {
      clearTimeout(timeout);
      this.active.delete(name);
    }
    const duration = now() - started;
    this.db.run(
      'UPDATE jobs SET last_run_at = ?, last_status = ?, last_message = ?, last_duration_ms = ?, run_count = run_count + 1 WHERE name = ?',
      started,
      status,
      truncate(message, 500),
      duration,
      name,
    );
    if (opts.manual) this.activity.log('info', 'scheduler', `Ran ${job.title} manually: ${message}`);
    this.bus.emit('job.ran', { name, status });
    return message;
  }

  status(): JobStatus[] {
    return [...this.jobs.values()].map((job) => {
      const r = this.db.get<Record<string, unknown>>('SELECT * FROM jobs WHERE name = ?', job.name) ?? {};
      return {
        name: job.name,
        title: job.title,
        description: job.description,
        intervalMs: job.intervalMs(),
        running: this.active.has(job.name),
        paused: this.paused(job),
        lastRunAt: r.last_run_at == null ? null : Number(r.last_run_at),
        lastStatus: (r.last_status as string | null) ?? null,
        lastMessage: (r.last_message as string | null) ?? null,
        lastDurationMs: r.last_duration_ms == null ? null : Number(r.last_duration_ms),
        runCount: Number(r.run_count ?? 0),
        nextRunAt: this.nextRun.get(job.name) ?? null,
      };
    });
  }
}
