import { UserError } from '../core/util.ts';
import type { InputAction } from './input.ts';
import { ConfirmationRequired } from './manager.ts';
import type { BrowserOp, BrowserOpResult, ComputerAccessManager } from './manager.ts';

/**
 * Multi-step computer workflows: UNDERSTAND → PLAN → CHECK PERMISSIONS → OBSERVE → ACT → VERIFY →
 * CONTINUE OR RECOVER.
 *
 * Jarvis (the existing planner/agents — not a second reasoning engine) decides the steps; this executor
 * runs them the careful way a person would: every step's result is verified, a step that cannot be
 * verified stops the workflow instead of being assumed, and recovery is limited to what is SAFE:
 *
 *  - Steps that change nothing yet (an element not found because the page is still loading, a read, a
 *    navigation, a scroll) are retried with backoff.
 *  - Steps that may already have had an effect (a click, typing, a key press) are NEVER retried
 *    automatically — a second "Submit" could create a duplicate. The workflow stops and reports.
 *  - Blockers a human must handle (a sign-in page, a dialog covering the target, a critical action
 *    awaiting confirmation) stop the workflow with a precise reason and the step to resume from.
 *
 * STOP / turning Computer Access off aborts the workflow between and during steps.
 */

export type WorkflowStep =
  | { do: 'browser'; action: BrowserOp; note?: string }
  | { do: 'click_text'; text: string; expectText?: string; note?: string }
  | { do: 'input'; action: InputAction; note?: string }
  | { do: 'open_app'; name: string; note?: string }
  | { do: 'open_file'; path: string; note?: string }
  | { do: 'wait'; ms: number; note?: string }
  | { do: 'observe'; note?: string };

export interface StepReport {
  index: number;
  step: string;
  status: 'ok' | 'failed' | 'unverified' | 'blocked' | 'needs_confirmation' | 'cancelled' | 'skipped';
  detail: string;
  attempts: number;
  durationMs: number;
}

export interface WorkflowResult {
  goal: string;
  status: 'completed' | 'failed' | 'blocked' | 'needs_confirmation' | 'cancelled';
  steps: StepReport[];
  /** Index to pass as `startAt` to continue after the user handles a blocker/confirmation. */
  resumeFrom: number | null;
  confirmationId: string | null;
  /** What Jarvis saw at the end (page title/url or active window) — for the final report. */
  finalState: string | null;
  summary: string;
}

const SAFE_TO_RETRY_BROWSER = new Set(['tabs', 'read', 'navigate', 'back', 'scroll', 'wait_text', 'activate']);

function describeStep(s: WorkflowStep): string {
  switch (s.do) {
    case 'browser': {
      const a = s.action;
      if (a.op === 'click') return `click "${a.target.name ?? `#${a.target.index}`}" in the browser`;
      if (a.op === 'type') return `type ${JSON.stringify(a.text.slice(0, 30))}${a.target?.name ? ` into "${a.target.name}"` : ''}`;
      if (a.op === 'navigate' || a.op === 'open') return `${a.op} ${a.url}`;
      if (a.op === 'scroll') return `scroll ${a.direction}`;
      if (a.op === 'key') return `press ${a.key}`;
      if (a.op === 'wait_text') return `wait for "${a.text}"`;
      return `browser ${a.op}`;
    }
    case 'click_text':
      return `click "${s.text}" on screen`;
    case 'input':
      return `input ${s.action.kind}`;
    case 'open_app':
      return `open ${s.name}`;
    case 'open_file':
      return `open ${s.path}`;
    case 'wait':
      return `wait ${s.ms}ms`;
    case 'observe':
      return 'look at the screen';
  }
}

function retryable(s: WorkflowStep): boolean {
  if (s.do === 'browser') return SAFE_TO_RETRY_BROWSER.has(s.action.op);
  return s.do === 'observe' || s.do === 'wait';
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('Cancelled'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('Cancelled'));
      },
      { once: true },
    );
  });

function withStepTimeout<T>(ms: number, signal: AbortSignal, fn: (s: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(new Error(`Step timed out after ${Math.round(ms / 1000)}s`)), ms);
  return fn(ctl.signal).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  });
}

export class WorkflowExecutor {
  private computer: ComputerAccessManager;
  constructor(computer: ComputerAccessManager) {
    this.computer = computer;
  }

