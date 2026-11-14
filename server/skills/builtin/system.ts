import { z } from 'zod';
import type { Skill } from '../types.ts';

const always = () => ({ available: true });

const StatusInput = z.object({});

export const systemStatus: Skill<Record<string, never>, Record<string, unknown>> = {
  name: 'system.status',
  title: 'System status',
  description: 'Get live Jarvis status: uptime, task queue counts, pending approvals, memory size, model provider and background jobs.',
  category: 'system',
  scope: 'internal',
  risk: 'internal',
  idempotent: true,
  inlineSafe: true,
  untrustedOutput: false,
  input: StatusInput as z.ZodType<Record<string, never>>,
  outputDescription: 'A status snapshot object.',
  availability: always,
  summarize: () => 'Read system status',
  async execute(_i, ctx) {
    return ctx.services.statusSnapshot();
  },
  async verify(_i, out) {
    return { ok: typeof out === 'object' && out !== null, detail: 'Snapshot read' };
  },
  describe: (out) => JSON.stringify(out, null, 2),
};

const ListInput = z.object({
  status: z.enum(['queued', 'running', 'paused', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'active']).optional().describe('"active" = queued, running, paused or awaiting approval'),
});

export const tasksList: Skill<z.infer<typeof ListInput>, { tasks: Array<{ id: string; title: string; status: string; priority: number; progress: number }> }> = {
  name: 'tasks.list',
  title: 'List tasks',
  description: 'List Jarvis tasks and their status.',
  category: 'tasks',
  scope: 'internal',
  risk: 'internal',
  idempotent: true,
  inlineSafe: true,
  untrustedOutput: false,
  input: ListInput,
  outputDescription: 'Tasks with id, title, status, priority and progress.',
  availability: always,
  summarize: (i) => `List ${i.status ?? 'all'} tasks`,
  async execute(input, ctx) {
    return { tasks: ctx.services.listTasks(input.status).slice(0, 30) };
  },
  async verify(_i, out) {
    return { ok: Array.isArray(out.tasks), detail: `${out.tasks.length} task(s)` };
  },
  describe: (out) => (out.tasks.length ? out.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`).join('\n') : 'No tasks.'),
};

const NotifyInput = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(1000).optional(),
  level: z.enum(['info', 'success', 'warning']).optional(),
});

export const notifyUser: Skill<z.infer<typeof NotifyInput>, { id: string | null; duplicate: boolean }> = {
  name: 'notify.user',
  title: 'Notify user',
  description: 'Show the user a notification inside Jarvis (and as a desktop notification if enabled). Use for reminders and reporting results.',
  category: 'system',
  scope: 'internal',
  risk: 'internal',
  idempotent: true,
  inlineSafe: false,
  untrustedOutput: false,
  input: NotifyInput,
  outputDescription: 'The notification id.',
  availability: always,
  summarize: (i) => `Notify: "${i.title}"`,
  async execute(input, ctx) {
    // Dedupe per task step so a recovered task never shows the same notification twice.
    const dedupeKey = ctx.taskId !== undefined ? `step:${ctx.taskId}:${ctx.stepIndex}` : undefined;
    const n = ctx.services.activity.notify(input.level ?? 'info', input.title, input.body ?? '', { taskId: ctx.taskId, dedupeKey });
    return { id: n?.id ?? null, duplicate: !n };
  },
  async verify(_i, out) {
    return { ok: out.id !== null || out.duplicate, detail: out.duplicate ? 'Already delivered earlier' : 'Notification delivered' };
  },
  describe: (o) => (o.duplicate ? 'Notification was already delivered' : 'Notification delivered'),
};
