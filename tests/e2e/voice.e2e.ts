/**
 * Voice end-to-end test: Chromium's fake microphone plays a generated recording; Jarvis records
 * it, stops automatically when the "speaker" pauses, uploads it for transcription (to a mock
 * OpenAI-compatible service) and acts on the transcript.
 *
 *   npm run build && npm run test:e2e
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startJarvis } from '../../server/main.ts';
import { tempDir } from '../helpers.ts';

const require = createRequire(import.meta.url);
const playwright = require('playwright') as typeof import('playwright');

/** 16 kHz mono WAV: one second of a 220 Hz tone (speech stand-in) followed by three seconds of silence. */
function wav(path: string): void {
  const rate = 16_000;
  const samples = rate * 4;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const v = i < rate ? Math.sin((2 * Math.PI * 220 * i) / rate) * 0.4 : 0;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

const dir = tempDir('jarvis-voice-');
const audioFile = join(dir, 'speech.wav');
wav(audioFile);

const uploads: Array<{ bytes: number; type: string }> = [];
const whisper = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  uploads.push({ bytes: body.length, type: String(req.headers['content-type']) });
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'Remember that my favourite colour is purple.' }));
});
await new Promise<void>((r) => whisper.listen(0, '127.0.0.1', () => r()));

const running = await startJarvis({ dataDir: join(dir, 'data'), port: 0, quiet: true });
// The user's own Whisper-compatible server.
running.app.settings.update({
  voice: { inputMode: 'transcription', transcription: { service: 'custom', baseUrl: `http://127.0.0.1:${(whisper.address() as { port: number }).port}/v1` } },
  embeddings: { enabled: false },
});
running.app.secrets.set('voice:transcription:apiKey', 'sk-voice-test-000000');

const browser = await playwright.chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${audioFile}`, '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(running.url);
  await page.getByText('Online').waitFor();
  const mic = page.getByRole('button', { name: 'Talk to Jarvis' });
  await mic.click();
  await page.locator('.core--listening').waitFor({ timeout: 5000 });
  console.log('  ✓ microphone recording; core is listening');
  await page.getByText(/I'll remember that/).waitFor({ timeout: 20_000 });
  console.log('  ✓ recording stopped on the pause, was transcribed, and Jarvis acted on it');
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].bytes > 2000, `audio uploaded (${uploads[0].bytes} bytes)`);
  assert.match(uploads[0].type, /multipart\/form-data/);
  assert.ok(running.app.memory.list({ kind: 'preference' }).some((m) => m.content.includes('favourite colour is purple') && m.verified));
  assert.match(await page.locator('.msg--user').last().innerText(), /favourite colour is purple/);
  assert.match(await page.locator('.msg--user .msg__bubble').last().evaluate((el) => el.parentElement!.innerText), /voice/);
  console.log('  ✓ the spoken request is stored as a voice message and its memory saved');
  assert.deepEqual(errors, []);
  console.log('\nVoice E2E passed.');
} finally {
  await browser.close();
  await running.stop();
  whisper.close();
  rmSync(dir, { recursive: true, force: true });
}
