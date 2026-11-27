import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { palsuText, palsuToolCall, type Message } from '@kenkaiiii/gg-ai';
import { startJarvis } from '../server/main.ts';
import { fromOpenAi, toOpenAi, toOpenAiStream } from '../server/harness/model-endpoint.ts';
import { PROFILES, profileFor, skillsFor } from '../server/harness/profiles.ts';
import { makeApp, tempDir, usePalsu, waitFor } from './helpers.ts';

/**
 * Hermes Agent as Jarvis's harness. The integration tests run the REAL Hermes (its agent loop,
 * through Jarvis's bridge) against Jarvis's scripted test model, so every step is deterministic:
 * TEST DOUBLE = the model only. Set JARVIS_HERMES_PYTHON to a Hermes install's Python to run them
 * (see docs/HERMES.md); without it they are skipped and say so.
 */
const HERMES = process.env.JARVIS_HERMES_PYTHON && existsSync(process.env.JARVIS_HERMES_PYTHON) ? process.env.JARVIS_HERMES_PYTHON : null;
const skip = HERMES ? false : 'JARVIS_HERMES_PYTHON is not set to a Hermes install (docs/HERMES.md)';

/** Tool names the model was offered on its last call (Hermes → Jarvis's model endpoint → engine). */
const offered = (messages: Message[], options: unknown) => ((options as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name);

async function hermesJarvis() {
  const dir = tempDir();
  const running = await startJarvis({ dataDir: dir, port: 0, quiet: true });
  const app = running.app;
  app.settings.update({ background: { enabled: false }, embeddings: { enabled: false }, integrations: { obsidian: { enabled: false } }, harness: { python: HERMES!, contextLength: 65_536 } });
  const model = await usePalsu(app);
  return { app, model, stop: running.stop };
}

test('model endpoint: OpenAI messages map to Jarvis messages and back, streamed and not', () => {
  const req = fromOpenAi(
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'memory__search', arguments: '{"query":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'found' },
    ],
    [{ type: 'function', function: { name: 'memory__search', description: 'd', parameters: { type: 'object' } } }],
  );
  assert.equal(req.system, 'sys');
  assert.deepEqual(req.messages[1], { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'memory__search', input: { query: 'x' } }] });
  assert.deepEqual(req.messages[2], { role: 'tool_results', results: [{ toolCallId: 'c1', content: 'found' }] });
  assert.equal(req.tools![0].name, 'memory__search');
  const res = { text: '', toolCalls: [{ id: 'c2', name: 'files__read', input: { path: 'a' } }], stopReason: 'tool_use' as const, providerId: 'p', model: 'm', raw: null };
  const out = toOpenAi(res, 'm');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.choices[0].message.content, null);
  const sse = toOpenAiStream(res, 'm', true);
  assert.ok(sse.includes('"tool_calls":[{"index":0') && sse.trim().endsWith('data: [DONE]'));
});

test('profiles: each agent is offered only its own skills; security actions are Trinity\'s alone', async () => {
  const { app, cleanup } = await makeApp({ start: false });
  try {
    const all = app.registry.all();
    const names = (id: string) => skillsFor(profileFor(id), all, () => true).map((s) => s.name);
    assert.ok(!names('jarvis').includes('security.operate') && !names('jarvis').includes('hackerone.submit_report'));
    assert.ok(names('trinity').includes('security.operate'));
    assert.ok(!names('jarvis').includes('llm.generate'), 'Hermes never calls the model as a tool');
    assert.deepEqual(names('sentinel').sort(), ['hackerone.programs', 'hackerone.scopes', 'memory.remember', 'memory.search', 'notify.user']);
    assert.equal(Object.keys(PROFILES).length, 7);
  } finally {
    await cleanup();
  }
});

test('without Hermes installed, an open-ended task is planned natively (nothing breaks)', async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ harness: { python: '/nonexistent/python' } });
    const model = await usePalsu(app);
    model.setResponses([palsuText('{"steps":[{"skill":"notify.user","input":{"title":"Hi","body":"There"},"description":"Say hi"}]}')]);
    const { task } = app.engine.createTask({ title: 'Say hi to me', origin: 'user' });
    assert.equal(task.harness, 'hermes', 'chosen for Hermes when a Hermes Python is configured');
    const done = await waitFor(() => {
      const t = app.tasks.get(task.id)!;
      return ['completed', 'failed', 'paused'].includes(t.status) ? t : null;
    }, 15_000);
    assert.equal(done.harness, 'native');
    const fallback = app.tasks.events(task.id).find((e) => e.type === 'harness_fallback');
    assert.ok(fallback && /could not be loaded|not installed/i.test(fallback.message), fallback?.message);
  } finally {
    await cleanup();
  }
});

