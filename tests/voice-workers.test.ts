import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { makeApp } from './helpers.ts';
import { findVoicePython } from '../server/voice/workers.ts';

/**
 * On-demand local voice (REAL when a Python with faster-whisper + Kokoro exists — the local setup's venv,
 * or JARVIS_VOICE_PYTHON): Kokoro speaks, Whisper transcribes it back, and each worker process EXITS
 * after its idle timeout — the memory goes back to the model. Skips cleanly elsewhere.
 */

const PY = findVoicePython('');
const SKIP = PY && existsSync(PY) ? false : 'no Python with the local speech packages (run the local setup or set JARVIS_VOICE_PYTHON)';

test('voice workers: speak, listen, then exit when idle so their RAM returns to the model', { skip: SKIP, timeout: 300_000 }, async () => {
  const { app, cleanup } = await makeApp({ start: false });
  try {
    app.settings.update({ brain: { backend: 'openjarvis', openjarvisUrl: 'http://127.0.0.1:9' }, voice: { transcription: { service: 'openjarvis' }, tts: { provider: 'local', voiceId: 'bm_george' }, local: { onDemand: true, idleSec: 15, whisperModel: 'base' } } });
    await app.start();
    assert.equal(app.voice.available(), true);
    assert.deepEqual(app.voice.running(), { stt: false, tts: false }, 'nothing loaded until needed');
    const wav = await app.voice.synthesize('Jarvis is speaking from an on demand worker.');
    assert.ok(wav.audio.length > 10_000 && wav.mime === 'audio/wav');
    const heard = await app.llm.transcribe(wav.audio, 'audio/wav', { language: 'en' });
    assert.match(heard.text.toLowerCase(), /speaking.*on.?demand worker/);
    assert.match(heard.provider, /on demand/);
    assert.deepEqual(app.voice.running(), { stt: true, tts: true });
    // Idle: both workers exit by themselves.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && (app.voice.running().stt || app.voice.running().tts)) await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(app.voice.running(), { stt: false, tts: false }, 'workers exited and freed their memory');
    // And they come back on demand.
    const again = await app.voice.synthesize('Back again.');
    assert.ok(again.audio.length > 5_000);
    assert.equal(app.voice.stats.starts.tts, 2);
  } finally {
    await cleanup();
  }
});
