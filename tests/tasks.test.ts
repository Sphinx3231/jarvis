import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { JarvisApp } from '../server/app.ts';
import { nextOccurrence, resolveTemplates } from '../server/tasks/engine.ts';
import type { PlanStep } from '../server/tasks/store.ts';
import type { Skill } from '../server/skills/types.ts';
import { makeApp, waitFor } from './helpers.ts';

/** A consequential test skill that counts executions and can be made to block. */
function registerCounter(app: JarvisApp, opts: { idempotent?: boolean; scope?: string; block?: Promise<void> } = {}) {
  const calls: unknown[] = [];
  const skill: Skill<{ value: string }, { echoed: string }> = {
    name: 'test.counter',
    title: 'Counter',
    description: 'test',
    category: 'shell',
    scope: opts.scope ?? 'test.external',
    risk: 'consequential',
    idempotent: opts.idempotent ?? false,
    inlineSafe: false,
    untrustedOutput: false,
    input: z.object({ value: z.string() }),
    outputDescription: 'echo',
    availability: () => ({ available: true }),
    summarize: (i) => `Count ${i.value}`,
    async execute(input) {
      calls.push(input);
      if (opts.block) await opts.block;
      return { echoed: input.value };
    },
    async verify(i, o) {
      return { ok: o.echoed === i.value, detail: 'echo matches' };
    },
    describe: (o) => `echoed ${o.echoed}`,
  };
  app.registry.register(skill);
  return calls;
}

test('tasks: internal multi-step task completes, passes outputs between steps and records history', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const { task } = app.engine.createTask({
      title: 'Store and notify',
      origin: 'user',
      steps: [
        { skill: 'memory.remember', input: { content: 'Project Phoenix ships in May', kind: 'project', userStated: true }, description: 'remember' },
        { skill: 'notify.user', input: { title: 'Saved', body: 'Memory id {{steps.0.output.id}}' }, description: 'notify' },
      ],
    });
    assert.deepEqual(task.requiredPermissions, []);
    const done = await waitFor(() => {
      const t = app.tasks.get(task.id)!;
      return t.status === 'completed' ? t : null;
    });
    assert.equal(done.progress, 1);
    assert.equal(done.result?.verified, true);
    assert.equal(done.plan![0].agent, 'memory');
    assert.equal(done.plan![1].agent, 'researcher');
    const memId = (done.plan![0].output as { id: string }).id;
    assert.ok(app.activity.notifications().some((n) => n.body === `Memory id ${memId}`));
    const events = app.tasks.events(task.id).map((e) => e.type);
    assert.deepEqual(events.filter((e) => e.startsWith('step_')), ['step_started', 'step_completed', 'step_started', 'step_completed']);
    assert.ok(app.memory.list({ kind: 'task_history' }).some((m) => m.content.includes('Store and notify')), 'memory agent recorded task history');
    const audit = app.db.all<{ skill: string; outcome: string; actor: string }>('SELECT skill, outcome, actor FROM audit_log ORDER BY id');
    assert.deepEqual(
      audit.map((a) => `${a.actor}:${a.skill}:${a.outcome}`),
      ['memory:memory.remember:success', 'researcher:notify.user:success'],
    );
  } finally {
    await cleanup();
  }
});

test('tasks: consequential step waits for approval; approval is single-use; denial cancels', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const calls = registerCounter(app);
    const { task } = app.engine.createTask({ title: 'Do the thing', origin: 'user', steps: [{ skill: 'test.counter', input: { value: 'a' }, description: 'act' }] });
    assert.deepEqual(task.requiredPermissions, ['test.external']);
    await waitFor(() => app.tasks.get(task.id)!.status === 'awaiting_approval');
    assert.equal(calls.length, 0, 'nothing ran before approval');
    const [approval] = app.permissions.listApprovals('pending');
    assert.equal(approval.summary, 'Count a');

    app.permissions.decideApproval(approval.id, 'approve');
    await waitFor(() => app.tasks.get(task.id)!.status === 'completed');
    assert.equal(calls.length, 1);
    assert.equal(app.permissions.getApproval(approval.id)!.status, 'used', 'approval consumed');
    assert.throws(() => app.permissions.decideApproval(approval.id, 'approve'), /already used/);

    // A second identical task needs a fresh approval.
    const second = app.engine.createTask({ title: 'Again', origin: 'user', steps: [{ skill: 'test.counter', input: { value: 'a' }, description: 'act' }] }).task;
    await waitFor(() => app.tasks.get(second.id)!.status === 'awaiting_approval');
    const pending = app.permissions.listApprovals('pending')[0];
    app.permissions.decideApproval(pending.id, 'deny');
    await waitFor(() => app.tasks.get(second.id)!.status === 'cancelled');
    assert.equal(calls.length, 1, 'denied action never ran');
  } finally {
    await cleanup();
  }
});

