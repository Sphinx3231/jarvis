import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeApp } from './helpers.ts';
import { isCloudModel, isLocalUrl, recoverTextToolCalls, stripThinking } from '../server/llm/openjarvis.ts';

/**
 * OpenJarvis brain + local voice.
 *
 * 1. Contract tests against a stand-in OpenJarvis (same endpoints and payload shapes as `jarvis serve`):
 *    the tool loop, local-only filtering of cloud models, local voice routes, Roamies no longer required.
 * 2. A REAL integration test against an actual OpenJarvis server when JARVIS_TEST_OPENJARVIS points at
 *    one (e.g. http://127.0.0.1:8000 backed by llama.cpp/Ollama): tool use, Kokoro speech, Whisper
 *    transcription of that speech, and Jarvis acting on what it heard — all on this computer.
 */

interface Captured {
  path: string;
  body: Record<string, unknown> | null;
}

async function fakeOpenJarvis(opts: { owners?: Record<string, string>; speech?: boolean } = {}) {
  const calls: Captured[] = [];
  const owners = opts.owners ?? { 'qwen3:8b': 'openjarvis', 'google/gemma-3-12b-it': 'nim', 'bigcode/starcoder2-15b': 'nim' };
  const read = (req: IncomingMessage) => new Promise<Buffer>((r) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => r(Buffer.concat(chunks)));
  });
  const server: Server = createServer(async (req, res) => {
    const raw = await read(req);
    const path = req.url ?? '/';
    let body: Record<string, unknown> | null = null;
    if (req.headers['content-type']?.includes('json')) body = JSON.parse(raw.toString() || '{}');
    calls.push({ path, body });
    const json = (code: number, v: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (path === '/health') return json(200, { status: 'ok' });
    // NIM (cloud) models come first, like the real list: local-only must still pick the local one.
    if (path === '/v1/models') return json(200, { object: 'list', data: Object.entries(owners).reverse().map(([id, owned_by]) => ({ id, owned_by })) });
    if (path === '/v1/speech/health') return json(200, opts.speech === false ? { available: false, reason: 'No speech backend configured' } : { available: true, backend: 'faster-whisper' });
    if (path === '/v1/speech/tts/health') return json(200, { available: true, backend: 'kokoro', voice_id: 'bm_george' });
    if (path === '/v1/speech/transcribe') return json(200, { text: ' Hey Jarvis, what time is it? ', language: 'en' });
    if (path === '/v1/speech/synthesize') {
      res.writeHead(200, { 'content-type': 'audio/wav', 'x-voice-id': String(body?.voice_id ?? 'bm_george') });
      return res.end(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(200)]));
    }
    if (path === '/v1/chat/completions') {
      const msgs = (body?.messages ?? []) as Array<{ role: string; content: unknown }>;
      // Like the real server: content must be a string.
      if (msgs.some((m) => typeof m.content !== 'string')) return json(422, { detail: 'Input should be a valid string' });
      const hasToolResult = msgs.some((m) => m.role === 'tool');
      if (body?.tools && !hasToolResult) {
        return json(200, { model: body.model, choices: [{ finish_reason: 'tool_calls', message: { content: '<think>I should multiply.</think>', tool_calls: [{ id: 'c1', function: { name: 'calculator', arguments: '{"a":17,"b":23}' } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
      }
      const result = msgs.find((m) => m.role === 'tool')?.content;
      return json(200, { model: body?.model, choices: [{ finish_reason: 'stop', message: { content: `<think>done</think>The answer is ${result ?? 'unknown'}.` } }], usage: { prompt_tokens: 60, completion_tokens: 8 } });
    }
    json(404, { detail: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('openjarvis: helpers — cloud detection by owner, local URLs, <think> stripping, text tool-call recovery', () => {
  assert.equal(isCloudModel('google/gemma-3-12b-it', 'nim'), true);
  assert.equal(isCloudModel('bigcode/starcoder2-15b', 'nim'), true, 'by owner even when the id looks harmless');
  assert.equal(isCloudModel('qwen3:8b', 'openjarvis'), false);
  assert.equal(isCloudModel('qwen3:8b', 'ollama'), false);
  assert.equal(isCloudModel('gpt-4o'), true);
  assert.equal(isCloudModel('claude-sonnet'), true);
  assert.equal(isCloudModel('qwen3:30b-a3b'), false);
  assert.equal(isLocalUrl('http://127.0.0.1:8000'), true);
  assert.equal(isLocalUrl('http://192.168.1.20:8000'), true);
  assert.equal(isLocalUrl('https://api.openai.com/v1'), false);
  assert.equal(stripThinking('<think>hmm</think>Hello'), 'Hello');
  const calls = recoverTextToolCalls('<tool_call>{"name":"calculator","arguments":{"a":2,"b":3}}</tool_call>', [{ name: 'calculator', description: '', inputSchema: {} }]);
  assert.deepEqual(calls.map((c) => [c.name, c.input]), [['calculator', { a: 2, b: 3 }]]);
  assert.deepEqual(recoverTextToolCalls('{"name":"rm_rf","arguments":{}}', [{ name: 'calculator', description: '', inputSchema: {} }]), [], 'never invents a tool that was not offered');
});

test('openjarvis: is the default brain; Jarvis starts without Roamies; local-only picks the local model', async () => {
  const fake = await fakeOpenJarvis();
  const { app, cleanup } = await makeApp({ start: false });
  try {
    // A fresh real install: OpenJarvis brain, local-only, local voice.
    app.settings.update({ brain: { backend: 'openjarvis', openjarvisUrl: fake.url, model: '', localOnly: true }, voice: { transcription: { service: 'openjarvis' }, tts: { provider: 'local', voiceId: 'bm_george' } } });
    assert.equal(app.requiresRoamies(), false);
    assert.equal(app.unlocked, true, 'no Roamies needed');
    await app.start();
    await app.llm.refresh(true);
    const st = app.llm.status();
    assert.equal(st.backend, 'openjarvis');
    assert.equal(st.ready, true, st.problem ?? '');
    assert.equal(st.model?.id, 'qwen3:8b', 'the local model, not the NIM cloud ones listed first');
    assert.deepEqual(st.models.map((m) => m.id), ['qwen3:8b'], 'cloud models are not even offered');
    assert.equal(st.openjarvis?.speech?.available, true);
    assert.equal(st.openjarvis?.tts?.available, true);
    // Asking for a cloud model in local-only mode is refused, with the reason.
    app.settings.update({ brain: { model: 'google/gemma-3-12b-it' } });
    await app.llm.refresh(true);
    assert.equal(app.llm.status().ready, false);
    assert.match(app.llm.status().problem ?? '', /cloud model.*local-only/);
  } finally {
    await cleanup();
    await fake.close();
  }
});

test('openjarvis: the tool loop runs Jarvis tools on the local model (string content, thinking stripped)', async () => {
  const fake = await fakeOpenJarvis();
  const { app, cleanup } = await makeApp({ start: false });
  try {
    app.settings.update({ brain: { backend: 'openjarvis', openjarvisUrl: fake.url, model: '', localOnly: true } });
    await app.start();
    await app.llm.refresh(true);
    const seen: unknown[] = [];
    const r = await app.llm.run({
      system: 'You are Jarvis.',
      messages: [{ role: 'user', content: 'What is 17 times 23?' }],
      tools: [{ spec: { name: 'calculator', description: 'multiply', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }, execute: async (i) => (seen.push(i), { content: String(Number(i.a) * Number(i.b)) }) }],
    });
    assert.deepEqual(seen, [{ a: 17, b: 23 }], 'Jarvis executed the tool the model called');
    assert.equal(r.text, 'The answer is 391.');
    assert.equal(r.turns, 2);
    assert.equal(r.provider, 'openjarvis');
    const completions = fake.calls.filter((c) => c.path === '/v1/chat/completions');
    assert.equal(completions.length, 2);
    // The tools Jarvis offered went to OpenJarvis verbatim (so OpenJarvis returns raw tool calls).
    assert.equal(((completions[0].body!.tools as Array<{ function: { name: string } }>)[0]).function.name, 'calculator');
    assert.equal(completions[0].body!.model, 'qwen3:8b');
  } finally {
    await cleanup();
    await fake.close();
  }
});

test('openjarvis: local voice — speak with Kokoro, transcribe with Whisper; cloud voice/transcription refused in local-only mode', async () => {
  const fake = await fakeOpenJarvis();
  const { app, cleanup } = await makeApp({ start: false });
  try {
    app.settings.update({ brain: { backend: 'openjarvis', openjarvisUrl: fake.url, model: '', localOnly: true }, voice: { transcription: { service: 'openjarvis' }, tts: { provider: 'local', voiceId: 'bm_lewis' } } });
    await app.start();
    await app.llm.refresh(true);
    const heard = await app.llm.transcribe(Buffer.alloc(400), 'audio/webm', { language: 'en-GB' });
    assert.equal(heard.text, 'Hey Jarvis, what time is it?');
    assert.match(heard.provider, /OpenJarvis/);
    const spoken = await app.llm.openJarvis().synthesize('Good evening.', { voiceId: 'bm_lewis' });
    assert.equal(spoken.mime, 'audio/wav');
    assert.equal(spoken.voiceId, 'bm_lewis');
    // Local-only: the OpenAI transcription route and Fish Audio are unavailable.
    app.settings.update({ voice: { transcription: { service: 'openai' } } });
    assert.equal(await app.llm.transcriptionTarget(), null);
    app.settings.update({ voice: { transcription: { service: 'custom', baseUrl: 'https://api.example.com/v1' } } });
    assert.equal(await app.llm.transcriptionTarget(), null, 'a remote "custom" server is refused too');
    app.settings.update({ voice: { transcription: { service: 'custom', baseUrl: 'http://127.0.0.1:9999/v1' } } });
    assert.ok(await app.llm.transcriptionTarget(), 'a local Whisper server is fine');
  } finally {
    await cleanup();
    await fake.close();
  }
});

test('openjarvis: when OpenJarvis is down Jarvis says so and keeps handling direct commands', async () => {
  const { app, cleanup } = await makeApp({ start: false });
  try {
    app.settings.update({ brain: { backend: 'openjarvis', openjarvisUrl: 'http://127.0.0.1:9', model: '', localOnly: true } });
    await app.start();
    await app.llm.refresh(true);
    const st = app.llm.status();
    assert.equal(st.ready, false);
    assert.match(st.problem ?? '', /isn't running/);
    const r = await app.jarvis.handleMessage({ text: 'remember that the brain runs on OpenJarvis' });
    assert.match(r.reply.content, /remember/i);
  } finally {
    await cleanup();
  }
});

test('openjarvis: the Roamies lock screen offers a one-click switch to the local brain', async () => {
  const fake = await fakeOpenJarvis();
  const saved = process.env.JARVIS_ROAMIES_PATH;
  process.env.JARVIS_ROAMIES_PATH = '/nonexistent/Roamies.app';
  const { app, cleanup } = await makeApp({ start: false });
  try {
    app.settings.update({ brain: { backend: 'roamies', openjarvisUrl: fake.url } });
    app.gate.check();
    await app.start();
    assert.equal(app.unlocked, false, 'Roamies brain without Roamies: locked');
    const r = await app.useOpenJarvis();
    assert.equal(r.met, true);
    assert.equal(app.unlocked, true);
    const s = app.settings.get();
    assert.equal(s.brain.backend, 'openjarvis');
    assert.equal(s.brain.localOnly, true);
    assert.equal(s.voice.tts.provider, 'local');
    assert.equal(s.voice.transcription.service, 'openjarvis');
  } finally {
    await cleanup();
    await fake.close();
    process.env.JARVIS_ROAMIES_PATH = saved;
  }
});

const REAL = process.env.JARVIS_TEST_OPENJARVIS;
test('openjarvis REAL: local model uses a tool, Kokoro speaks, Whisper hears it back, Jarvis acts on it', { skip: REAL ? false : 'set JARVIS_TEST_OPENJARVIS=http://127.0.0.1:8000 with a running OpenJarvis', timeout: 600_000 }, async () => {
  const { app, cleanup } = await makeApp({ start: false });
  try {
    app.settings.update({ brain: { backend: 'openjarvis', openjarvisUrl: REAL!, model: process.env.JARVIS_TEST_OPENJARVIS_MODEL ?? '', localOnly: true }, voice: { transcription: { service: 'openjarvis' }, tts: { provider: 'local', voiceId: 'bm_george' } } });
    await app.start();
    await app.llm.refresh(true);
    const st = app.llm.status();
    assert.equal(st.ready, true, st.problem ?? '');
    assert.ok(st.models.every((m) => !isCloudModel(m.id, st.openjarvis?.models.find((x) => x.id === m.id)?.ownedBy)), 'only local models offered');
    let called: Record<string, unknown> | null = null;
    const r = await app.llm.run({
      system: 'You are Jarvis. Use the calculator tool for arithmetic. /no_think',
      messages: [{ role: 'user', content: 'What is 17 times 23? Use the calculator tool.' }],
      tools: [{ spec: { name: 'calculator', description: 'Multiply two numbers a and b', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }, execute: async (i) => ((called = i), { content: String(Number(i.a) * Number(i.b)) }) }],
    });
    assert.deepEqual(called, { a: 17, b: 23 }, `the local model did not call the tool; it replied: ${JSON.stringify(r.text.slice(0, 300))}`);
    assert.match(r.text, /391/);
    const wav = await app.llm.openJarvis().synthesize('Remember that my new computer is a mini PC.', { voiceId: 'bm_george' });
    assert.ok(wav.audio.length > 10_000, 'Kokoro produced audio');
    const heard = await app.llm.transcribe(wav.audio, 'audio/wav', { language: 'en' });
    assert.match(heard.text.toLowerCase(), /remember.*computer.*mini[ -]?pc/);
    const reply = await app.jarvis.handleMessage({ text: heard.text, via: 'voice' });
    assert.ok(reply.reply.content.length > 0);
    assert.ok(app.memory.list({ kind: 'fact', limit: 50 }).some((m) => /mini[ -]?pc/i.test(m.content)), 'Jarvis remembered what it heard');
  } finally {
    await cleanup();
  }
});
