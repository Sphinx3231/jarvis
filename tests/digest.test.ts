import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { palsuText, type Message } from '@kenkaiiii/gg-ai';
import { classifySentence, isStandingRule, parseDigestJson } from '../server/agents/digest.ts';
import { makeApp, tempDir, usePalsu, waitFor } from './helpers.ts';

const lastUserText = (messages: Message[]) => {
  const m = [...messages].reverse().find((x) => x.role === 'user');
  return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
};
const isDigestCall = (messages: Message[]) => messages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('writing your own private digest'));

test('digest: sentences are filed by category without a model; only clear standing instructions count as rules', () => {
  assert.equal(classifySentence('From now on, always answer in British English.'), 'rule');
  assert.equal(classifySentence('Never send an email without showing me the draft first.'), 'rule');
  assert.equal(classifySentence('Never mind, that was wrong.'), null);
  assert.equal(classifySentence('My dentist appointment is tomorrow at 3pm.'), 'schedule');
  assert.equal(classifySentence('We decided to go with the GEEKOM A6.'), 'decision');
  assert.equal(classifySentence("I'm planning to upgrade the RAM to 64 GB."), 'plan');
  assert.equal(classifySentence('What if Jarvis read my email every morning'), 'idea');
  assert.equal(classifySentence('I prefer short answers.'), 'preference');
  assert.equal(classifySentence('Can you find the cheapest flight to Cairo?'), 'request');
  assert.equal(classifySentence('How much RAM does the model need?'), 'question');
  assert.equal(isStandingRule('From now on, reply in English.'), true);
  assert.equal(isStandingRule('Make sure the server is up.'), false, 'a one-off command is not a standing rule');
  const parsed = parseDigestJson('<think>hmm</think>```json\n{"summary":"S","items":[{"category":"rules","text":"Reply briefly","repeated":true},{"category":"bogus","text":"x"}]}\n```');
  assert.deepEqual(parsed, { summary: 'S', items: [{ category: 'rule', text: 'Reply briefly', repeated: true }] });
  assert.equal(parseDigestJson('no json here'), null);
});

test('digest: a standing rule is kept the moment it is said and is in the context of every later turn, in any conversation', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const seen: string[] = [];
    await usePalsu(app, [
      (messages: Message[]) => (seen.push(lastUserText(messages)), palsuText('Understood.')),
      (messages: Message[]) => (seen.push(lastUserText(messages)), palsuText('Cheerio.')),
    ]);
    const r1 = await app.jarvis.handleMessage({ text: 'From now on, always answer in British English. Thanks!' });
    const rule = app.memory.list({ kind: 'rule' })[0];
    assert.ok(rule, 'the rule was stored immediately');
    assert.equal(rule.content, 'From now on, always answer in British English.');
    assert.equal(rule.verified, true, "the user's own words");
    assert.match(seen[0], /standing rules[\s\S]*British English/, 'already in the context of the reply to that very message');
    // A different conversation, about something else entirely, much later: the rule is still there.
    await app.jarvis.handleMessage({ text: 'How do I bake bread?' });
    assert.notEqual(r1.conversationId, undefined);
    assert.match(seen[1], /standing rules[\s\S]*British English/, 'standing rules reach every turn, whatever the topic');
  } finally {
    await cleanup();
  }
});