test('tasks: "remember this exact action" grant allows only identical input', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const calls = registerCounter(app);
    const t1 = app.engine.createTask({ title: 'One', origin: 'user', steps: [{ skill: 'test.counter', input: { value: 'x' }, description: '' }] }).task;
    await waitFor(() => app.tasks.get(t1.id)!.status === 'awaiting_approval');
    app.permissions.decideApproval(app.permissions.listApprovals('pending')[0].id, 'approve', { remember: true });
    await waitFor(() => app.tasks.get(t1.id)!.status === 'completed');

    const t2 = app.engine.createTask({ title: 'Same', origin: 'user', steps: [{ skill: 'test.counter', input: { value: 'x' }, description: '' }] }).task;
    await waitFor(() => app.tasks.get(t2.id)!.status === 'completed');
    assert.equal(calls.length, 2);
    assert.equal(app.permissions.listGrants()[0].uses, 1);

    const t3 = app.engine.createTask({ title: 'Different', origin: 'user', steps: [{ skill: 'test.counter', input: { value: 'y' }, description: '' }] }).task;
    await waitFor(() => app.tasks.get(t3.id)!.status === 'awaiting_approval');
    assert.equal(calls.length, 2);

    app.permissions.revokeGrant(app.permissions.listGrants()[0].id);
    const t4 = app.engine.createTask({ title: 'Revoked', origin: 'user', steps: [{ skill: 'test.counter', input: { value: 'x' }, description: '' }] }).task;
    await waitFor(() => app.tasks.get(t4.id)!.status === 'awaiting_approval');
  } finally {
    await cleanup();
  }
});

