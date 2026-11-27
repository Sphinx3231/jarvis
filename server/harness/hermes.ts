import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ActivityLog } from '../core/activity.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage, newId } from '../core/util.ts';
import type { RoamiesEngine } from '../llm/engine.ts';
import type { ToolSpec } from '../llm/types.ts';
import type { HarnessModelEndpoint } from './model-endpoint.ts';

/**
 * Hermes Agent as Jarvis's agent harness.
 *
 * For an open-ended task, Hermes runs the loop (think → call a tool → read the result → repeat).
 * Jarvis owns everything around it: the task and its lifecycle, which tools exist (only Jarvis
 * skills, filtered by the agent identity), every tool execution (skill runner → permission engine →
 * approvals → verification → audit), the model (Jarvis's engine via a loopback endpoint) and the
 * stored state. See hermes_bridge.py for the Python side.
 *
 * Hermes is optional. When it isn't installed, the model can't call tools or its served context is
 * under Hermes's 64K minimum, tasks run on Jarvis's native planner exactly as before.
 */

/** Hermes refuses models served with less context than this. */
export const HERMES_MIN_CONTEXT = 64_000;

const BRIDGE = fileURLToPath(new URL('./hermes_bridge.py', import.meta.url));

export interface HarnessStatus {
  /** Hermes would be used for an eligible task right now. */
  available: boolean;
  mode: 'auto' | 'off';
  installed: boolean;
  /** Why Hermes isn't used (null when it is). */
  reason: string | null;
  python: string | null;
  release: string | null;
  commit: string | null;
  model: string | null;
  contextWindow: number | null;
  contextSource: 'provider' | 'setting' | null;
}

export interface HarnessToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface HarnessRunResult {
  final: string;
  completed: boolean;
  interrupted: boolean;
  failed: boolean;
  exit: string;
  apiCalls: number;
  modelCalls: number;
  messages: unknown[];
  release: string | null;
  /** Jarvis's own words for the last model failure, when the run ended because of one. */
  modelError: string | null;
}

export interface HarnessRunRequest {
  system: string;
  prompt: string;
  history: unknown[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onToolCall: (call: HarnessToolCall) => Promise<{ content: string; isError?: boolean }>;
  onProgress?: (ev: { kind: string; tool?: string | null; step?: number }) => void;
}

export class HarnessError extends Error {}

interface Probe {
  at: number;
  python: string;
  ok: boolean;
  release: string | null;
  error: string | null;
}

export class HermesHarness {
  private settings: SettingsStore;
  private engine: RoamiesEngine;
  private endpoint: HarnessModelEndpoint;
  private activity: ActivityLog;
  private dataDir: string;
  private serverUrl: string | null = null;
  private urlReady: Promise<void>;
  private markUrlReady!: () => void;
  private probeCache: Probe | null = null;
  private live = new Set<ChildProcess>();

  constructor(deps: { settings: SettingsStore; engine: RoamiesEngine; endpoint: HarnessModelEndpoint; activity: ActivityLog; dataDir: string }) {
    this.settings = deps.settings;
    this.engine = deps.engine;
    this.endpoint = deps.endpoint;
    this.activity = deps.activity;
    this.dataDir = deps.dataDir;
    this.urlReady = new Promise((r) => (this.markUrlReady = r));
  }

  /** Where Jarvis's API listens; Hermes reaches the model through it. Set once the server is up. */
  setServerUrl(url: string): void {
    this.serverUrl = url.replace(/\/+$/, '');
    this.markUrlReady();
  }

  /** The Hermes install's Python: the setting, JARVIS_HERMES_PYTHON, or Jarvis's own install location. */
  pythonPath(): string | null {
    const configured = this.settings.get().harness.python.trim() || process.env.JARVIS_HERMES_PYTHON?.trim();
    if (configured) return configured;
    for (const root of [join(this.dataDir, 'hermes', 'runtime'), join(homedir(), '.jarvis', 'hermes', 'runtime')]) {
      for (const p of [join(root, '.venv', 'bin', 'python'), join(root, '.venv', 'Scripts', 'python.exe')]) if (existsSync(p)) return p;
    }
    return null;
  }

