import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFiles, parseDotenv, resolveEnvSecret } from '../server/core/env.ts';
import { makeApp } from './helpers.ts';

test('env: a .env file supplies API keys, and app-set keys still win', () => {
  assert.deepEqual(parseDotenv('# a comment\nexport FISH_AUDIO_KEY="fk-123"\nHACKERONE_TOKEN = h1-tok \n\nBAD LINE\nEMPTY='), {
    FISH_AUDIO_KEY: 'fk-123',
    HACKERONE_TOKEN: 'h1-tok',
    EMPTY: '',
  });
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-env-'));
  try {
    writeFileSync(join(dir, '.env'), 'FISH_AUDIO_KEY=from-file\nHACKERONE_TOKEN=from-file');
    const env: NodeJS.ProcessEnv = { HACKERONE_TOKEN: 'already-set' };
    const r = loadEnvFiles(dir, env);
    assert.ok(r.files.some((f) => f.endsWith('.env')));
    assert.equal(env.FISH_AUDIO_KEY, 'from-file', 'unset keys are loaded');
    assert.equal(env.HACKERONE_TOKEN, 'already-set', 'the real environment is never overwritten');
    assert.deepEqual(r.keys, ['FISH_AUDIO_KEY']);
    // The known secret names resolve to their env vars.
    assert.equal(resolveEnvSecret('voice:tts:fishKey', env), 'from-file');
    assert.equal(resolveEnvSecret('hackerone:token', env), 'already-set');
    assert.equal(resolveEnvSecret('unknown:secret', env), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env: secrets fall back to .env; HackerOne and Fish pick up their keys without the UI', async () => {
  const prev = { h1: process.env.HACKERONE_TOKEN, fish: process.env.FISH_AUDIO_KEY };
  process.env.HACKERONE_TOKEN = 'h1-from-env-123456';
  process.env.FISH_AUDIO_KEY = 'fish-from-env-123456';
  const { app, cleanup } = await makeApp();
  try {
    // Read through the secret store (used everywhere).
    assert.equal(app.secrets.get('hackerone:token'), 'h1-from-env-123456');
    assert.equal(app.secrets.has('hackerone:token'), true);
    assert.equal(app.secrets.fromEnv('hackerone:token'), true);
    assert.equal(app.pipeline.hasToken(), true, 'the pipeline sees the HackerOne key from .env');
    assert.equal(app.tts.hasKey(), true, 'Fish Audio sees its key from .env');

    // A key set inside the app overrides .env.
    app.secrets.set('hackerone:token', 'h1-app-set');
    assert.equal(app.secrets.get('hackerone:token'), 'h1-app-set');
    assert.equal(app.secrets.fromEnv('hackerone:token'), false);
  } finally {
    await cleanup();
    process.env.HACKERONE_TOKEN = prev.h1;
    process.env.FISH_AUDIO_KEY = prev.fish;
    if (prev.h1 === undefined) delete process.env.HACKERONE_TOKEN;
    if (prev.fish === undefined) delete process.env.FISH_AUDIO_KEY;
  }
});

async function fakeFish(handler: (body: any, auth: string) => { status?: number; audio?: Buffer; text?: string }) {
  const calls: Array<{ body: any; auth: string }> = [];
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const auth = String(req.headers.authorization ?? '');
    calls.push({ body, auth });
    const out = handler(body, auth);
    if (out.audio) return res.writeHead(out.status ?? 200, { 'content-type': 'audio/mpeg' }).end(out.audio);
    res.writeHead(out.status ?? 200).end(out.text ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test('voice: Jarvis speaks through Fish Audio with the configured voice and key', async () => {
  const mp3 = Buffer.from([0xff, 0xf3, 0x44, 0x00, 1, 2, 3, 4]); // stand-in audio bytes
  const fish = await fakeFish((_b, auth) => (auth === 'Bearer fish-key-abcdef' ? { audio: mp3 } : { status: 401, text: 'bad key' }));
  process.env.JARVIS_FISH_API = fish.url;
  const { app, cleanup } = await makeApp();
  try {
    // Off by default — nothing is required to talk.
    assert.equal(app.tts.status().provider, 'browser');
    assert.match(app.tts.missing()!, /off/);

    app.secrets.set('voice:tts:fishKey', 'fish-key-abcdef');
    app.settings.update({ voice: { tts: { provider: 'fish', voiceId: 'voice-xyz' } } });
    assert.equal(app.tts.missing(), null);
    assert.equal(app.tts.status().available, true);

    const out = await app.tts.synthesize('Hello, I am Jarvis.');
    assert.equal(out.mime, 'audio/mpeg');
    assert.ok(out.audio.equals(mp3), 'the audio bytes are returned to play');
    assert.equal(fish.calls[0].body.text, 'Hello, I am Jarvis.');
    assert.equal(fish.calls[0].body.reference_id, 'voice-xyz');
    assert.equal(fish.calls[0].body.format, 'mp3');

    // A rejected key surfaces plainly.
    app.secrets.set('voice:tts:fishKey', 'wrong');
    await assert.rejects(() => app.tts.synthesize('x'), /rejected the API key/);
  } finally {
    await cleanup();
    await fish.close();
    delete process.env.JARVIS_FISH_API;
  }
});
