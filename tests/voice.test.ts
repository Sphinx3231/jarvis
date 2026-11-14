import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJarvis } from '../server/main.ts';
import { AuthStorage } from '@kenkaiiii/gg-core';
import { clearRoamiesAuth, tempDir } from './helpers.ts';

test('voice: recordings are transcribed with the OpenAI key saved in Roamies, or your own server', async () => {
  const received: Array<{ auth: string | undefined; contentType: string; body: Buffer }> = [];
  const whisper = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({ auth: req.headers.authorization, contentType: String(req.headers['content-type']), body: Buffer.concat(chunks) });
    if (req.url !== '/v1/audio/transcriptions') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: ' Remind me in five minutes to stretch. ' }));
  });
  await new Promise<void>((r) => whisper.listen(0, '127.0.0.1', () => r()));
  const dir = tempDir();
  mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<meta name="jarvis-token" content="" />');
  const s = await startJarvis({ dataDir: join(dir, 'data'), port: 0, quiet: true, webDir: join(dir, 'web') });
  const post = (body: Buffer, type = 'audio/webm') =>
    fetch(`${s.url}/api/voice/transcribe`, { method: 'POST', headers: { 'x-jarvis-token': s.token, 'content-type': type }, body: new Uint8Array(body) });
  try {
    const audio = Buffer.alloc(4000, 7);
    let res = await post(audio);
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /No transcription service is configured/);

    const whisperUrl = `http://127.0.0.1:${(whisper.address() as { port: number }).port}/v1`;
    // The OpenAI API key the user saved in Roamies.
    await new AuthStorage(join(process.env.JARVIS_GG_DIR!, 'auth.json')).setCredentials('openai', { accessToken: 'sk-test-transcribe-123456', refreshToken: '', expiresAt: Date.now() + 86_400_000, baseUrl: whisperUrl });
    s.app.settings.update({ voice: { lang: 'en-GB' } });
    res = await post(audio);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'Remind me in five minutes to stretch.', provider: 'OpenAI (your key in Roamies)' });
    const sent = received.at(-1)!;
    assert.equal(sent.auth, 'Bearer sk-test-transcribe-123456');
    assert.match(sent.contentType, /^multipart\/form-data/);
    const form = sent.body.toString('latin1');
    assert.match(form, /name="model"\r\n\r\nwhisper-1/);
    assert.match(form, /name="language"\r\n\r\nen\r\n/);
    assert.match(form, /filename="speech\.webm"/);
    assert.ok(sent.body.includes(audio), 'audio bytes forwarded unchanged');

    // Or a Whisper-compatible server of the user's own, with an optional key kept encrypted by Jarvis.
    clearRoamiesAuth();
    s.app.settings.update({ voice: { transcription: { service: 'custom', baseUrl: whisperUrl } } });
    s.app.secrets.set('voice:transcription:apiKey', 'local-key-1');
    res = await post(audio);
    assert.equal(res.status, 200);
    assert.equal(received.at(-1)!.auth, 'Bearer local-key-1');

    assert.equal((await post(Buffer.alloc(10))).status, 400, 'tiny bodies rejected');
    const json = await fetch(`${s.url}/api/voice/transcribe`, { method: 'POST', headers: { 'x-jarvis-token': s.token, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(json.status, 400);
  } finally {
    await s.stop();
    whisper.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