test('digest: the model writes Jarvis its own digest — summary, new vs repeated, filed by category — and nothing is digested twice', async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.memory.add({ kind: 'plan', content: 'Upgrade the GEEKOM A6 to 64 GB of RAM', source: 'user', verified: true });
    let digestPrompt = '';
    const scripted = await usePalsu(app, [palsuText('Noted.'), palsuText('Sure.')]);
    await app.jarvis.handleMessage({ text: 'I am going to upgrade the GEEKOM to 64 GB later.' });
    const r0 = app.conversations.list(1)[0];
    const r = await app.jarvis.handleMessage({ conversationId: r0.id, text: 'Remind me every Monday at 9am to check the backups, and never delete anything without asking.' });
    scripted.appendResponses((messages: Message[]) => {
      assert.ok(isDigestCall(messages));
      digestPrompt = lastUserText(messages);
      return palsuText(
        JSON.stringify({
          summary: 'The user plans the RAM upgrade, wants a weekly backup check and set a rule about deleting.',
          items: [
            { category: 'plan', text: 'Upgrade the GEEKOM A6 to 64 GB of RAM', repeated: true },
            { category: 'schedule', text: 'Every Monday at 9:00: check the backups', repeated: false },
            { category: 'rule', text: 'Never delete anything without asking the user first', repeated: false },
            { category: 'request', text: 'Set up a weekly reminder to check the backups', repeated: false },
          ],
        }),
      );
    });
    const d = await app.digester.digest(r.conversationId);
    assert.ok(d);
    assert.equal(d.method, 'model');
    assert.equal(d.messages, 4);
    assert.match(digestPrompt, /Upgrade the GEEKOM A6 to 64 GB/, 'the model is shown what Jarvis already knows, to tell new from repeated');
    assert.deepEqual(
      d.items.map((i) => [i.category, i.status]),
      [
        ['plan', 'repeated'],
        ['schedule', 'new'],
        ['rule', 'new'],
        ['request', 'new'],
      ],
    );
    assert.equal(d.newCount, 3);
    assert.equal(d.repeatedCount, 1);
    assert.ok(app.memory.list({ kind: 'schedule' }).some((m) => /Monday at 9:00/.test(m.content)));
    assert.ok(app.memory.list({ kind: 'rule' }).some((m) => /Never delete anything/.test(m.content)));
    assert.equal(app.memory.list({ kind: 'plan' }).length, 1, 'the repeated plan was merged, not duplicated');
    assert.equal(await app.digester.digest(r.conversationId), null, 'nothing new to digest');
    // The next turn carries the digest and the open request.
    let ctx = '';
    scripted.appendResponses((messages: Message[]) => ((ctx = lastUserText(messages)), palsuText('ok')));
    await app.jarvis.handleMessage({ text: 'What were we talking about?' });
    assert.match(ctx, /digests of recent conversations[\s\S]*weekly backup check/);
    assert.match(ctx, /Requests from the last week[\s\S]*weekly reminder/);
    assert.match(ctx, /Schedules:[\s\S]*Every Monday at 9:00/);
  } finally {
    await cleanup();
  }
});

test('digest: without a model (or if its answer is unusable) Jarvis keeps a quick digest from the user’s own words; the model redoes it later', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const r = await app.jarvis.handleMessage({ text: 'remember that the demo is on Friday' });
    app.conversations.addMessage(r.conversationId, 'user', "I'm planning to launch the store next month. What if we added a podcast? Can you draft the launch email?");
    assert.equal(app.llm.available(), false);
    const d = await app.digester.digest(r.conversationId);
    assert.ok(d);
    assert.equal(d.method, 'quick');
    const cats = d.items.map((i) => i.category);
    assert.ok(cats.includes('plan') && cats.includes('idea') && cats.includes('request'), cats.join(','));
    assert.match(d.summary, /launch the store/);
    // A model arrives: the quick digest is redone by it, in place.
    const scripted = await usePalsu(app);
    scripted.appendResponses(palsuText('{"summary":"Store launch next month; podcast idea; launch email requested.","items":[{"category":"plan","text":"Launch the store next month"}]}'));
    assert.equal(await app.digester.catchUp(undefined, { quietMs: 0 }), 1);
    const redone = app.digester.list({ conversationId: r.conversationId });
    assert.equal(redone.length, 1);
    assert.equal(redone[0].method, 'model');
    assert.match(redone[0].summary, /podcast idea/);
  } finally {
    await cleanup();
  }
});

test('digest: nothing is lost across a restart — conversations not digested before Jarvis stopped are digested on the next start', async () => {
  const dir = tempDir();
  const first = await makeApp({ dataDir: dir });
  const r = await first.app.jarvis.handleMessage({ text: 'Never schedule meetings before 10am.' });
  first.app.conversations.addMessage(r.conversationId, 'user', 'We decided to use Ollama for the engine.');
  await first.cleanup(); // stopped before any digest ran
  const second = await makeApp({ dataDir: dir });
  try {
    assert.equal(second.app.digester.list().length, 0);
    assert.equal(second.app.digester.stats().pendingConversations, 1);
    assert.equal(await second.app.digester.catchUp(undefined, { quietMs: 0 }), 1);
    const [d] = second.app.digester.list();
    assert.ok(d.items.some((i) => i.category === 'decision' && /Ollama/.test(i.text)));
    assert.ok(d.items.some((i) => i.category === 'rule' && i.status === 'new'), 'the rule kept the moment it was said is new in this conversation');
    assert.equal(second.app.memory.list({ kind: 'rule' }).length, 1, 'and stored once');
    assert.equal(second.app.digester.stats().pendingConversations, 0);
  } finally {
    await second.cleanup();
  }
});

