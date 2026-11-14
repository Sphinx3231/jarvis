import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, waitFor } from './helpers.ts';

test('scheduler: jobs run on their interval, record stats, and pause with background operation', async () => {
  const { app, cleanup } = await makeApp({ start: false });
  try {
    let runs = 0;
    app.scheduler.register({ name: 'test-job', title: 'Test job', description: '', intervalMs: () => 40, run: () => `run ${++runs}` });
    app.scheduler.register({ name: 'test-boom', title: 'Boom', description: '', intervalMs: () => 40, run: () => { throw new Error('boom'); } });
    app.settings.update({ background: { enabled: true } });
    await app.start();
    await waitFor(() => runs >= 3, 3000, 'repeated runs');
    const status = app.scheduler.status().find((j) => j.name === 'test-job')!;
    assert.ok(status.runCount >= 3);
    assert.equal(status.lastStatus, 'ok');
    await waitFor(() => app.scheduler.status().find((j) => j.name === 'test-boom')!.lastStatus === 'error');
    assert.ok(app.activity.recent(50, 'scheduler').some((a) => a.message.includes('boom')), 'job errors are logged, not swallowed');

    app.settings.update({ background: { enabled: false } });
    const before = runs;
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(runs <= before + 1, 'paused jobs stop running');
    assert.equal(app.scheduler.status().find((j) => j.name === 'test-job')!.paused, true);
    assert.ok(app.insights().some((i) => i.id === 'background-off'));
  } finally {
    await cleanup();
  }
});

test('scheduler: memory maintenance and health check jobs do real work without a model', async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.memory.add({ kind: 'fact', content: 'The office wifi is called Dragonlair', source: 'user' });
    const b = app.memory.add({ kind: 'fact', content: 'Something else entirely', source: 'user' });
    app.memory.update(b.memory.id, { content: 'The office wifi is called DragonLair!' });
    const msg = await app.scheduler.runJob('memory-maintenance');
    assert.match(msg, /merged 1 duplicate/);
    const health = await app.scheduler.runJob('health-check');
    assert.match(health, /^model: problem \(Roamies has no AI sign-in yet.*\); MCP servers healthy$/);
    const monitor = await app.scheduler.runJob('task-monitor');
    assert.match(monitor, /0 running/);
  } finally {
    await cleanup();
  }
});

test('assistant state reflects real activity only', async () => {
  const { app, cleanup } = await makeApp();
  try {
    assert.equal(app.state.get().state, 'idle');
    const end = app.state.beginThinking();
    assert.equal(app.state.get().state, 'thinking');
    end();
    assert.equal(app.state.get().state, 'idle');
    const { task } = app.engine.createTask({ title: 'quick', origin: 'user', steps: [{ skill: 'system.status', input: {}, description: '' }] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'completed');
    await waitFor(() => app.state.get().state === 'success', 2000, 'success flash after a completed task');
  } finally {
    await cleanup();
  }
});
