import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, freemem, hostname, loadavg, networkInterfaces, tmpdir, totalmem, uptime } from 'node:os';
import type { ActivityLog } from '../core/activity.ts';
import type { Database } from '../db/database.ts';
import { ComputerActivity } from './activity.ts';
import type { ComputerState, LiveStatus, PendingConfirmation } from './activity.ts';
import { closeApplication, openApplication, openPath, processRunning } from './apps.ts';
import type { AppResult } from './apps.ts';
import { BrowserController, detectBrowserBinary, launchBrowser } from './browser.ts';
import type { BrowserActionResult, ElementTarget, PageRead, TabInfo } from './browser.ts';
import { actionFingerprint, classifyAction } from './guard.ts';
import type { ActionContext, CriticalFinding } from './guard.ts';
import { findTextOnScreen } from './screen-elements.ts';
import type { ScreenTextMatch } from './screen-elements.ts';
import type { EventBus } from '../core/events.ts';
import type { SettingsStore } from '../core/settings.ts';
import { sleep, UserError } from '../core/util.ts';
import { currentAdapter } from './adapters.ts';
import { captureScreen, detectCaptureTool } from './capture.ts';
import { actionCapability, currentInputDriver } from './input.ts';
import type { InputAction, InputDriver, InputResult } from './input.ts';
import { ocrAvailable, ocrImage, verifyOcr } from './ocr.ts';
import type { AccessLevel, Capability, DisplayInfo, Observation, OsAdapter, Telemetry } from './types.ts';
import { levelRank } from './types.ts';

export interface ObserveOptions {
  /** Capture the screen (implied by ocr). */
  screenshot?: boolean;
  /** OCR the screenshot into text (implies screenshot). */
  ocr?: boolean;
  /** Include word-level OCR boxes. */
  ocrWords?: boolean;
  /** Read the active window. */
  activeWindow?: boolean;
  /** List the open top-level windows. */
  windows?: boolean;
  /** 'screen' (default) or 'active' (best-effort active-window region). */
  region?: 'screen' | 'active';
  /** OCR language (default eng). */
  lang?: string;
}

export interface CapabilityProbe {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ComputerStatus {
  platform: NodeJS.Platform;
  os: string;
  enabled: boolean;
  level: AccessLevel;
  display: DisplayInfo;
  /** When the emergency stop was last pressed (ms), or null. */
  stoppedAt: number | null;
  capabilities: Capability[];
  /** What Jarvis is doing on the computer right now (state machine + pending confirmations). */
  live: LiveStatus;
}

/** Thrown when a critical action needs the user's explicit confirmation first. */
export class ConfirmationRequired extends UserError {
  confirmation: PendingConfirmation;
  constructor(confirmation: PendingConfirmation) {
    super(`Needs your confirmation: ${confirmation.summary} — ${confirmation.finding.reason}. Approve it in the Computer Access panel (id ${confirmation.id.slice(0, 8)}), then ask again.`, 409);
    this.name = 'ConfirmationRequired';
    this.confirmation = confirmation;
  }
}

/** Options every acting method accepts. */
export interface ActOptions {
  /** The user explicitly approved THIS action (e.g. via the approval prompt). Skips the critical-action confirmation. */
  preapproved?: boolean;
  /** Short description of the task this action serves (shown in the panel / audit log). */
  task?: string;
}

export type BrowserOp =
  | { op: 'tabs' }
  | { op: 'open'; url: string }
  | { op: 'activate'; tabId: string }
  | { op: 'close_tab'; tabId: string }
  | { op: 'navigate'; url: string; tabId?: string }
  | { op: 'back'; tabId?: string }
  | { op: 'read'; tabId?: string; maxChars?: number }
  | { op: 'click'; target: ElementTarget; expectText?: string; expectUrl?: string; tabId?: string }
  | { op: 'type'; target?: ElementTarget; text: string; clear?: boolean; submit?: boolean; tabId?: string }
  | { op: 'key'; key: string; tabId?: string }
  | { op: 'scroll'; direction: 'up' | 'down'; amount?: number; tabId?: string }
  | { op: 'wait_text'; text: string; timeoutMs?: number; tabId?: string }
  | { op: 'dismiss_dialog'; tabId?: string };

export type BrowserOpResult =
  | { op: 'tabs'; tabs: TabInfo[] }
  | { op: 'open'; tab: TabInfo }
  | { op: 'read'; tabId: string; page: PageRead }
  | { op: 'wait_text'; tabId: string; found: boolean }
  | { op: string; tabId?: string; result: BrowserActionResult };

interface ManagerDeps {
  settings: SettingsStore;
  /** Persists the Computer Access action log (optional — in-memory without it). */
  db?: Database;
  activity: ActivityLog;
  bus: EventBus;
  adapter?: OsAdapter;
  inputDriver?: InputDriver;
  /** Directory for retained screenshots (defaults to the OS temp dir). */
  shotsDir?: () => string;
  /** Jarvis's dedicated browser profile (where the user signs in once). */
  browserProfileDir?: () => string;
}

/** Non-internal network interfaces (addresses only; no throughput). */
function externalInterfaces(): Array<{ name: string; address: string; family: string }> {
  const out: Array<{ name: string; address: string; family: string }> = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      out.push({ name, address: a.address, family: String(a.family) });
    }
  }
  return out;
}