  /** The commit Jarvis's installer pinned, when Hermes was installed by it. */
  private commit(): string | null {
    const py = this.pythonPath();
    if (!py) return null;
    const stamp = join(py, '..', '..', '..', 'jarvis-hermes.json');
    try {
      return (JSON.parse(readFileSync(stamp, 'utf8')) as { commit?: string }).commit ?? null;
    } catch {
      return null;
    }
  }

  /** Can this Python import Hermes? Cached for a minute. */
  async probe(force = false): Promise<Probe | null> {
    const python = this.pythonPath();
    if (!python) return null;
    if (!force && this.probeCache && this.probeCache.python === python && Date.now() - this.probeCache.at < 60_000) return this.probeCache;
    const home = join(this.dataDir, 'hermes', 'home');
    mkdirSync(home, { recursive: true });
    const result = await new Promise<Probe>((resolve) => {
      let out = '';
      let err = '';
      const child = spawn(python, ['-c', 'import hermes_cli, run_agent; print(getattr(hermes_cli, "__release_date__", "unknown"))'], { env: this.childEnv(home), stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => resolve({ at: Date.now(), python, ok: false, release: null, error: e.message }));
      child.on('close', (code) => resolve({ at: Date.now(), python, ok: code === 0, release: code === 0 ? out.trim() || null : null, error: code === 0 ? null : err.trim().split('\n').slice(-1)[0] || `exit ${code}` }));
    });
    this.probeCache = result;
    return result;
  }

  async status(): Promise<HarnessStatus> {
    // Tasks can start a moment before the API server listens; give it a few seconds.
    if (!this.serverUrl) await Promise.race([this.urlReady, new Promise((r) => setTimeout(r, 10_000).unref?.())]);
    const s = this.settings.get().harness;
    const python = this.pythonPath();
    const probe = await this.probe();
    const ctx = await this.engine.contextWindow();
    const fromSetting = s.contextLength > 0 ? s.contextLength : null;
    const contextWindow = ctx.tokens ?? fromSetting;
    const base: HarnessStatus = {
      available: false,
      mode: s.mode,
      installed: Boolean(probe?.ok),
      reason: null,
      python,
      release: probe?.release ?? null,
      commit: this.commit(),
      model: ctx.model,
      contextWindow,
      contextSource: ctx.tokens ? 'provider' : fromSetting ? 'setting' : null,
    };
    const reason = (() => {
      if (s.mode === 'off') return 'Turned off in Settings → Agent harness.';
      if (!python) return 'Hermes Agent is not installed (see docs/HERMES.md).';
      if (!probe?.ok) return `Hermes Agent at ${python} could not be loaded: ${probe?.error ?? 'unknown error'}`;
      if (!this.serverUrl) return 'Jarvis is still starting.';
      if (!ctx.model) return 'No model is available.';
      if (ctx.route === 'claude-code') return 'The model is reached through the Claude Code bridge, which runs its own agent; Hermes needs a direct model.';
      if (!this.engine.supportsTools()) return `${ctx.model} can't call tools.`;
      if (!contextWindow) return `Jarvis can't tell how much context ${ctx.model} is served with. If your local server serves at least 64K tokens, enter it under Settings → Agent harness.`;
      if (contextWindow < HERMES_MIN_CONTEXT) return `${ctx.model} is served with ${Math.round(contextWindow / 1000)}K tokens of context; Hermes needs at least 64K.`;
      return null;
    })();
    return { ...base, reason, available: reason === null };
  }

  /** Only what Hermes needs: no API keys or other secrets from Jarvis's environment. */
  private childEnv(home: string): NodeJS.ProcessEnv {
    const keep = ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
    const env: NodeJS.ProcessEnv = {};
    for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
    // Loopback model traffic never goes through a proxy.
    env.NO_PROXY = [env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
    env.no_proxy = env.NO_PROXY;
    return {
      ...env,
      HOME: home,
      HERMES_HOME: home,
      HERMES_IGNORE_RULES: '1',
      HERMES_DISABLE_LAZY_INSTALLS: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      ...(this.commit() ? { JARVIS_HERMES_COMMIT: this.commit()! } : {}),
    };
  }

  /** Run Hermes once. Resolves with its result, or rejects with HarnessError. */
  async run(req: HarnessRunRequest): Promise<HarnessRunResult> {
    const status = await this.status();
    if (!status.available) throw new HarnessError(status.reason ?? 'Hermes is not available');
    const s = this.settings.get().harness;
    const runId = newId('hrun');
    const home = join(this.dataDir, 'hermes', 'home');
    const work = join(this.dataDir, 'hermes', 'work'); // empty, not a git repo: no project files reach the prompt
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    const grant = this.endpoint.grant(runId, controller.signal);
    const budgetSec = s.timeoutMin * 60;
    const child = spawn(status.python!, ['-u', BRIDGE], { env: this.childEnv(home), cwd: work, stdio: ['pipe', 'pipe', 'pipe'] });
    this.live.add(child);
    const send = (msg: unknown) => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify(msg) + '\n');
    };
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    const timer = setTimeout(() => {
      send({ op: 'cancel' });
      controller.abort();
    }, (budgetSec + 30) * 1000);
    timer.unref?.();
    const cancel = () => send({ op: 'cancel' });
    controller.signal.addEventListener('abort', cancel, { once: true });

    try {
      send({
        op: 'run',
        runId,
        model: { baseUrl: `${this.serverUrl}/harness/v1`, apiKey: grant.token, name: status.model, contextLength: status.contextWindow },
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
        system: req.system,
        prompt: req.prompt,
        history: req.history,
        maxIterations: s.maxIterations,
        budgetSec,
      });
      return await new Promise<HarnessRunResult>((resolve, reject) => {
        let release: string | null = null;
        let settled = false;
        const done = (fn: () => void) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };
        createInterface({ input: child.stdout }).on('line', (line) => {
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          if (ev.ev === 'hello') release = String((ev.hermes as { release?: string })?.release ?? '') || null;
          else if (ev.ev === 'tool_call') {
            const callId = String(ev.callId);
            req
              .onToolCall({ name: String(ev.name), args: (ev.args ?? {}) as Record<string, unknown> })
              .catch((err) => ({ content: errorMessage(err), isError: true }))
              .then((r) => send({ op: 'tool_result', callId, content: r.content, isError: Boolean(r.isError) }));
          } else if (ev.ev === 'progress') req.onProgress?.({ kind: String(ev.kind ?? ''), tool: (ev.tool as string | null) ?? null, step: typeof ev.step === 'number' ? ev.step : undefined });
          else if (ev.ev === 'error') done(() => reject(new HarnessError(grant.lastError ? `the model failed: ${grant.lastError}` : String(ev.message ?? 'Hermes failed'))));
          else if (ev.ev === 'result') {
            done(() =>
              resolve({
                final: String(ev.final ?? ''),
                completed: Boolean(ev.completed),
                interrupted: Boolean(ev.interrupted),
                failed: Boolean(ev.failed),
                exit: String(ev.exit ?? ''),
                apiCalls: Number(ev.apiCalls ?? 0),
                modelCalls: grant.calls,
                messages: Array.isArray(ev.messages) ? ev.messages : [],
                release,
                modelError: grant.lastError,
              }),
            );
          }
        });
        child.on('error', (err) => done(() => reject(new HarnessError(`Hermes could not start: ${err.message}`))));
        child.on('close', (code) => done(() => reject(new HarnessError(controller.signal.aborted ? 'Cancelled' : `Hermes stopped unexpectedly (exit ${code})${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`))));
      });
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
      this.endpoint.revoke(grant.token);
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 5000).unref?.();
      child.once('close', () => this.live.delete(child));
    }
  }

  /** Stop every running Hermes process (Jarvis shutting down). */
  stopAll(): void {
    for (const c of this.live) c.kill();
    this.live.clear();
  }

  logUnavailable(reason: string): void {
    this.activity.log('info', 'harness', `Hermes not used: ${reason}`);
  }
}
