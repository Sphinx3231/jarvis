import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ftsQuery, similarity } from '../server/memory/store.ts';
import { makeApp } from './helpers.ts';

test('memory: add, search, update, delete', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const { memory } = app.memory.add({ kind: 'preference', content: 'I prefer dark roast coffee in the morning', source: 'user', verified: true });
    assert.equal(memory.verified, true);
    assert.equal(memory.confidence, 1);
    const found = app.memory.keywordSearch('coffee');
    assert.equal(found[0].id, memory.id);

    const updated = app.memory.update(memory.id, { content: 'I prefer light roast coffee' });
    assert.equal(updated.content, 'I prefer light roast coffee');
    assert.ok(updated.sources.includes('user (edited)'));
    assert.equal(app.memory.keywordSearch('dark').length, 0, 'FTS index follows updates');
    assert.equal(app.memory.keywordSearch('light')[0].id, memory.id);

    assert.equal(app.memory.delete(memory.id), true);
    assert.equal(app.memory.get(memory.id), undefined);
    assert.equal(app.memory.keywordSearch('coffee').length, 0, 'FTS index follows deletes');
  } finally {
    await cleanup();
  }
});

test('memory: exact and near duplicates are merged, preserving provenance', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const a = app.memory.add({ kind: 'project', content: 'The Azaris project uses PostgreSQL 16.', source: 'jarvis (inferred)', verified: false, confidence: 0.5 });
    const b = app.memory.add({ kind: 'project', content: 'the azaris project uses postgresql 16', source: 'user', verified: true });
    assert.equal(b.merged, true);
    assert.equal(b.memory.id, a.memory.id);
    assert.equal(b.memory.verified, true, 'verified evidence upgrades verification');
    assert.deepEqual(b.memory.sources.sort(), ['jarvis (inferred)', 'user']);
    const c = app.memory.add({ kind: 'project', content: 'Azaris project uses PostgreSQL 16', source: 'user' });
    assert.equal(c.merged, true, 'near-duplicate merged');
    const e = app.memory.add({ kind: 'project', content: 'The Azaris project uses PostgreSQL 16 but not Redis.', source: 'user' });
    assert.equal(e.merged, false, 'a statement that adds meaning is not merged');
    app.memory.delete(e.memory.id);
    assert.equal(app.memory.stats().byKind.project, 1);
    const d = app.memory.add({ kind: 'decision', content: 'The Azaris project uses PostgreSQL 16.', source: 'user' });
    assert.equal(d.merged, false, 'different kinds are kept separate');
  } finally {
    await cleanup();
  }
});

test('memory: unverified items rank below verified ones and retrieval records access', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const guess = app.memory.add({ kind: 'fact', content: 'User probably lives in Berlin', source: 'jarvis (inferred)', verified: false, confidence: 0.4 });
    const fact = app.memory.add({ kind: 'fact', content: 'User lives in Cairo and works remotely', source: 'user', verified: true });
    const results = app.memory.retrieve('where does the user live', { limit: 5 });
    assert.equal(results[0].id, fact.memory.id);
    assert.ok(results.some((r) => r.id === guess.memory.id));
    assert.equal(app.memory.get(fact.memory.id)!.accessCount, 1);
    assert.ok(!results.some((r) => r.kind === 'tool_doc'), 'tool docs excluded by default');
  } finally {
    await cleanup();
  }
});

test('memory: semantic search with stored embeddings', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const a = app.memory.add({ kind: 'fact', content: 'alpha', source: 'user' });
    const b = app.memory.add({ kind: 'fact', content: 'beta', source: 'user' });
    app.memory.setEmbedding(a.memory.id, [1, 0, 0], 'test');
    app.memory.setEmbedding(b.memory.id, [0, 1, 0], 'test');
    const res = app.memory.semanticSearch([0.9, 0.1, 0], { model: 'test' });
    assert.equal(res[0].id, a.memory.id);
    assert.equal(app.memory.get(a.memory.id)!.hasEmbedding, true);
    assert.equal(app.memory.missingEmbeddings(10, 'test').filter((m) => m.id === a.memory.id || m.id === b.memory.id).length, 0);
  } finally {
    await cleanup();
  }
});

test('memory: tool documentation is synced from the skill registry', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const docs = app.memory.list({ kind: 'tool_doc', limit: 100 });
    assert.equal(docs.length, app.registry.all().length);
    assert.ok(docs.some((d) => d.content.includes('web.fetch')));
    assert.ok(app.memory.retrieve('fetch a web page', { includeToolDocs: true }).some((m) => m.sourceRef === 'skill:web.fetch'));
  } finally {
    await cleanup();
  }
});

test('memory: dedupe merges near-duplicates created by edits', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const a = app.memory.add({ kind: 'procedure', content: 'Deploy with npm run deploy after tests pass', source: 'user', verified: true });
    const b = app.memory.add({ kind: 'procedure', content: 'Release checklist: bump version', source: 'user' });
    app.memory.update(b.memory.id, { content: 'Deploy with npm run deploy after the tests pass' });
    assert.equal(app.memory.dedupe(), 1);
    assert.ok(app.memory.get(a.memory.id));
    assert.equal(app.memory.get(b.memory.id), undefined);
  } finally {
    await cleanup();
  }
});

test('memory: query helpers are safe against FTS syntax', () => {
  assert.equal(ftsQuery('"); DROP TABLE memories; --'), '"drop" OR "table" OR "memories" OR "memor"*');
  assert.equal(ftsQuery('!!!'), null);
  assert.ok(similarity('Hello world', 'hello, world!') > 0.95);
  assert.ok(similarity('cats', 'quantum physics') < 0.2);
});

test('memory: persists across restarts', async () => {
  const first = await makeApp();
  const id = first.app.memory.add({ kind: 'preference', content: 'Use metric units', source: 'user', verified: true }).memory.id;
  await first.app.stop();
  const second = await makeApp({ dataDir: first.dir });
  try {
    assert.equal(second.app.memory.get(id)?.content, 'Use metric units');
  } finally {
    await second.cleanup();
    await first.cleanup();
  }
});