test('permissions: deny policy blocks execution; consequential scopes cannot be auto-allowed', async () => {
  const { app, cleanup } = await makeApp();
  try {
    assert.throws(() => app.permissions.validatePolicyPatch({ 'shell.exec': 'allow' }), /cannot be allowed automatically/);
    app.settings.update({ permissions: { policies: { 'shell.exec': 'allow' } } });
    assert.equal(app.permissions.policyFor('shell.exec'), 'ask', 'engine ignores a stored allow for shell');

    app.settings.update({ permissions: { policies: { 'files.read': 'deny' } } });
    const res = await app.runner.invoke({ agent: 'researcher', skill: 'files.list', input: {} });
    assert.equal(res.status, 'denied');
    const { task } = app.engine.createTask({ title: 'List', origin: 'user', steps: [{ skill: 'files.list', input: {}, description: '' }] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'failed');
    assert.match(app.tasks.get(task.id)!.error!, /Not permitted/);
  } finally {
    await cleanup();
  }
});

test('agents: roles cannot invoke skills outside their boundary', async () => {
  const { app, cleanup } = await makeApp();
  try {
    registerCounter(app);
    const viaResearcher = await app.runner.invoke({ agent: 'researcher', skill: 'test.counter', input: { value: 'z' } });
    assert.equal(viaResearcher.status, 'denied');
    const viaJarvis = await app.runner.invoke({ agent: 'jarvis', skill: 'shell.run', input: { command: 'echo hi' } });
    assert.equal(viaJarvis.status, 'denied');
    const viaPlanner = await app.runner.invoke({ agent: 'planner', skill: 'memory.search', input: { query: 'x' } });
    assert.equal(viaPlanner.status, 'denied');
    // Even the executor, which may use anything, still goes through the permission engine.
    const viaExecutor = await app.runner.invoke({ agent: 'executor', skill: 'test.counter', input: { value: 'z' } });
    assert.equal(viaExecutor.status, 'needs_approval');
  } finally {
    await cleanup();
  }
});

test('tasks: planner rejects unknown skills and invalid inputs', async () => {
  const { app, cleanup } = await makeApp();
  try {
    assert.throws(() => app.engine.createTask({ title: 'x', origin: 'user', steps: [{ skill: 'fax.send', input: {}, description: '' }] }), /unknown skill/);
    assert.throws(
      () => app.engine.createTask({ title: 'x', origin: 'user', steps: [{ skill: 'email.send', input: { to: ['a@b.co'], subject: 's', body: 'b' }, description: '' }] }),
      /email\.send is unavailable \(Email is turned off/,
      'integrations that are not set up are refused at planning time',
    );
    assert.throws(() => app.engine.createTask({ title: 'x', origin: 'user', steps: [{ skill: 'web.fetch', input: { url: 'not a url' }, description: '' }] }), /invalid input/);
    assert.throws(
      () => app.engine.createTask({ title: 'x', origin: 'user', steps: [{ skill: 'notify.user', input: { title: '{{steps.0.text}}' }, description: '' }] }),
      /has not run yet/,
    );
  } finally {
    await cleanup();
  }
});

test('tasks: crash recovery re-queues idempotent steps but never repeats uncertain external actions', async () => {
  const { app, cleanup } = await makeApp({ start: false });
  try {
    const calls = registerCounter(app, { scope: 'internal' });
    const mkStep = (skill: string, input: Record<string, unknown>): PlanStep => ({ skill, input, description: skill, agent: skill === 'test.counter' ? 'executor' : 'researcher', status: 'running', attempts: 1, startedAt: Date.now() });
    // Simulate the database state left behind by a crash mid-step.
    const idem = app.tasks.create({ title: 'Idempotent', origin: 'user', plan: [mkStep('notify.user', { title: 'hi' })] });
    app.tasks.update(idem.id, { status: 'running' });
    const risky = app.tasks.create({ title: 'Risky', origin: 'user', plan: [mkStep('test.counter', { value: 'r' })] });
    app.tasks.update(risky.id, { status: 'running' });

    await app.start();
    await waitFor(() => app.tasks.get(idem.id)!.status === 'completed', 5000, 'idempotent task resumes');
    const r = app.tasks.get(risky.id)!;
    assert.equal(r.status, 'paused');
    assert.equal(r.plan![0].status, 'uncertain');
    assert.match(r.attention!, /outcome is unknown/);
    assert.equal(calls.length, 0, 'uncertain action was not repeated');
    assert.throws(() => app.engine.resume(risky.id), /retry.*skip/);

    app.engine.resume(risky.id, { uncertain: 'skip' });
    await waitFor(() => app.tasks.get(risky.id)!.status === 'completed');
    assert.equal(calls.length, 0, 'skip never executes the step');
    assert.equal(app.tasks.get(risky.id)!.plan![0].status, 'skipped');
  } finally {
    await cleanup();
  }
});

test('tasks: pause, resume, cancel and retry', async () => {
  const { app, cleanup } = await makeApp();
  try {
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    const calls = registerCounter(app, { scope: 'internal', idempotent: true, block });
    const { task } = app.engine.createTask({
      title: 'Two steps',
      origin: 'user',
      steps: [
        { skill: 'test.counter', input: { value: '1' }, description: 'first' },
        { skill: 'test.counter', input: { value: '2' }, description: 'second' },
      ],
    });
    await waitFor(() => calls.length === 1);
    app.engine.pause(task.id);
    release();
    await waitFor(() => app.tasks.get(task.id)!.status === 'paused', 5000, 'paused after current step');
    assert.equal(calls.length, 1, 'second step did not start while paused');
    assert.equal(app.tasks.get(task.id)!.plan![0].status, 'done');

    app.engine.resume(task.id);
    await waitFor(() => app.tasks.get(task.id)!.status === 'completed');
    assert.equal(calls.length, 2);

    // Cancel a long-running step.
    let release2!: () => void;
    const block2 = new Promise<void>((r) => (release2 = r));
    app.registry.unregisterPrefix('test.');
    const calls2 = registerCounter(app, { scope: 'internal', idempotent: true, block: block2 });
    const t2 = app.engine.createTask({ title: 'Cancel me', origin: 'user', steps: [{ skill: 'test.counter', input: { value: 'c' }, description: '' }] }).task;
    await waitFor(() => calls2.length === 1);
    app.engine.cancel(t2.id);
    release2();
    await waitFor(() => app.engine.runningCount === 0);
    assert.equal(app.tasks.get(t2.id)!.status, 'cancelled', 'cancellation is not overwritten by a late result');

    app.engine.retry(t2.id);
    await waitFor(() => app.tasks.get(t2.id)!.status === 'completed');
  } finally {
    await cleanup();
  }
});

test('tasks: failing step is retried within limits, then reported honestly', async () => {
  const { app, cleanup } = await makeApp();
  try {
    writeFileSync(join(app.workspaceDir(), 'exists.txt'), 'hello');
    const { task } = app.engine.createTask({ title: 'Read missing', origin: 'user', steps: [{ skill: 'files.read', input: { path: 'missing.txt' }, description: '' }] });
    const failed = await waitFor(() => {
      const t = app.tasks.get(task.id)!;
      return t.status === 'failed' ? t : null;
    }, 8000);
    assert.equal(failed.plan![0].attempts, 2, 'retried once (maxAttempts = 2)');
    assert.match(failed.error!, /ENOENT|no such file/i);
    assert.equal(failed.result, null);
    assert.ok(app.activity.notifications().some((n) => n.level === 'error' && n.taskId === task.id));
  } finally {
    await cleanup();
  }
});

test('tasks: scheduled and recurring tasks; dedupe of active work', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const { task } = app.engine.createTask({
      title: 'Later',
      origin: 'user',
      steps: [{ skill: 'notify.user', input: { title: 'tick' }, description: '' }],
      scheduledFor: Date.now() + 300,
      recurrence: { everyMinutes: 60 },
      dedupeKey: 'hourly-tick',
    });
    assert.equal(app.tasks.get(task.id)!.status, 'queued');
    const dup = app.engine.createTask({ title: 'Later', origin: 'user', steps: [{ skill: 'notify.user', input: { title: 'tick' }, description: '' }], dedupeKey: 'hourly-tick' });
    assert.equal(dup.deduplicated, true);
    await waitFor(() => app.tasks.get(task.id)!.status === 'completed', 3000);
    const next = await waitFor(() => app.tasks.list({ status: 'queued' }).find((t) => t.title === 'Later'));
    assert.ok(next.scheduledFor! > Date.now() + 59 * 60_000, 'next occurrence ~1h later');
    assert.equal(next.origin, 'schedule');
  } finally {
    await cleanup();
  }
});

