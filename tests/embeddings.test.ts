import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadLocalModel, LOCAL_MODEL, LocalModelManager, WordPieceTokenizer } from '../server/llm/local-embeddings.ts';
import { makeApp, tempDir, waitFor } from './helpers.ts';

const cache = process.env.JARVIS_MODEL_DIR!;
let available = true;
try {
  await new LocalModelManager(cache).ensure();
} catch (err) {
  available = false;
  console.log(`# built-in model unavailable (${(err as Error).message}); semantic tests skipped`);
}

test('keyword search matches other forms of the same word', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const m = app.memory.add({ kind: 'preference', content: 'Summaries should be three bullet points', source: 'user', verified: true }).memory;
    assert.equal(app.memory.retrieve('please summarise example.com')[0]?.id, m.id);
  } finally {
    await cleanup();
  }
});

test('model download is verified by SHA-256 and leaves nothing behind on failure', async () => {
  const dir = tempDir('model-');
  const fakeFetch = (async () => new Response('not the model')) as typeof fetch;
  await assert.rejects(downloadLocalModel(dir, undefined, fakeFetch), /integrity check/);
  assert.equal(existsSync(join(dir, 'model_quantized.onnx')), false);
  const mgr = new LocalModelManager(dir, fakeFetch);
  await assert.rejects(mgr.ensure());
  assert.equal(mgr.state, 'error');
  assert.equal(mgr.get(), null, 'no embedder from a failed download');
});

test('tokenizer matches BERT uncased ids', { skip: !available }, () => {
  const tok = new WordPieceTokenizer(readFileSync(join(cache, 'vocab.txt'), 'utf8'));
  assert.deepEqual(tok.encode('Hello, world!'), [101, 7592, 1010, 2088, 999, 102]);
  assert.deepEqual(tok.encode('Héllo'), tok.encode('hello'), 'accents stripped, lowercased');
  assert.ok(tok.encode('x '.repeat(1000)).length <= 256, 'truncated to the model limit');
});

test('built-in semantic search finds memories by meaning, on this computer', { skip: !available }, async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ embeddings: { enabled: true, providerId: 'builtin' } });
    assert.equal(app.localModel.state, 'ready');
    const pet = app.memory.add({ kind: 'fact', content: 'My dog is called Rex', source: 'user', verified: true }).memory;
    app.memory.add({ kind: 'fact', content: 'The quarterly tax filing is due in April', source: 'user', verified: true });
    await waitFor(() => app.memory.stats().embedded >= 2 + app.registry.all().length, 15_000, 'memories embedded automatically');
    const embedder = app.llm.embeddings()!;
    assert.equal(embedder.model, LOCAL_MODEL.id);
    const [vector] = await embedder.embed(["what is my pet's name?"]);
    assert.equal(vector.length, 384);
    assert.ok(!app.memory.keywordSearch("what is my pet's name?").some((m) => m.id === pet.id), 'keywords alone cannot find it');
    const found = app.memory.retrieve("what is my pet's name?", { queryVector: vector, embeddingModel: embedder.model });
    assert.equal(found[0]?.id, pet.id);
    assert.equal(found[0]?.matchedBy, 'semantic');
  } finally {
    await cleanup();
  }
});
