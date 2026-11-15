import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.ts';

const seed = (app: Awaited<ReturnType<typeof makeApp>>['app']) => {
  const t = Date.now();
  app.db.run('INSERT INTO h1_earnings (id, amount, currency, program, report_id, awarded_at, synced_at) VALUES (?,?,?,?,?,?,?)', 'e1', 1500, 'usd', 'acme', null, t - 5 * 86_400_000, t);
  app.db.run('INSERT INTO h1_earnings (id, amount, currency, program, report_id, awarded_at, synced_at) VALUES (?,?,?,?,?,?,?)', 'e2', 500, 'usd', 'acme', null, t - 40 * 86_400_000, t);
  // One baseline program (older), one newly discovered — both pay bounties.
  app.db.run('INSERT INTO h1_programs (handle, name, currency, offers_bounties, state, url, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?,?,?,?)', 'acme', 'Acme', 'usd', 1, 'open', 'https://hackerone.com/acme', t - 20 * 86_400_000, t, '{}');
  app.db.run('INSERT INTO h1_programs (handle, name, currency, offers_bounties, state, url, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?,?,?,?)', 'tinycorp', 'TinyCorp', 'usd', 1, 'open', 'https://hackerone.com/tinycorp', t, t, '{}');
};
const memOf = (app: Awaited<ReturnType<typeof makeApp>>['app'], id: string) =>
  app.db.all<{ content: string }>("SELECT content FROM memories WHERE source = ? ORDER BY created_at DESC", `agent:${id}`);

test('sub-agents: the roster has colored specialists, each with its own memory', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const roster = app.subAgents.list();
    assert.deepEqual(roster.map((a) => a.id), ['friday', 'tom', 'neo', 'sentinel', 'echo', 'trinity']);
    assert.deepEqual(
      roster.map((a) => a.color),
      ['#ef4444', '#22d3ee', '#15803d', '#f59e0b', '#a855f7', '#f43f5e'],
      'Friday red, Tom cyan, Neo dark green, Sentinel amber, Echo violet, Trinity rose',
    );
    assert.ok(roster.every((a) => a.state === 'idle' && a.runs === 0));
  } finally {
    await cleanup();
  }
});

test('sub-agents: Friday tracks profit, Tom finds small new programs, and both remember', async () => {
  const { app, cleanup } = await makeApp();
  try {
    seed(app);
    app.settings.update({ agents: { spendUsd: 500 } });

    const friday = await app.subAgents.runAgent('friday');
    assert.equal(friday.state, 'idle');
    assert.equal(friday.runs, 1);
    assert.match(friday.lastSummary, /In profit: net USD 1,500/); // 2000 earned - 500 spend
    assert.match(memOf(app, 'friday')[0].content, /earned USD 2,000.*net USD 1,500/s);

    // At a loss when spend exceeds earnings.
    app.settings.update({ agents: { spendUsd: 5000 } });
    const loss = await app.subAgents.runAgent('friday');
    assert.match(loss.lastSummary, /At a loss: net USD -3,000/);

    const tom = await app.subAgents.runAgent('tom');
    assert.match(tom.lastSummary, /1 promising new program.*TinyCorp/);
    assert.match(memOf(app, 'tom')[0].content, /TinyCorp \(tinycorp\).*pays bounties/s);

    // Neo watches tasks and flags the missing HackerOne key.
    const neo = await app.subAgents.runAgent('neo');
    assert.match(neo.lastSummary, /keys HackerOne MISSING/);
    assert.match(memOf(app, 'neo')[0].content, /HackerOne MISSING/);

    // Echo compiles a digest from the others.
    const echo = await app.subAgents.runAgent('echo');
    assert.match(echo.lastSummary, /Digest of \d+ agent/);
    assert.match(memOf(app, 'echo')[0].content, /Friday:.*Tom:/s);
  } finally {
    await cleanup();
  }
});

test('sub-agents: findings join one shared Obsidian knowledge mind', async () => {
  const { app, cleanup } = await makeApp();
  try {
    seed(app);
    await app.subAgents.runAgent('friday');
    await app.subAgents.runAgent('tom');
    const notes = app.obsidian.buildNotes();

    // Each agent gets its own note holding what it learned…
    const friday = notes.get('Agents/Friday.md');
    assert.ok(friday, 'Friday has a vault note');
    assert.match(friday!, /# Friday/);
    assert.match(friday!, /earned USD 2,000/);
    assert.match(notes.get('Agents/Tom.md')!, /TinyCorp/);

    // …and an index ties the team into one mind Jarvis can recall.
    const idx = notes.get('Agents/Agents.md');
    assert.ok(idx, 'the shared-mind index exists');
    assert.match(idx!, /one mind/i);
    for (const name of ['Friday', 'Tom', 'Neo', 'Sentinel', 'Echo']) assert.match(idx!, new RegExp(`\\[\\[Agents/${name}`));

    // The same findings are also plain memories, so Jarvis (and every other agent) can search them.
    const recalled = app.memory.keywordSearch('TinyCorp');
    assert.ok(recalled.some((m) => /TinyCorp/.test(m.content)), 'an agent memory is recallable by search');
  } finally {
    await cleanup();
  }
});

test('sub-agents: an agent error is captured, not thrown', async () => {
  const { app, cleanup } = await makeApp();
  try {
    await assert.rejects(() => app.subAgents.runAgent('nobody'), /No sub-agent/);
    const sentinel = await app.subAgents.runAgent('sentinel');
    assert.equal(sentinel.error, null);
    assert.match(sentinel.lastSummary, /program\(s\) in scope/);
  } finally {
    await cleanup();
  }
});
