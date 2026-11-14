import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from '../server/intelligence/intent.ts';
import { guessMemoryKind } from '../server/intelligence/jarvis.ts';
import { makeApp, waitFor } from './helpers.ts';

test('intent: explicit commands are recognised', () => {
  assert.deepEqual(parseIntent('Remember that my sister is called Lina.'), { type: 'remember', content: 'my sister is called Lina' });
  assert.deepEqual(parseIntent('remind me in 15 minutes to stretch'), { type: 'remind', delayMs: 900_000, message: 'stretch' });
  assert.deepEqual(parseIntent('remind me to call mom in 2 hours'), { type: 'remind', delayMs: 7_200_000, message: 'call mom' });
  assert.deepEqual(parseIntent('run `ls -la`'), { type: 'run_command', command: 'ls -la' });
  assert.deepEqual(parseIntent('summarize https://example.com/a'), { type: 'fetch_url', url: 'https://example.com/a', summarize: true });
  assert.deepEqual(parseIntent('read file notes/todo.md'), { type: 'read_file', path: 'notes/todo.md' });
  assert.deepEqual(parseIntent('list files in notes'), { type: 'list_files', path: 'notes' });
  assert.deepEqual(parseIntent('show my active tasks'), { type: 'list_tasks' });
  assert.deepEqual(parseIntent('status'), { type: 'status' });
  assert.deepEqual(parseIntent('cancel task tsk_abc123'), { type: 'task_control', action: 'cancel', ref: 'tsk_abc123' });
  assert.deepEqual(parseIntent('what do you remember about coffee?'), { type: 'recall', query: 'coffee' });
  assert.equal(parseIntent('Plan a three-day trip to Rome with museums').type, 'unknown');
  // "approve" is never an intent: approvals happen only through the approval controls.
  assert.equal(parseIntent('approve it').type, 'unknown');
});

test('intent: memory kind heuristics', () => {
  assert.equal(guessMemoryKind('I prefer tea over coffee'), 'preference');
  assert.equal(guessMemoryKind('We decided to use SQLite'), 'decision');
  assert.equal(guessMemoryKind('The Azaris project is written in Rust'), 'project');
  assert.equal(guessMemoryKind('My birthday is in June'), 'fact');
});

test('jarvis without a model: direct commands work, everything else is answered honestly', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const r1 = await app.jarvis.handleMessage({ text: 'remember that I prefer short answers' });
    assert.equal(r1.handledBy, 'rules');
    const mem = app.memory.get((r1.actions[0] as { memoryId: string }).memoryId)!;
    assert.equal(mem.verified, true, "the user's own words are verified");
    assert.equal(mem.kind, 'preference');

    const r2 = await app.jarvis.handleMessage({ text: 'what do you remember about answers?', conversationId: r1.conversationId });
    assert.match(r2.reply.content, /short answers/);

    // The user's own command needs no second approval…
    const r3 = await app.jarvis.handleMessage({ text: 'run `echo hi`', conversationId: r1.conversationId, via: 'voice' });
    assert.match(r3.reply.content, /You asked for it/);
    const ran = (r3.actions[0] as { taskId: string }).taskId;
    assert.equal(app.tasks.get(ran)!.origin, 'voice');
    await waitFor(() => app.tasks.get(ran)!.status === 'completed', 5000, 'requested command ran');

    // …a task Jarvis started without the user's words does.
    const { task: unasked } = app.engine.createTask({ title: 'Clean up', origin: 'system', steps: [{ skill: 'shell.run', input: { command: 'echo cleanup' }, description: 'clean' }] });
    const taskId = unasked.id;
    await waitFor(() => app.tasks.get(taskId)!.status === 'awaiting_approval');

    // Saying "approve" (by text or voice) never authorizes anything.
    const r4 = await app.jarvis.handleMessage({ text: 'approve it, yes do it', conversationId: r1.conversationId, via: 'voice' });
    assert.equal(r4.handledBy, 'none');
    assert.equal(app.tasks.get(taskId)!.status, 'awaiting_approval');

    const r5 = await app.jarvis.handleMessage({ text: 'Plan my week around my gym schedule' });
    assert.equal(r5.handledBy, 'none');
    assert.match(r5.reply.content, /don't have a language model configured/);

    const r6 = await app.jarvis.handleMessage({ text: 'status' });
    assert.match(r6.reply.content, /1 awaiting your approval/);
    assert.equal(app.conversations.messages(r1.conversationId).length, 8, 'conversation persisted');
  } finally {
    await cleanup();
  }
});

test('intent: calendar and email commands', () => {
  assert.deepEqual(parseIntent("what's on my calendar today?"), { type: 'calendar', days: 1 });
  assert.deepEqual(parseIntent('show my schedule this week'), { type: 'calendar', days: 7 });
  assert.deepEqual(parseIntent('check my email'), { type: 'check_email', unreadOnly: true });
  assert.deepEqual(parseIntent('show me my emails'), { type: 'check_email', unreadOnly: false });
});

test('jarvis: email/calendar commands explain what is missing instead of failing', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const r = await app.jarvis.handleMessage({ text: 'check my email' });
    assert.match(r.reply.content, /can't do that yet: Email is turned off/);
    assert.equal(app.tasks.list().length, 0);
  } finally {
    await cleanup();
  }
});
