import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SettingsStore } from '../core/settings.ts';

/**
 * On-demand local voice: Whisper (listening) and Kokoro (speaking) each run in a short-lived worker
 * process that starts on the first request and exits after a few idle minutes.
 *
 * Why: a speech model loaded inside a long-running server never gives its memory back (Kokoro with
 * PyTorch is ~1 GB). Between conversations that RAM should belong to the local LLM. Exiting the
 * process is the only reliable way to return it to the OS, so the workers do exactly that.
 *
 * The cost is a cold start (a few seconds) for the first sentence after a quiet spell; while the wake
 * word is on, the listening worker is kept warm by use. Without a usable Python the caller falls back
 * to OpenJarvis's own (always-loaded) speech endpoints.
 */

type Mode = 'stt' | 'tts';

interface Worker {
  proc: ChildProcess;
  port: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** The Python that has the speech packages: setting, env, then the local setup's venv locations. */
export function findVoicePython(configured: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    configured,
    env.JARVIS_VOICE_PYTHON ?? '',
    process.platform === 'win32' ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Jarvis', 'openjarvis', 'Scripts', 'python.exe') : '',
    join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'jarvis', 'openjarvis', 'bin', 'python'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function workerScript(): string {
  // Next to this file in the source tree; the desktop build copies it alongside the compiled server.
  return join(HERE, 'voice_worker.py');
}

export class VoiceWorkers {
  private settings: SettingsStore;
  private workers = new Map<Mode, Worker>();
  private starting = new Map<Mode, Promise<Worker>>();
  /** Cold starts and requests served, for the status panel and tests. */
  readonly stats = { starts: { stt: 0, tts: 0 }, requests: { stt: 0, tts: 0 } };

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  python(): string | null {
    return findVoicePython(this.settings.get().voice.local.python);
  }

  /** Local voice through workers is possible (enabled + a Python with the packages + the script). */
  available(): boolean {
    return this.settings.get().voice.local.onDemand && this.python() !== null && existsSync(workerScript());
  }

  running(): { stt: boolean; tts: boolean } {
    return { stt: this.workers.has('stt'), tts: this.workers.has('tts') };
  }

  private start(mode: Mode): Promise<Worker> {
    const live = this.workers.get(mode);
    if (live) return Promise.resolve(live);
    const pending = this.starting.get(mode);
    if (pending) return pending;
    const python = this.python();
    if (!python) return Promise.reject(new Error('No Python with the local speech packages was found (run the Jarvis local setup).'));
    const v = this.settings.get().voice;
    const p = new Promise<Worker>((resolve, reject) => {
      const proc = spawn(python, [workerScript(), mode], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          JARVIS_VOICE_IDLE_SEC: String(v.local.idleSec),
          JARVIS_WHISPER_MODEL: v.local.whisperModel,
          JARVIS_VOICE: v.tts.voiceId || 'bm_george',
          PYTHONUNBUFFERED: '1',
        },
      });
      let buf = '';
      let errBuf = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`The ${mode === 'stt' ? 'listening' : 'voice'} worker did not start in time.`));
      }, 30_000);
      proc.stderr?.on('data', (d) => (errBuf = (errBuf + String(d)).slice(-2000)));
      proc.stdout?.on('data', (d) => {
        buf += String(d);
        const line = buf.split('\n')[0];
        if (!buf.includes('\n')) return;
        clearTimeout(timer);
        try {
          const { port } = JSON.parse(line) as { port: number };
          const w = { proc, port };
          this.workers.set(mode, w);
          this.stats.starts[mode]++;
          resolve(w);
        } catch {
          proc.kill();
          reject(new Error(`The ${mode} worker said something unexpected: ${line.slice(0, 200)}`));
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (this.workers.get(mode)?.proc === proc) this.workers.delete(mode);
        if (!this.workers.has(mode)) reject(new Error(`The ${mode} worker exited (code ${code}): ${errBuf.trim().split('\n').slice(-3).join(' ')}`));
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    }).finally(() => this.starting.delete(mode));
    this.starting.set(mode, p);
    return p;
  }

  private async call(mode: Mode, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const w = await this.start(mode);
      try {
        const res = await fetch(`http://127.0.0.1:${w.port}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
        this.stats.requests[mode]++;
        return res;
      } catch (err) {
        // It may have just exited for being idle: start a fresh one once.
        if (this.workers.get(mode) === w) this.workers.delete(mode);
        if (attempt === 1 || init.signal?.aborted) throw err;
      }
    }
    throw new Error('unreachable');
  }

  async transcribe(audio: Buffer, mimeType: string, opts: { language?: string; signal?: AbortSignal } = {}): Promise<{ text: string; language: string | null }> {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : 'webm';
    const q = new URLSearchParams({ ext, ...(opts.language ? { language: opts.language.split('-')[0] } : {}) });
    const res = await this.call('stt', `/transcribe?${q}`, { method: 'POST', body: new Uint8Array(audio), signal: opts.signal }, 300_000);
    const body = (await res.json()) as { text?: string; language?: string; error?: string };
    if (!res.ok) throw new Error(`Local listening failed: ${body.error ?? res.status}`);
    return { text: (body.text ?? '').trim(), language: body.language ?? null };
  }

  async synthesize(text: string, opts: { voiceId?: string; speed?: number; signal?: AbortSignal } = {}): Promise<{ audio: Buffer; mime: string; voiceId: string | null }> {
    const res = await this.call('tts', '/synthesize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice_id: opts.voiceId, speed: opts.speed }), signal: opts.signal }, 300_000);
    if (!res.ok) throw new Error(`Local voice failed: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`);
    return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/wav', voiceId: res.headers.get('x-voice-id') };
  }

  /** Start a worker in the background (e.g. load the voice while the model is still thinking). */
  prewarm(mode: Mode): void {
    if (this.available()) void this.start(mode).catch(() => {});
  }

  stopAll(): void {
    for (const w of this.workers.values()) w.proc.kill();
    this.workers.clear();
  }
}