test('digest: a conversation is digested automatically once it goes quiet; a user message interrupts a digest without losing it', async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ memory: { digestAfterSec: 1 } });
    const r = await app.jarvis.handleMessage({ text: 'remember that my mini PC is a GEEKOM A6' });
    await waitFor(() => app.digester.list({ conversationId: r.conversationId }).length > 0, 5000, 'automatic digest');
    app.settings.update({ memory: { digestAfterSec: 0 } });
    // An interrupted model digest stores nothing and leaves the conversation pending.
    const scripted = await usePalsu(app);
    app.conversations.addMessage(r.conversationId, 'user', 'I plan to add a second SSD.');
    scripted.appendResponses(() => {
      app.conversations.addMessage(r.conversationId, 'user', 'Actually wait.'); // the user talks again mid-digest
      return palsuText('{"summary":"x","items":[]}');
    });
    const before = app.digester.list().length;
    const interrupted = await app.digester.digest(r.conversationId);
    assert.equal(interrupted, null);
    assert.equal(app.digester.list().length, before, 'nothing stored');
    assert.equal(app.digester.stats().pendingConversations, 1, 'still pending: digested later');
  } finally {
    await cleanup();
  }
});

test('digest: every conversation goes to the vault with its digest, categories get their own notes, and the archive survives deletion', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const vault = join(tempDir('vaults-'), 'Jarvis Vault');
    const r = await app.jarvis.handleMessage({ text: 'From now on, call me Mo. What if Jarvis had a morning briefing?' });
    await app.digester.digest(r.conversationId);
    app.settings.update({ integrations: { obsidian: { enabled: true, vaultPath: vault } } });
    const rep = await app.obsidian.sync();
    assert.equal(rep.ok, true, rep.error ?? '');
    const convDir = join(vault, 'Conversations');
    const [convNote] = readdirSync(convDir);
    const conv = readFileSync(join(convDir, convNote), 'utf8');
    assert.match(conv, /## Jarvis’s digest/);
    assert.match(conv, /\*\*New\*\*[\s\S]*\*\*Rule:\*\* From now on, call me Mo\./);
    assert.match(conv, /\*\*Idea:\*\*/);
    assert.match(conv, /## Transcript[\s\S]*call me Mo/);
    const rules = readFileSync(join(vault, 'Knowledge', 'Rules.md'), 'utf8');
    assert.match(rules, /From now on, call me Mo\./);
    assert.ok(existsSync(join(vault, 'Knowledge', 'Schedules.md')) && existsSync(join(vault, 'Knowledge', 'Ideas.md')) && existsSync(join(vault, 'Knowledge', 'Plans.md')));
    const days = readdirSync(join(vault, 'Digests'));
    assert.ok(days.includes('Digests.md') && days.some((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)));
    assert.match(readFileSync(join(vault, 'Jarvis.md'), 'utf8'), /Knowledge\/Rules\|Rules/);
    // Deleted from Jarvis: the vault keeps the conversation and its digest.
    app.conversations.delete(r.conversationId);
    const rep2 = await app.obsidian.sync();
    assert.equal(rep2.ok, true);
    assert.ok(existsSync(join(convDir, convNote)), 'the conversation note is archived, not removed');
    assert.equal(app.digester.list().length, 1, 'the digest outlives the conversation');
  } finally {
    await cleanup();
  }
});

test('digest: conversations are kept forever by default; with a retention period each is digested before it goes', async () => {
  const { app, cleanup } = await makeApp();
  try {
    assert.equal(app.settings.get().memory.conversationRetentionDays, 0);
    const r = await app.jarvis.handleMessage({ text: "I'm planning to move to Alexandria next year." });
    app.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', Date.now() - 400 * 86_400_000, r.conversationId);
    await app.memoryAgent.maintain();
    assert.ok(app.conversations.get(r.conversationId), 'kept: retention 0 = forever');
    app.settings.update({ memory: { conversationRetentionDays: 30 } });
    await app.memoryAgent.maintain();
    assert.equal(app.conversations.get(r.conversationId), undefined, 'pruned once a retention period is set');
    const [d] = app.digester.list();
    assert.ok(d?.items.some((i) => i.category === 'plan' && /Alexandria/.test(i.text)), 'but digested first');
  } finally {
    await cleanup();
  }
});