/** Aggregate CPU busy% across all cores, from one sample of os.cpus() times. */
function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

/**
 * ComputerAccessManager — the service half of Computer Access Mode.
 *
 * It is the single place that decides, from settings, whether Jarvis may observe or control the
 * computer and at what level, holds the emergency-stop + abort plumbing, and reports — honestly —
 * what the host can actually do. Observe-level telemetry (processes, CPU/RAM, the active window,
 * network) is implemented here and genuinely works; everything that needs native input/screen/
 * accessibility is reported as unavailable until it is wired and verified on a real machine.
 */
export class ComputerAccessManager {
  private settings: SettingsStore;
  private activity: ActivityLog;
  private bus: EventBus;
  private adapter: OsAdapter;
  private inputDriver: InputDriver;
  /** Aborted when the user turns Computer Access off or hits the emergency stop; in-flight control actions listen to it. */
  private controller = new AbortController();
  private stoppedAt: number | null = null;
  private lastEnabled: boolean;
  private shotsDir: () => string;
  /** Results of the last real capability probes (capture/ocr/windows), used to upgrade the report to "available". */
  private probes = new Map<string, CapabilityProbe & { at: number }>();
  /** Live state machine, action log and critical-action confirmations. */
  readonly actions: ComputerActivity;
  private browserCtl: BrowserController | null = null;
  private browserProfileDir: () => string;

  constructor(deps: ManagerDeps) {
    this.settings = deps.settings;
    this.activity = deps.activity;
    this.bus = deps.bus;
    this.adapter = deps.adapter ?? currentAdapter();
    this.inputDriver = deps.inputDriver ?? currentInputDriver();
    this.shotsDir = deps.shotsDir ?? (() => tmpdir());
    this.browserProfileDir = deps.browserProfileDir ?? (() => join(this.shotsDir(), '..', 'browser-profile'));
    this.actions = new ComputerActivity({ db: deps.db ?? null, bus: this.bus });
    this.lastEnabled = this.enabled();
  }

  enabled(): boolean {
    return this.settings.get().computerAccess.enabled;
  }

  watchIntervalSec(): number {
    return this.settings.get().computerAccess.watchIntervalSec;
  }

  level(): AccessLevel {
    return this.settings.get().computerAccess.level;
  }

  display(): DisplayInfo {
    return this.adapter.detectDisplay();
  }

  /** The signal in-flight control actions must abort on. Replaced after every stop. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Is Computer Access on and at a level that permits work needing `need`? */
  permits(need: AccessLevel): { ok: boolean; reason: string } {
    if (!this.enabled()) return { ok: false, reason: 'Computer Access is off. Turn it on in Settings.' };
    const have = this.level();
    if (levelRank(have) < levelRank(need)) return { ok: false, reason: `Computer Access is at the "${have}" level; this needs "${need}".` };
    return { ok: true, reason: `Permitted at the "${have}" level.` };
  }

  capabilities(): Capability[] {
    const display = this.adapter.detectDisplay();
    const telemetry: Capability = {
      id: 'telemetry',
      label: 'See what the computer is doing',
      level: 'observe',
      status: 'available',
      detail: 'Running processes, CPU/RAM, the active window (where the display allows) and network — implemented and working.',
    };
    // Overlay real probe results: a capability is only upgraded to "available" once a live probe
    // actually succeeded on this host (and downgraded to "unavailable" if a probe failed).
    const withProbes = this.adapter.controlCapabilities(display).map((c) => {
      const p = this.probes.get(c.id);
      if (!p) return c;
      // A passing live probe is real evidence (e.g. a debuggable browser connected even though no
      // browser binary was detected), so it upgrades any status. "limited" stays limited unless its
      // own probe proved the full capability.
      if (p.ok && c.status !== 'limited') return { ...c, status: 'available' as const, detail: `Verified: ${p.detail}` };
      if (p.ok && c.status === 'limited') return { ...c, detail: `${c.detail} Verified: ${p.detail}` };
      if (!p.ok && c.status === 'unverified') return { ...c, status: 'unavailable' as const, detail: `Verification failed: ${p.detail}` };
      return c;
    });
    return [telemetry, ...withProbes];
  }

  status(): ComputerStatus {
    return {
      platform: this.adapter.platform,
      os: this.adapter.displayName,
      enabled: this.enabled(),
      level: this.level(),
      display: this.adapter.detectDisplay(),
      stoppedAt: this.stoppedAt,
      capabilities: this.capabilities(),
      live: this.actions.status(),
    };
  }