  async run(goal: string, steps: WorkflowStep[], opts: { startAt?: number; preapproved?: boolean; stepTimeoutMs?: number; maxRetries?: number } = {}, signal?: AbortSignal): Promise<WorkflowResult> {
    if (!steps.length) throw new UserError('A workflow needs at least one step.');
    if (steps.length > 60) throw new UserError('A workflow can have at most 60 steps.');
    const needsExtended = steps.some((s) => s.do === 'open_app' || s.do === 'open_file');
    const needsInteract = steps.some((s) => !(s.do === 'observe' || s.do === 'wait' || (s.do === 'browser' && ['tabs', 'read', 'wait_text'].includes(s.action.op))));
    const gate = this.computer.permits(needsExtended ? 'extended' : needsInteract ? 'interact' : 'observe');
    if (!gate.ok) throw new UserError(gate.reason);

    const sig = signal ? AbortSignal.any([signal, this.computer.signal]) : this.computer.signal;
    const reports: StepReport[] = [];
    const startAt = Math.max(0, Math.min(steps.length - 1, opts.startAt ?? 0));
    const maxRetries = opts.maxRetries ?? 2;
    const live = this.computer.actions;
    live.setState('PLANNING', { task: goal, detail: `${steps.length} step(s): ${steps.map(describeStep).slice(0, 6).join(' → ')}${steps.length > 6 ? ' → …' : ''}` });
    for (let i = 0; i < startAt; i++) reports.push({ index: i, step: describeStep(steps[i]), status: 'skipped', detail: 'done in an earlier run', attempts: 0, durationMs: 0 });

    const finish = async (status: WorkflowResult['status'], resumeFrom: number | null, confirmationId: string | null, summary: string): Promise<WorkflowResult> => {
      const finalState = await this.finalState(sig).catch(() => null);
      live.setState(status === 'completed' ? 'COMPLETED' : status === 'cancelled' ? 'IDLE' : status === 'needs_confirmation' ? 'WAITING_FOR_APPROVAL' : 'ERROR', { task: goal, detail: summary });
      return { goal, status, steps: reports, resumeFrom, confirmationId, finalState, summary };
    };

    for (let i = startAt; i < steps.length; i++) {
      const step = steps[i];
      const label = describeStep(step);
      const started = Date.now();
      let attempts = 0;
      let lastErr = '';
      for (;;) {
        attempts++;
        if (sig.aborted) {
          reports.push({ index: i, step: label, status: 'cancelled', detail: 'Stopped by you (STOP or Computer Access turned off).', attempts, durationMs: Date.now() - started });
          return finish('cancelled', i, null, `Stopped before step ${i + 1} (${label}).`);
        }
        try {
          const outcome = await withStepTimeout(opts.stepTimeoutMs ?? 45_000, sig, (s) => this.exec(step, s, { preapproved: opts.preapproved, task: goal }));
          if (outcome.status === 'ok') {
            reports.push({ index: i, step: label, status: 'ok', detail: outcome.detail, attempts, durationMs: Date.now() - started });
            break;
          }
          if (outcome.status === 'blocked') {
            reports.push({ index: i, step: label, status: 'blocked', detail: outcome.detail, attempts, durationMs: Date.now() - started });
            return finish('blocked', i, null, `Blocked at step ${i + 1} (${label}): ${outcome.detail}`);
          }
          // not found / not yet / unverified
          if (outcome.status === 'retry' && attempts <= maxRetries) {
            lastErr = outcome.detail;
            live.setState('VERIFYING', { detail: `retrying "${label}" (${outcome.detail})` });
            await sleep(600 * attempts, sig);
            continue;
          }
          const st = outcome.status === 'unverified' ? 'unverified' : 'failed';
          reports.push({ index: i, step: label, status: st, detail: outcome.detail, attempts, durationMs: Date.now() - started });
          return finish('failed', i, null, `Step ${i + 1} (${label}) ${st === 'unverified' ? 'could not be verified' : 'failed'}: ${outcome.detail}${retryable(step) ? '' : ' — not retried automatically because it may already have taken effect.'}`);
        } catch (err) {
          if (err instanceof ConfirmationRequired) {
            reports.push({ index: i, step: label, status: 'needs_confirmation', detail: err.message, attempts, durationMs: Date.now() - started });
            return finish('needs_confirmation', i, err.confirmation.id, `Waiting for your confirmation before step ${i + 1}: ${err.confirmation.summary} (${err.confirmation.finding.reason}).`);
          }
          if (sig.aborted) {
            reports.push({ index: i, step: label, status: 'cancelled', detail: 'Stopped by you.', attempts, durationMs: Date.now() - started });
            return finish('cancelled', i, null, `Stopped during step ${i + 1} (${label}).`);
          }
          lastErr = (err as Error).message;
          if (retryable(step) && attempts <= maxRetries) {
            await sleep(800 * attempts, sig).catch(() => {});
            continue;
          }
          reports.push({ index: i, step: label, status: 'failed', detail: lastErr, attempts, durationMs: Date.now() - started });
          return finish('failed', i, null, `Step ${i + 1} (${label}) failed: ${lastErr}`);
        }
      }
    }
    return finish('completed', null, null, `Completed all ${steps.length} step(s) of "${goal}", each verified.`);
  }