test('tasks: monitor recovers orphaned running tasks and reminds about old approvals', async () => {
  const { app, cleanup } = await makeApp();
  try {
    registerCounter(app);
    const orphan = app.tasks.create({ title: 'Orphan', origin: 'user', plan: [{ skill: 'notify.user', input: { title: 'x' }, description: '', agent: 'researcher', status: 'pending', attempts: 0 }] });
    app.db.run("UPDATE tasks SET status = 'running' WHERE id = ?", orphan.id);
    const t = app.engine.createTask({ title: 'Needs ok', origin: 'user', steps: [{ skill: 'test.counter', input: { value: 'q' }, description: '' }] }).task;
    await waitFor(() => app.tasks.get(t.id)!.status === 'awaiting_approval');
    app.db.run('UPDATE approvals SET created_at = ?', Date.now() - 2 * 3_600_000);
    const report = app.engine.monitor();
    assert.equal(report.stalled, 1);
    assert.equal(report.remindersSent, 1);
    assert.equal(app.engine.monitor().remindersSent, 0, 'reminder sent only once');
    await waitFor(() => app.tasks.get(orphan.id)!.status === 'completed');
  } finally {
    await cleanup();
  }
});

test('tasks: template resolution and recurrence math', () => {
  const steps = [{ status: 'done', output: { text: 'hello', n: 3, nested: { a: 1 } }, outputText: 'HELLO' }] as unknown as PlanStep[];
  assert.equal(resolveTemplates('{{steps.0.output.text}}', steps), 'hello');
  assert.equal(resolveTemplates('{{steps.0.output.n}}', steps), 3);
  assert.equal(resolveTemplates('say {{steps.0.text}}!', steps), 'say HELLO!');
  assert.deepEqual(resolveTemplates({ a: ['{{ steps.0.output.nested }}'] }, steps), { a: [{ a: 1 }] });
  assert.throws(() => resolveTemplates('{{steps.1.text}}', steps), /no output/);
  assert.throws(() => resolveTemplates('{{steps.0.output.missing}}', steps), /no field/);
  const base = new Date(2026, 0, 1, 10, 0).getTime();
  assert.equal(nextOccurrence({ everyMinutes: 30 }, base), base + 1_800_000);
  assert.equal(new Date(nextOccurrence({ dailyAt: '09:00' }, base)!).getDate(), 2);
  assert.equal(new Date(nextOccurrence({ dailyAt: '11:30' }, base)!).getHours(), 11);
});

test('tasks: state persists across restarts', async () => {
  const first = await makeApp();
  registerCounter(first.app);
  const id = first.app.engine.createTask({ title: 'Persist', origin: 'user', steps: [{ skill: 'test.counter', input: { value: 'p' }, description: '' }] }).task.id;
  await waitFor(() => first.app.tasks.get(id)!.status === 'awaiting_approval');
  await first.app.stop();
  const second = await makeApp({ dataDir: first.dir, start: false });
  try {
    const calls = registerCounter(second.app);
    await second.app.start();
    assert.equal(second.app.tasks.get(id)!.status, 'awaiting_approval');
    const approval = second.app.permissions.listApprovals('pending')[0];
    assert.equal(approval.taskId, id);
    second.app.permissions.decideApproval(approval.id, 'approve');
    await waitFor(() => second.app.tasks.get(id)!.status === 'completed');
    assert.equal(calls.length, 1);
  } finally {
    await second.cleanup();
    await first.cleanup();
  }
});
