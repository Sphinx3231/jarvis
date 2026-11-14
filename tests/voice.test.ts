import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJarvis } from '../server/main.ts';
import { tempDir } from './helpers.ts';

test('voice: recordings are transcribed through the configured OpenAI-compatible service', async () => {
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

    const providers = s.app.settings.get().llm.providers.map((p) => (p.id === 'openai' ? { ...p, baseUrl: `http://127.0.0.1:${(whisper.address() as { port: number }).port}/v1` } : p));
    s.app.settings.update({ llm: { providers }, voice: { lang: 'en-GB' } });
    s.app.secrets.set('llm:openai:apiKey', 'sk-test-transcribe-123456');
    res = await post(audio);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'Remind me in five minutes to stretch.', provider: 'OpenAI' });
    const sent = received.at(-1)!;
    assert.equal(sent.auth, 'Bearer sk-test-transcribe-123456');
    assert.match(sent.contentType, /^multipart\/form-data/);
    const form = sent.body.toString('latin1');
    assert.match(form, /name="model"\r\n\r\nwhisper-1/);
    assert.match(form, /name="language"\r\n\r\nen\r\n/);
    assert.match(form, /filename="speech\.webm"/);
    assert.ok(sent.body.includes(audio), 'audio bytes forwarded unchanged');

    assert.equal((await post(Buffer.alloc(10))).status, 400, 'tiny bodies rejected');
    const json = await fetch(`${s.url}/api/voice/transcribe`, { method: 'POST', headers: { 'x-jarvis-token': s.token, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(json.status, 400);
  } finally {
    await s.stop();
    whisper.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