  /** Execute one step and classify the result for the loop. */
  private async exec(step: WorkflowStep, signal: AbortSignal, opts: { preapproved?: boolean; task: string }): Promise<{ status: 'ok' | 'retry' | 'unverified' | 'failed' | 'blocked'; detail: string }> {
    const c = this.computer;
    switch (step.do) {
      case 'wait':
        await sleep(Math.min(60_000, Math.max(0, step.ms)), signal);
        return { status: 'ok', detail: `waited ${step.ms}ms` };
      case 'observe': {
        const o = await c.observe({ ocr: true, activeWindow: true }, signal);
        return { status: o.ocr || o.activeWindow?.available ? 'ok' : 'retry', detail: `active window: ${o.activeWindow?.title ?? '(unknown)'}; ${o.ocr ? `${o.ocr.text.length} chars on screen` : o.notes.join('; ')}` };
      }
      case 'open_app': {
        const r = await c.openApp(step.name, opts, signal);
        return { status: r.ok ? 'ok' : 'failed', detail: r.detail };
      }
      case 'open_file': {
        const r = await c.openFile(step.path, opts, signal);
        return { status: r.ok ? 'ok' : 'failed', detail: r.detail };
      }
      case 'input': {
        const r = await c.control(step.action, signal, opts);
        if (!r.ok) return { status: 'failed', detail: r.detail };
        if (r.verified && !r.verified.ok) return { status: 'unverified', detail: `${r.detail} — ${r.verified.detail}` };
        return { status: 'ok', detail: r.verified ? `${r.detail} — ${r.verified.detail}` : r.detail };
      }
      case 'click_text': {
        try {
          const r = await c.clickText(step.text, { ...opts, expectText: step.expectText }, signal);
          return { status: r.verified.ok ? 'ok' : 'unverified', detail: `clicked "${r.clicked.text}" at ${r.clicked.x},${r.clicked.y} — ${r.verified.detail}` };
        } catch (err) {
          if (err instanceof ConfirmationRequired) throw err;
          // Not visible yet: nothing was clicked, so waiting and looking again is safe.
          if (/not visible/.test((err as Error).message)) return { status: 'retry', detail: (err as Error).message };
          throw err;
        }
      }
      case 'browser':
        return this.execBrowser(step.action, signal, opts);
    }
  }

  private async execBrowser(action: BrowserOp, signal: AbortSignal, opts: { preapproved?: boolean; task: string }): Promise<{ status: 'ok' | 'retry' | 'unverified' | 'failed' | 'blocked'; detail: string }> {
    const c = this.computer;
    const res: BrowserOpResult = await c.browserOp(action, signal, opts);
    if (res.op === 'tabs' && 'tabs' in res) return { status: 'ok', detail: `${res.tabs.length} tab(s): ${res.tabs.map((t) => t.title || t.url).slice(0, 8).join(' | ')}` };
    if (res.op === 'open' && 'tab' in res) return { status: 'ok', detail: `opened ${res.tab.url}` };
    if (res.op === 'read' && 'page' in res) {
      const p = res.page;
      if (p.loginRequired) return { status: 'blocked', detail: `"${p.title}" needs you to sign in (${p.loginReason}). Jarvis never enters passwords — sign in, then resume.` };
      return { status: 'ok', detail: `read "${p.title}" — ${p.textLength} chars, ${p.elements.length} controls${p.dialogs.length ? `, dialog: ${p.dialogs[0].slice(0, 80)}` : ''}` };
    }
    if (res.op === 'wait_text' && 'found' in res) return res.found ? { status: 'ok', detail: `"${(action as { text: string }).text}" is on the page` } : { status: 'retry', detail: `"${(action as { text: string }).text}" has not appeared yet` };
    if (!('result' in res)) return { status: 'failed', detail: 'unexpected browser result' };
    const r = res.result;
    if (r.loginRequired && action.op !== 'navigate') return { status: 'blocked', detail: `The page now asks you to sign in (session expired?). Sign in yourself, then resume.` };
    if (!r.ok) {
      // A click/type that found nothing did not act: safe to look again (page may still be loading).
      if (/No element matching|No field matching/.test(r.detail)) return { status: 'retry', detail: r.detail };
      if (/covered by another element/.test(r.detail)) return { status: 'blocked', detail: r.detail };
      if (action.op === 'navigate') return { status: 'retry', detail: r.detail };
      return { status: 'failed', detail: r.detail };
    }
    if (r.loginRequired && action.op === 'navigate') return { status: 'blocked', detail: `${r.detail} — it is a sign-in page. Sign in yourself, then resume.` };
    if (r.verified && !r.verified.ok) return { status: action.op === 'scroll' ? 'ok' : 'unverified', detail: `${r.detail} — ${r.verified.detail}` };
    return { status: 'ok', detail: r.verified ? `${r.detail} — ${r.verified.detail}` : r.detail };
  }

  private async finalState(signal: AbortSignal): Promise<string | null> {
    const b = await this.computer.browser().probe(signal);
    if (b.ok) {
      const t = await this.computer.browser().activeTab(signal);
      if (t) return `Browser tab: ${t.title || '(untitled)'} — ${t.url}`;
    }
    if (!this.computer.enabled()) return null;
    const o = await this.computer.observe({ activeWindow: true }, signal).catch(() => null);
    return o?.activeWindow?.available ? `Active window: ${o.activeWindow.title}` : null;
  }
}