test('Hermes runs a task end to end: its tool call is a Jarvis step under the permission engine', { skip, timeout: 120_000 }, async () => {
  const { app, model, stop } = await hermesJarvis();
  try {
    app.memory.add({ kind: 'preference', content: 'The user prefers dark roast coffee', source: 'user', verified: true });
    const seen: string[][] = [];
    model.setResponses([
      (messages, options) => {
        seen.push(offered(messages, options));
        return palsuToolCall('memory__search', { query: 'coffee' }, 'h1');
      },
      (messages) => {
        const tool = JSON.stringify(messages.at(-1));
        return palsuText(tool.includes('dark roast') ? 'You prefer dark roast coffee.' : 'I found nothing.');
      },
    ]);
    const status = await app.harness.status();
    assert.equal(status.available, true, status.reason ?? '');
    const { task } = app.engine.createTask({ title: 'What coffee do I like?', origin: 'user' });
    assert.equal(task.harness, 'hermes');
    const done = await waitFor(() => {
      const t = app.tasks.get(task.id)!;
      return ['completed', 'failed', 'paused', 'cancelled'].includes(t.status) ? t : null;
    }, 90_000);
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.equal(done.result?.summary, 'You prefer dark roast coffee.');
    assert.equal(done.plan?.length, 1);
    assert.equal(done.plan![0].skill, 'memory.search');
    assert.equal(done.plan![0].status, 'done');
    assert.ok(done.plan![0].verification, 'verified by the skill runner');
    assert.ok(done.harnessState && done.harnessState.messages.length >= 3, 'Hermes conversation stored for continuation');
    const types = app.tasks.events(task.id).map((e) => e.type);
    for (const t of ['harness_started', 'step_started', 'step_completed', 'harness_finished', 'completed']) assert.ok(types.includes(t), `event ${t} in ${types.join(',')}`);
    // Hermes offered the model ONLY Jarvis skills (encoded names), none of its own tools.
    assert.ok(seen[0].length > 5 && seen[0].every((n) => /^[a-z]+__[a-z_]+$/.test(n)), seen[0].join(','));
    assert.ok(seen[0].includes('memory__search') && !seen[0].includes('security__operate'));
    // The call is in the skill audit log like any native step.
    const audit = app.db.all<{ skill: string; task_id: string }>("SELECT skill, task_id FROM audit_log WHERE task_id = ? AND outcome = 'success'", task.id);
    assert.deepEqual(audit.map((a) => a.skill), ['memory.search']);
  } finally {
    await stop();
  }
});

test('Hermes: an action outside the request waits for approval; denied means not done', { skip, timeout: 120_000 }, async () => {
  const { app, model, stop } = await hermesJarvis();
  try {
    model.setResponses([
      palsuToolCall('files__write', { path: 'note.txt', content: 'hello', mode: 'create' }, 'w1'),
      (messages) => palsuText(JSON.stringify(messages.at(-1)).includes('denied') ? 'I did not write the file because you denied it.' : 'Wrote it.'),
    ]);
    const { task } = app.engine.createTask({ title: 'Tidy up', origin: 'user' });
    const waiting = await waitFor(() => (app.tasks.get(task.id)!.status === 'awaiting_approval' ? app.tasks.get(task.id) : null), 90_000, 'approval request').catch((e) => {
      console.log('DEBUG', app.tasks.get(task.id)!.status, app.tasks.events(task.id).map((x) => `${x.type}: ${x.message}`).join('\n'));
      throw e;
    });
    const approval = app.permissions.listApprovals('pending').find((a) => a.taskId === task.id)!;
    assert.equal(approval.skill, 'files.write');
    assert.equal(waiting!.plan!.at(-1)!.status, 'awaiting_approval');
    app.permissions.decideApproval(approval.id, 'deny');
    const done = await waitFor(() => {
      const t = app.tasks.get(task.id)!;
      return ['completed', 'failed'].includes(t.status) ? t : null;
    }, 60_000);
    assert.equal(done.result?.summary, 'I did not write the file because you denied it.');
    assert.equal(done.plan![0].status, 'failed');
    assert.equal(done.result?.verified, false, 'a denied step means the task is not reported as fully verified');
    assert.ok(!existsSync(join(app.workspaceDir(), 'note.txt')), 'nothing was written');
  } finally {
    await stop();
  }
});

test('Hermes: approved action runs once, then Hermes finishes', { skip, timeout: 120_000 }, async () => {
  const { app, model, stop } = await hermesJarvis();
  try {
    model.setResponses([palsuToolCall('files__write', { path: 'approved.txt', content: 'yes', mode: 'create' }, 'w1'), palsuText('Saved approved.txt.')]);
    const { task } = app.engine.createTask({ title: 'Save a file', origin: 'user' });
    await waitFor(() => app.tasks.get(task.id)!.status === 'awaiting_approval', 90_000, 'approval request');
    const approval = app.permissions.listApprovals('pending').find((a) => a.taskId === task.id)!;
    app.permissions.decideApproval(approval.id, 'approve');
    const done = await waitFor(() => {
      const t = app.tasks.get(task.id)!;
      return ['completed', 'failed'].includes(t.status) ? t : null;
    }, 60_000);
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.equal(done.plan![0].status, 'done');
    assert.equal(app.permissions.getApproval(approval.id)!.status, 'used', 'the approval was consumed by exactly one execution');
  } finally {
    await stop();
  }
});

test('Hermes: cancelling a task stops the run; the model endpoint refuses callers without a live run', { skip, timeout: 120_000 }, async () => {
  const { app, model, stop } = await hermesJarvis();
  try {
    model.setResponses([palsuToolCall('files__write', { path: 'never.txt', content: 'x', mode: 'create' }, 'w1')]);
    const { task } = app.engine.createTask({ title: 'Something long', origin: 'user' });
    await waitFor(() => app.tasks.get(task.id)!.status === 'awaiting_approval', 90_000, 'approval request');
    app.engine.cancel(task.id);
    await waitFor(() => !app.engine.runningIds().includes(task.id), 20_000, 'run stopped');
    assert.equal(app.tasks.get(task.id)!.status, 'cancelled');
    const res = await fetch(`${(app.harness as unknown as { serverUrl: string }).serverUrl}/harness/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{"messages":[]}' });
    assert.equal(res.status, 401);
  } finally {
    await stop();
  }
});
