import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { makeApp, roamiesConfig, waitFor } from './helpers.ts';

interface FakeModel {
  id: string;
  capabilities: string[];
  numCtx?: number;
}

/** A fake Ollama: model list, capabilities (/api/show) and streamed OpenAI-style chat completions. */
async function fakeOllama(models: FakeModel[], reply: (body: any, n: number) => { text?: string; toolCall?: { name: string; args: unknown } }) {
  const chats: any[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const json = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (req.url === '/v1/models') return json({ object: 'list', data: models.map((m) => ({ id: m.id, object: 'model' })) });
    if (req.url === '/api/ps') return json({ models: [] });
    if (req.url === '/api/show') {
      const m = models.find((x) => x.id === body.model)!;
      return json({ capabilities: m.capabilities, parameters: m.numCtx ? `num_ctx ${m.numCtx}` : '' });
    }
    if (req.url === '/v1/chat/completions') {
      chats.push(body);
      const out = reply(body, chats.length);
      const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (out.toolCall) {
        res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${chats.length}`, type: 'function', function: { name: out.toolCall.name, arguments: JSON.stringify(out.toolCall.args) } }] }));
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: out.text ?? '' }));
        res.write(chunk({}, 'stop'));
      }
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    host: `127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}`,
    chats,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

const MODELS: FakeModel[] = [
  { id: 'deepseek-r1:14b', capabilities: ['completion', 'thinking'], numCtx: 32768 },
  { id: 'qwen3:8b', capabilities: ['completion', 'tools'], numCtx: 32768 },
];

test('local: a running Ollama is used with nothing signed in; tool-capable models get Jarvis’s tools', async () => {
  const ollama = await fakeOllama(MODELS, (_b, n) => (n === 1 ? { toolCall: { name: 'tasks__list', args: {} } } : { text: 'You have no open tasks.' }));
  process.env.OLLAMA_HOST = ollama.host;
  const { app, cleanup } = await makeApp();
  try {
    await app.llm.refresh(true);
    const s = app.llm.status();
    assert.equal(s.ready, true, s.problem ?? '');
    assert.equal(s.source, 'auto');
    assert.equal(s.provider?.id, 'local');
    assert.equal(s.model?.id, 'local/ollama/qwen3:8b', 'prefers a model that can use tools');
    assert.equal(s.tools, true);
    assert.deepEqual(s.local[0].models.map((m) => [m.name, m.tools]), [['deepseek-r1:14b', false], ['qwen3:8b', true]]);

    const res = await app.jarvis.handleMessage({ text: 'Which tasks do I have open right now?' });
    assert.equal(res.reply.content, 'You have no open tasks.');
    assert.equal(ollama.chats[0].model, 'qwen3:8b', 'the raw Ollama model name goes on the wire');
    assert.ok(ollama.chats[0].tools.some((t: any) => t.function.name === 'plan_task'));
    const toolMsg = ollama.chats[1].messages.at(-1);
    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_1');
  } finally {
    await cleanup();
    await ollama.close();
    process.env.OLLAMA_HOST = '127.0.0.1:1';
  }
});

test('local: a model picked in Roamies without tool support (DeepSeek) still chats; content passes through untouched', async () => {
  const ollama = await fakeOllama(MODELS, (b) => ({ text: `DeepSeek says: ${b.messages.at(-1).content.split('\n\n').at(-1)}` }));
  process.env.OLLAMA_HOST = ollama.host;
  const { app, cleanup } = await makeApp();
  try {
    roamiesConfig({ provider: 'local', model: 'local/ollama/deepseek-r1:14b' });
    await app.llm.refresh(true);
    const s = app.llm.status();
    assert.equal(s.ready, true);
    assert.equal(s.source, 'roamies');
    assert.equal(s.tools, false);
    assert.match(s.warning!, /can't use tools/);

    // Jarvis adds no content rules of its own: the message reaches the model as written and its answer comes back as written.
    const text = 'Write the darkest joke you know about dragons.';
    const res = await app.jarvis.handleMessage({ text });
    assert.equal(res.reply.content, `DeepSeek says: ${text}`);
    const sent = ollama.chats[0];
    assert.equal(sent.model, 'deepseek-r1:14b');
    assert.equal(sent.tools, undefined, 'no tools offered to a model that cannot use them');
    assert.match(sent.messages[0].content, /you cannot use tools/);
    assert.doesNotMatch(sent.messages[0].content, /refuse|inappropriate|harmful|policy violation/i, 'no content guardrails added by Jarvis');

    // Direct commands still work without tools; planning explains honestly.
    const remembered = await app.jarvis.handleMessage({ text: 'remember that I run DeepSeek locally' });
    assert.equal(remembered.handledBy, 'rules');
    const { task } = app.engine.createTask({ title: 'Organise my week', origin: 'user' });
    const t = await waitFor(() => {
      const x = app.tasks.get(task.id)!;
      return x.status === 'paused' ? x : null;
    });
    assert.match(t.attention!, /can't use tools, so it can't plan tasks/);
  } finally {
    await cleanup();
    await ollama.close();
    process.env.OLLAMA_HOST = '127.0.0.1:1';
  }
});

test('local: Ollama not running or missing the model is reported plainly; extra servers (LM Studio, llama.cpp) can be added', async () => {
  const { app, cleanup } = await makeApp();
  const other = await fakeOllama([{ id: 'mistral-small', capabilities: [] }], () => ({ text: 'Hello from LM Studio' }));
  try {
    roamiesConfig({ provider: 'local', model: 'local/ollama/deepseek-r1:14b' });
    await app.llm.refresh(true);
    assert.equal(app.llm.status().ready, false);
    assert.match(app.llm.status().problem!, /Ollama isn't running/);

    // Add a server by address (OpenAI-compatible); its models appear and can be chosen in Jarvis.
    await app.llm.refresh(true);
    app.settings.update({ llm: { localServers: [`${other.url}/v1`] } });
    await app.llm.discoverLocal(true);
    await app.llm.refresh(true);
    const server = app.llm.status().local.find((l) => l.kind === 'custom')!;
    assert.equal(server.reachable, true);
    const id = server.models[0].id;
    assert.match(id, /^local\/server-127-0-0-1-\d+\/mistral-small$/);
    app.settings.update({ llm: { model: id } });
    await app.llm.refresh(true);
    assert.equal(app.llm.status().ready, true, app.llm.status().problem ?? '');
    assert.equal(app.llm.status().source, 'jarvis');
    const res = await app.jarvis.handleMessage({ text: 'Say hello from the other server' });
    assert.equal(res.reply.content, 'Hello from LM Studio');
    assert.equal(other.chats[0].model, 'mistral-small');
  } finally {
    await cleanup();
    await other.close();
  }
});