  /**
   * A snapshot of what the computer is doing. Gated: Computer Access must be on (observing the
   * machine is itself the observe-level capability). Window titles and process names come from the
   * user's environment, so callers treat this output as untrusted data.
   */
  async telemetry(signal?: AbortSignal, topN = 12): Promise<Telemetry> {
    if (!this.enabled()) throw new UserError('Computer Access is off — turn it on in Settings to let Jarvis observe this computer.');
    const sig = signal ?? this.controller.signal;
    const before = cpuTimes();
    await sleep(120, sig).catch(() => {});
    const after = cpuTimes();
    const totalDelta = after.total - before.total;
    const idleDelta = after.idle - before.idle;
    const usagePercent = totalDelta > 0 ? Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10)) : null;

    const [procs, win] = await Promise.all([this.adapter.listProcesses(topN, sig), this.adapter.activeWindow(sig)]);
    const total = totalmem();
    const free = freemem();
    const cpuList = cpus();
    return {
      capturedAt: Date.now(),
      platform: this.adapter.platform,
      hostname: hostname(),
      uptimeSec: Math.floor(uptime()),
      cpu: { cores: cpuList.length, model: cpuList[0]?.model?.trim() ?? 'unknown', loadAvg1: Math.round(loadavg()[0] * 100) / 100, usagePercent },
      memory: { totalBytes: total, freeBytes: free, usedBytes: total - free, usedPercent: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0 },
      processes: { total: procs.total, top: procs.processes, available: procs.available, detail: procs.detail },
      activeWindow: win,
      network: { interfaces: externalInterfaces(), counters: this.adapter.networkCounters() },
    };
  }

  /** A signal that aborts when the caller's does OR when Computer Access is stopped/turned off. */
  private combinedSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
  }

  /**
   * One unified observation of the computer, gated behind the toggle: capture the screen, read it as
   * text with OCR (text only — never raw pixels into the model), read the active window and list the
   * open windows. Abortable via the shared STOP signal. Screenshots are written to the retention dir
   * and deleted immediately when retention is 0.
   */
  async observe(opts: ObserveOptions = {}, signal?: AbortSignal): Promise<Observation> {
    if (!this.enabled()) throw new UserError('Computer Access is off — turn it on in Settings to let Jarvis observe this computer.');
    const sig = this.combinedSignal(signal);
    const wantShot = Boolean(opts.screenshot || opts.ocr);
    const wantOcr = Boolean(opts.ocr);
    const notes: string[] = [];
    const obs: Observation = { capturedAt: Date.now(), screenshot: null, ocr: null, activeWindow: null, windows: null, notes };

    if (wantShot) {
      const display = this.adapter.detectDisplay();
      const tool = detectCaptureTool(this.adapter.platform, display);
      if (!tool) {
        notes.push(`Screen capture unavailable: ${display.headless ? 'no display on this host' : 'no screenshot tool installed'}.`);
      } else {
        const retentionMin = this.settings.get().computerAccess.screenshotRetentionMin;
        try {
          const dir = this.shotsDir();
          await mkdir(dir, { recursive: true }).catch(() => {});
          const shot = await captureScreen({ tool, signal: sig, region: opts.region ?? 'screen', dir, deleteAfter: false });
          obs.screenshot = shot;
          this.probes.set('screen.capture', { id: 'screen.capture', ok: true, detail: `captured ${shot.width}x${shot.height} via ${shot.tool}`, at: Date.now() });
          if (wantOcr) {
            if (!ocrAvailable()) {
              notes.push('OCR unavailable: tesseract is not installed.');
            } else if (shot.path) {
              obs.ocr = await ocrImage(shot.path, { signal: sig, words: opts.ocrWords, lang: opts.lang });
              this.probes.set('screen.ocr', { id: 'screen.ocr', ok: true, detail: `OCR read ${obs.ocr.text.length} chars`, at: Date.now() });
            }
          }
          // Retention: delete now when 0, else schedule deletion.
          if (shot.path && retentionMin <= 0) {
            await unlink(shot.path).catch(() => {});
            shot.path = null;
          } else if (shot.path) {
            const path = shot.path;
            const t = setTimeout(() => void unlink(path).catch(() => {}), retentionMin * 60_000);
            t.unref?.();
          }
        } catch (err) {
          notes.push(`Capture/OCR failed: ${(err as Error).message}`);
        }
      }
    }

    if (opts.activeWindow !== false) obs.activeWindow = await this.adapter.activeWindow(sig).catch((err) => ({ title: null, app: null, pid: null, available: false, detail: (err as Error).message }));
    if (opts.windows) {
      const w = await this.adapter.listWindows(sig).catch((err) => ({ windows: [], available: false, detail: (err as Error).message }));
      obs.windows = { list: w.windows, available: w.available, detail: w.detail };
    }
    return obs;
  }

  /**
   * Perform one input action (mouse/keyboard/scroll/window switch). Gated by the toggle AND the
   * "interact" level; the permission engine separately gates the consequential `computer.control`
   * scope (never auto-allowed). Threads the STOP signal and records the result as probe evidence.
   */
  /** Whether this host has a working input path at all (honest; used to gate the control skill). */
  interactionAvailable(): { available: boolean; reason?: string } {
    return this.inputDriver.available(this.adapter.detectDisplay());
  }

  /**
   * The single safety gate for critical actions. A critical action (send, pay, delete, install,
   * admin, legal agreement…) runs only if the user confirmed THIS exact action — a pending
   * confirmation is raised otherwise and the action does not happen. Full Access does not bypass it.
   */
  private guard(kind: string, ctx: ActionContext, summary: string, opts: ActOptions): CriticalFinding | null {
    const finding = classifyAction(ctx);
    if (!finding) return null;
    if (opts.preapproved) return finding;
    const check = this.actions.checkConfirmation(actionFingerprint(kind, ctx), kind, summary, finding);
    if (check.confirmed) return finding;
    this.actions.record({ kind, target: ctx.label ?? ctx.typed ?? ctx.keys ?? null, detail: `Held for confirmation: ${finding.reason}`, outcome: 'needs_confirmation', verified: null, critical: finding.category, task: opts.task ?? null, durationMs: null });
    this.actions.setState('WAITING_FOR_APPROVAL', { detail: summary });
    this.activity.notify('warning', 'Computer Access needs your confirmation', `${summary} — ${finding.reason}`, { dedupeKey: `computer-confirm:${check.pending.id}` });
    throw new ConfirmationRequired(check.pending);
  }

  /** Run `fn` while showing `state`, record the outcome, and return to IDLE (or ERROR). */
  private async tracked<T>(state: ComputerState, kind: string, target: string | null, opts: ActOptions & { critical?: string | null }, fn: () => Promise<T>, outcomeOf: (r: T) => { ok: boolean; verified: boolean | null; detail: string }): Promise<T> {
    const started = Date.now();
    this.actions.setState(state, { task: opts.task ?? null, detail: `${kind}${target ? ` ${target}` : ''}` });
    try {
      const r = await fn();
      const o = outcomeOf(r);
      this.actions.record({ kind, target, detail: o.detail, outcome: !o.ok ? 'failed' : o.verified === false ? 'unverified' : 'ok', verified: o.verified, critical: opts.critical ?? null, task: opts.task ?? null, durationMs: Date.now() - started });
      this.actions.setState(o.ok ? 'IDLE' : 'ERROR', { detail: o.detail });
      return r;
    } catch (err) {
      const aborted = this.controller.signal.aborted || /stopped|turned off|cancel|abort/i.test((err as Error).message);
      if (!(err instanceof ConfirmationRequired)) {
        this.actions.record({ kind, target, detail: (err as Error).message, outcome: aborted ? 'cancelled' : 'failed', verified: null, critical: opts.critical ?? null, task: opts.task ?? null, durationMs: Date.now() - started });
        this.actions.setState(aborted ? 'IDLE' : 'ERROR', { detail: (err as Error).message });
      }
      throw err;
    }
  }

  async control(action: InputAction, signal?: AbortSignal, opts: ActOptions = {}): Promise<InputResult> {
    const gate = this.permits(action.kind === 'window' && action.op === 'close' ? 'extended' : 'interact');
    if (!gate.ok) throw new UserError(gate.reason);
    const avail = this.inputDriver.available(this.adapter.detectDisplay());
    if (!avail.available) throw new UserError(`Interaction is unavailable here: ${avail.reason}`);
    // Semantic context for the critical-action check: what is clicked/typed/pressed and where.
    let where: string | null = null;
    if (action.kind === 'key' || action.kind === 'type') where = (await this.adapter.activeWindow(this.combinedSignal(signal)).catch(() => null))?.title ?? null;
    const ctx: ActionContext =
      action.kind === 'click' ? { label: action.label ?? null } : action.kind === 'type' ? { typed: action.text, where } : action.kind === 'key' ? { keys: action.keys, where } : action.kind === 'window' && action.op === 'close' ? { label: 'close window' } : {};
    const summarize = () => (action.kind === 'click' ? `click${action.label ? ` "${action.label}"` : ''}` : action.kind === 'type' ? `type ${JSON.stringify(action.text.slice(0, 40))}` : action.kind === 'key' ? `press ${action.keys}` : action.kind === 'window' ? `${action.op} window "${action.title}"` : action.kind);
    let finding = this.guard(`input.${action.kind}`, ctx, summarize(), opts);
    if (!finding && action.kind === 'window' && action.op === 'close') {
      // Closing a window can discard unsaved work: always confirm.
      const f: CriticalFinding = { category: 'delete', reason: `closing "${action.title}" may discard unsaved work` };
      if (!opts.preapproved) {
        const check = this.actions.checkConfirmation(actionFingerprint('input.window.close', { label: action.title }), 'input.window', summarize(), f);
        if (!check.confirmed) {
          this.actions.setState('WAITING_FOR_APPROVAL', { detail: summarize() });
          throw new ConfirmationRequired(check.pending);
        }
      }
      finding = f;
    }
    if (this.controller.signal.aborted) throw new UserError('Computer Access was stopped.');
    return this.tracked(
      'INTERACTING',
      `input.${action.kind}`,
      summarize(),
      { ...opts, critical: finding?.category ?? null },
      async () => {
        const res = await this.inputDriver.perform(action, this.combinedSignal(signal));
        const capId = actionCapability(action.kind);
        if (res.ok) this.probes.set(capId, { id: capId, ok: res.verified ? res.verified.ok : true, detail: res.verified?.detail ?? res.detail, at: Date.now() });
        this.activity.log('info', 'system', `Computer Access: ${res.action} — ${res.detail}${res.verified ? ` (verified: ${res.verified.ok ? 'yes' : 'no'})` : ''}`);
        return res;
      },
      (r) => ({ ok: r.ok, verified: r.verified ? r.verified.ok : null, detail: r.verified ? `${r.detail} — ${r.verified.detail}` : r.detail }),
    );
  }

  // ------------------------------------------------------------------ screen-level semantic actions

  /** Find text on the screen (OCR word boxes). Observe level. */
  async findOnScreen(text: string, signal?: AbortSignal): Promise<{ matches: ScreenTextMatch[]; screen: { width: number; height: number } | null; notes: string[] }> {
    const obs = await this.observe({ ocr: true, ocrWords: true, activeWindow: false }, signal);
    if (obs.ocr?.words.length) this.probes.set('accessibility.ocr-elements', { id: 'accessibility.ocr-elements', ok: true, detail: `located text via ${obs.ocr.words.length} OCR words`, at: Date.now() });
    return { matches: obs.ocr ? findTextOnScreen(obs.ocr.words, text) : [], screen: obs.screenshot ? { width: obs.screenshot.width, height: obs.screenshot.height } : null, notes: obs.notes };
  }

  /**
   * Click something on screen by its visible text — for apps with no accessibility tree. Observes,
   * locates, clicks, then re-observes to verify the screen changed (or that `expectText` appeared).
   */
  async clickText(text: string, opts: ActOptions & { expectText?: string; nth?: number; button?: 'left' | 'right'; double?: boolean } = {}, signal?: AbortSignal): Promise<{ clicked: ScreenTextMatch; verified: { ok: boolean; detail: string } }> {
    const gate = this.permits('interact');
    if (!gate.ok) throw new UserError(gate.reason);
    this.actions.setState('OBSERVING', { task: opts.task ?? null, detail: `looking for "${text}"` });
    const before = await this.observe({ ocr: true, ocrWords: true, activeWindow: true }, signal);
    const matches = before.ocr ? findTextOnScreen(before.ocr.words, text) : [];
    const hit = matches[opts.nth ?? 0];
    if (!hit) {
      this.actions.record({ kind: 'screen.click_text', target: text, detail: `"${text}" is not visible on screen${before.notes.length ? ` (${before.notes.join('; ')})` : ''}`, outcome: 'failed', verified: null, critical: null, task: opts.task ?? null, durationMs: null });
      this.actions.setState('ERROR', { detail: `"${text}" not found on screen` });
      throw new UserError(`"${text}" is not visible on the screen right now.${before.ocr ? '' : ` ${before.notes.join(' ')}`}`);
    }
    await this.control({ kind: 'click', x: hit.x, y: hit.y, label: text, button: opts.button, count: opts.double ? 2 : 1 }, signal, opts);
    this.actions.setState('VERIFYING', { detail: `checking the result of clicking "${text}"` });
    let verified = { ok: false, detail: 'the screen did not change' };
    for (let i = 0; i < 6; i++) {
      await sleep(350, this.combinedSignal(signal));
      const after = await this.observe({ ocr: true, activeWindow: true }, signal);
      const a = after.ocr?.text ?? '';
      const b = before.ocr?.text ?? '';
      if (opts.expectText) {
        if (a.toLowerCase().includes(opts.expectText.toLowerCase())) {
          verified = { ok: true, detail: `"${opts.expectText}" is now on screen` };
          break;
        }
        verified = { ok: false, detail: `"${opts.expectText}" did not appear` };
      } else if (a !== b || after.activeWindow?.title !== before.activeWindow?.title) {
        verified = { ok: true, detail: after.activeWindow?.title !== before.activeWindow?.title ? `active window is now "${after.activeWindow?.title}"` : 'the screen changed' };
        break;
      }
    }
    this.actions.record({ kind: 'screen.verify', target: text, detail: verified.detail, outcome: verified.ok ? 'ok' : 'unverified', verified: verified.ok, critical: null, task: opts.task ?? null, durationMs: null });
    this.actions.setState(verified.ok ? 'IDLE' : 'ERROR', { detail: verified.detail });
    return { clicked: hit, verified };
  }

  // ------------------------------------------------------------------ applications & files (extended)

  async openApp(name: string, opts: ActOptions = {}, signal?: AbortSignal): Promise<AppResult> {
    const gate = this.permits('extended');
    if (!gate.ok) throw new UserError(gate.reason);
    this.guard('app.open', { label: name }, `open ${name}`, opts);
    return this.tracked(
      'INTERACTING',
      'app.open',
      name,
      opts,
      async () => {
        const r = await openApplication(name, this.combinedSignal(signal), this.adapter.platform);
        if (r.ok) this.probes.set('app.manage', { id: 'app.manage', ok: true, detail: r.detail, at: Date.now() });
        return r;
      },
      (r) => ({ ok: r.ok, verified: null, detail: r.detail }),
    );
  }

  async openFile(path: string, opts: ActOptions = {}, signal?: AbortSignal): Promise<AppResult> {
    const gate = this.permits('extended');
    if (!gate.ok) throw new UserError(gate.reason);
    return this.tracked('INTERACTING', 'file.open', path, opts, () => openPath(path, this.combinedSignal(signal), this.adapter.platform), (r) => ({ ok: r.ok, verified: null, detail: r.detail }));
  }

  async closeApp(name: string, opts: ActOptions = {}, signal?: AbortSignal): Promise<AppResult> {
    const gate = this.permits('extended');
    if (!gate.ok) throw new UserError(gate.reason);
    const finding: CriticalFinding = { category: 'delete', reason: `closing ${name} may discard unsaved work` };
    if (!opts.preapproved) {
      const check = this.actions.checkConfirmation(actionFingerprint('app.close', { label: name }), 'app.close', `close ${name}`, finding);
      if (!check.confirmed) {
        this.actions.setState('WAITING_FOR_APPROVAL', { detail: `close ${name}` });
        throw new ConfirmationRequired(check.pending);
      }
    }
    return this.tracked('INTERACTING', 'app.close', name, { ...opts, critical: 'delete' }, () => closeApplication(name, this.combinedSignal(signal), this.adapter.platform), (r) => ({ ok: r.ok, verified: r.ok, detail: r.detail }));
  }

  async appRunning(name: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.enabled()) throw new UserError('Computer Access is off.');
    return processRunning(name, this.combinedSignal(signal), this.adapter.platform);
  }

  // ------------------------------------------------------------------ browser

  /** The controller for the configured loopback DevTools endpoint. */
  browser(): BrowserController {
    const endpoint = this.settings.get().computerAccess.browserEndpoint;
    if (!this.browserCtl || this.browserCtl.debuggingEndpoint !== endpoint) {
      this.browserCtl?.closeAll();
      this.browserCtl = new BrowserController(endpoint);
    }
    return this.browserCtl;
  }

  /** Launch the user's installed browser with Jarvis's dedicated persistent profile (interact level). */
  async startBrowser(url?: string, opts: ActOptions = {}): Promise<{ endpoint: string; binary: string; alreadyRunning: boolean }> {
    const gate = this.permits('interact');
    if (!gate.ok) throw new UserError(gate.reason);
    const probe = await this.browser().probe();
    if (probe.ok) return { endpoint: this.browser().debuggingEndpoint, binary: probe.browser ?? 'browser', alreadyRunning: true };
    const port = Number(new URL(this.settings.get().computerAccess.browserEndpoint).port) || 9222;
    const r = launchBrowser({ profileDir: this.browserProfileDir(), port, url });
    for (let i = 0; i < 40; i++) {
      await sleep(250, this.controller.signal);
      if ((await this.browser().probe()).ok) break;
    }
    const ok = (await this.browser().probe()).ok;
    this.actions.record({ kind: 'browser.start', target: r.binary, detail: ok ? `started ${r.binary} (Jarvis profile) on ${r.endpoint}` : `started ${r.binary} but its DevTools endpoint did not come up`, outcome: ok ? 'ok' : 'failed', verified: ok, critical: null, task: opts.task ?? null, durationMs: null });
    if (!ok) throw new UserError(`Started ${r.binary} but could not connect to it on ${r.endpoint}. If your browser was already open, close it and try again (it must start with the debugging port).`);
    return { endpoint: r.endpoint, binary: r.binary, alreadyRunning: false };
  }

  browserBinary(): string | null {
    return detectBrowserBinary(this.adapter.platform);
  }

  private async resolveTab(tabId: string | undefined, signal: AbortSignal): Promise<string> {
    if (tabId) return tabId;
    const t = await this.browser().activeTab(signal);
    if (!t) throw new UserError('No browser tab is open. Open one first (op "open").');
    return t.id;
  }

  /**
   * One browser operation, gated (read ops need observe, the rest interact), guarded for critical
   * actions (clicking "Send"/"Pay"/…, typing a card number, Enter in a composer), tracked in the live
   * state + action log, and verified by the controller (observe → act → observe).
   */
  async browserOp(req: BrowserOp, signal?: AbortSignal, opts: ActOptions = {}): Promise<BrowserOpResult> {
    const readOnly = req.op === 'tabs' || req.op === 'read' || req.op === 'wait_text';
    const gate = this.permits(readOnly ? 'observe' : 'interact');
    if (!gate.ok) throw new UserError(gate.reason);
    const sig = this.combinedSignal(signal);
    const b = this.browser();
    const probe = await b.probe(sig);
    if (!probe.ok) throw new UserError(probe.detail);
    this.probes.set('browser.control', { id: 'browser.control', ok: true, detail: `connected to ${probe.detail}`, at: Date.now() });
    const ok = (r: BrowserActionResult) => ({ ok: r.ok, verified: r.verified ? r.verified.ok : null, detail: `${r.detail}${r.verified ? ` — ${r.verified.detail}` : ''}${r.loginRequired ? ' — the page wants you to sign in' : ''}` });

    switch (req.op) {
      case 'tabs': {
        const tabs = await b.listTabs(sig);
        return { op: 'tabs', tabs };
      }
      case 'open': {
        const tab = await this.tracked('INTERACTING', 'browser.open', req.url, opts, () => b.openTab(req.url, sig), (t) => ({ ok: true, verified: null, detail: `opened ${t.url}` }));
        return { op: 'open', tab };
      }
      case 'activate': {
        const result = await this.tracked('INTERACTING', 'browser.activate', req.tabId, opts, async () => {
          await b.activateTab(req.tabId, sig);
          return { ok: true, action: 'activate', detail: `switched to tab ${req.tabId}`, verified: null } as BrowserActionResult;
        }, ok);
        return { op: 'activate', tabId: req.tabId, result };
      }
      case 'close_tab': {
        const result = await this.tracked('INTERACTING', 'browser.close_tab', req.tabId, opts, async () => {
          await b.closeTab(req.tabId, sig);
          const still = (await b.listTabs(sig)).some((t) => t.id === req.tabId);
          return { ok: !still, action: 'close tab', detail: still ? 'tab still open' : 'tab closed', verified: { ok: !still, detail: still ? 'still listed' : 'gone from the tab list' } } as BrowserActionResult;
        }, ok);
        return { op: 'close_tab', tabId: req.tabId, result };
      }
      case 'read': {
        const tabId = await this.resolveTab(req.tabId, sig);
        this.actions.setState('OBSERVING', { task: opts.task ?? null, detail: 'reading the page' });
        const page = await b.read(tabId, { maxChars: req.maxChars }, sig);
        this.actions.setActiveApp(`Browser — ${page.title || page.url}`);
        this.actions.record({ kind: 'browser.read', target: page.url, detail: `read "${page.title}" (${page.textLength} chars, ${page.elements.length} controls${page.dialogs.length ? `, ${page.dialogs.length} dialog(s)` : ''}${page.loginRequired ? ', sign-in required' : ''})`, outcome: 'ok', verified: true, critical: null, task: opts.task ?? null, durationMs: null });
        this.actions.setState('IDLE');
        return { op: 'read', tabId, page };
      }
      case 'wait_text': {
        const tabId = await this.resolveTab(req.tabId, sig);
        const found = await b.waitForText(tabId, req.text, sig, req.timeoutMs ?? 10000);
        return { op: 'wait_text', tabId, found };
      }
      case 'navigate': {
        const tabId = await this.resolveTab(req.tabId, sig);
        const result = await this.tracked('INTERACTING', 'browser.navigate', req.url, opts, () => b.navigate(tabId, req.url, sig), ok);
        return { op: 'navigate', tabId, result };
      }
      case 'back': {
        const tabId = await this.resolveTab(req.tabId, sig);
        const result = await this.tracked('INTERACTING', 'browser.back', null, opts, () => b.back(tabId, sig), ok);
        return { op: 'back', tabId, result };
      }
      case 'click': {
        const tabId = await this.resolveTab(req.tabId, sig);
        const page = await b.read(tabId, { maxChars: 200 }, sig);
        const loc = await b.locate(tabId, req.target, sig);
        const label = loc.el?.name ?? req.target.name ?? null;
        const finding = this.guard('browser.click', { label, where: `${page.title} ${page.url}` }, `click "${label ?? '?'}" on ${page.title || page.url}`, opts);
        const result = await this.tracked('INTERACTING', 'browser.click', label, { ...opts, critical: finding?.category ?? null }, () => b.click(tabId, req.target, { expectText: req.expectText, expectUrl: req.expectUrl }, sig), ok);
        return { op: 'click', tabId, result };
      }
      case 'type': {
        const tabId = await this.resolveTab(req.tabId, sig);
        const page = await b.read(tabId, { maxChars: 200 }, sig);
        const finding = this.guard('browser.type', { typed: req.text, keys: req.submit ? 'Return' : null, where: `${page.title} ${page.url}` }, `type ${JSON.stringify(req.text.slice(0, 40))}${req.submit ? ' and press Enter' : ''} on ${page.title || page.url}`, opts);
        const result = await this.tracked('INTERACTING', 'browser.type', req.target?.name ?? null, { ...opts, critical: finding?.category ?? null }, () => b.type(tabId, req.target ?? null, req.text, { clear: req.clear, submit: req.submit }, sig), ok);
        return { op: 'type', tabId, result };
      }
      case 'key': {
        const tabId = await this.resolveTab(req.tabId, sig);
        const page = await b.read(tabId, { maxChars: 200 }, sig);
        const finding = this.guard('browser.key', { keys: req.key, where: `${page.title} ${page.url}` }, `press ${req.key} on ${page.title || page.url}`, opts);
        const result = await this.tracked('INTERACTING', 'browser.key', req.key, { ...opts, critical: finding?.category ?? null }, () => b.pressKey(tabId, req.key, sig), ok);
        return { op: 'key', tabId, result };
      }
      case 'scroll': {
        const tabId = await this.resolveTab(req.tabId, sig);
        const result = await this.tracked('INTERACTING', 'browser.scroll', req.direction, opts, () => b.scroll(tabId, req.direction, req.amount ?? 600, sig), ok);
        return { op: 'scroll', tabId, result };
      }
      case 'dismiss_dialog': {
        const tabId = await this.resolveTab(req.tabId, sig);
        const result = await this.tracked('INTERACTING', 'browser.dismiss_dialog', null, opts, () => b.dismissDialog(tabId, sig), ok);
        return { op: 'dismiss_dialog', tabId, result };
      }
    }
  }

  /** The user's decision on a pending critical-action confirmation (authenticated local UI/API only). */
  decideConfirmation(id: string, approve: boolean): PendingConfirmation {
    const c = this.actions.decide(id, approve);
    if (!c) throw new UserError('That confirmation is no longer pending (it expired, was used, or Computer Access was stopped).', 404);
    this.activity.log(approve ? 'info' : 'warning', 'system', `Computer Access: you ${approve ? 'confirmed' : 'refused'} "${c.summary}"`);
    if (this.actions.state() === 'WAITING_FOR_APPROVAL') this.actions.setState(approve ? 'IDLE' : 'PAUSED', { detail: approve ? 'confirmed — Jarvis can retry the action' : 'refused' });
    return c;
  }

  /**
   * Run real capability probes on THIS machine and record the evidence. This is what lets the
   * capability report say "available" honestly: it captures a screenshot, OCRs a known-text image,
   * lists windows and reads the active window, and reports each as pass/fail with detail.
   */
  async verify(signal?: AbortSignal): Promise<CapabilityProbe[]> {
    const sig = this.combinedSignal(signal);
    const out: CapabilityProbe[] = [];
    const record = (p: CapabilityProbe) => {
      this.probes.set(p.id, { ...p, at: Date.now() });
      out.push(p);
    };
    const display = this.adapter.detectDisplay();

    const tool = detectCaptureTool(this.adapter.platform, display);
    if (!tool) record({ id: 'screen.capture', ok: false, detail: display.headless ? 'no display on this host' : 'no screenshot tool installed' });
    else {
      try {
        const dir = this.shotsDir();
        await mkdir(dir, { recursive: true }).catch(() => {});
        const shot = await captureScreen({ tool, signal: sig, dir, deleteAfter: true });
        record({ id: 'screen.capture', ok: shot.width > 0 && shot.height > 0, detail: `captured ${shot.width}x${shot.height} via ${shot.tool}` });
      } catch (err) {
        record({ id: 'screen.capture', ok: false, detail: (err as Error).message });
      }
    }

    record({ id: 'screen.ocr', ...(await verifyOcr(sig)) });

    const win = await this.adapter.listWindows(sig).catch((err) => ({ windows: [], available: false, detail: (err as Error).message }));
    record({ id: 'accessibility', ok: win.available, detail: win.detail });

    const active = await this.adapter.activeWindow(sig).catch((err) => ({ available: false, detail: (err as Error).message }) as Awaited<ReturnType<OsAdapter['activeWindow']>>);
    out.push({ id: 'active-window', ok: active.available, detail: active.detail });

    this.bus.emit('computer.changed', { verified: true });
    return out;
  }

  /**
   * Emergency stop: abort any in-flight control actions and turn Computer Access off. This is the
   * single hard off-switch the master brief requires; flipping settings.computerAccess.enabled also
   * stops background observation and any scheduled computer work.
   */
  emergencyStop(reason = 'Emergency stop'): ComputerStatus {
    this.controller.abort(new Error(`Computer Access stopped: ${reason}`));
    this.controller = new AbortController();
    this.stoppedAt = Date.now();
    this.actions.clearConfirmations();
    this.actions.setState('IDLE', { task: null, detail: `Stopped: ${reason}`, learningSession: null });
    this.actions.record({ kind: 'stop', target: null, detail: reason, outcome: 'ok', verified: null, critical: null, task: null, durationMs: null });
    if (this.enabled()) this.settings.update({ computerAccess: { enabled: false } });
    this.lastEnabled = false;
    this.activity.log('warning', 'system', `Computer Access STOPPED — ${reason}`);
    this.bus.emit('computer.changed', { enabled: false, stopped: true });
    return this.status();
  }

  /**
   * Called when settings change: if Computer Access was just turned off, abort in-flight control so
   * nothing keeps acting after the user disables it.
   */
  handleSettingsChanged(): void {
    const enabled = this.enabled();
    if (this.lastEnabled && !enabled) {
      this.controller.abort(new Error('Computer Access turned off'));
      this.controller = new AbortController();
      this.actions.clearConfirmations();
      this.actions.setState('IDLE', { task: null, detail: 'Computer Access turned off', learningSession: null });
      this.activity.log('info', 'system', 'Computer Access turned off — in-flight actions aborted.');
      this.bus.emit('computer.changed', { enabled: false });
    } else if (!this.lastEnabled && enabled) {
      this.activity.log('info', 'system', `Computer Access turned on at the "${this.level()}" level.`);
      this.bus.emit('computer.changed', { enabled: true, level: this.level() });
    }
    this.lastEnabled = enabled;
  }
}
