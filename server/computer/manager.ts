import { mkdir, unlink } from 'node:fs/promises';
import { cpus, freemem, hostname, loadavg, networkInterfaces, tmpdir, totalmem, uptime } from 'node:os';
import type { ActivityLog } from '../core/activity.ts';
import type { EventBus } from '../core/events.ts';
import type { SettingsStore } from '../core/settings.ts';
import { sleep, UserError } from '../core/util.ts';
import { currentAdapter } from './adapters.ts';
import { captureScreen, detectCaptureTool } from './capture.ts';
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
}

interface ManagerDeps {
  settings: SettingsStore;
  activity: ActivityLog;
  bus: EventBus;
  adapter?: OsAdapter;
  /** Directory for retained screenshots (defaults to the OS temp dir). */
  shotsDir?: () => string;
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
  /** Aborted when the user turns Computer Access off or hits the emergency stop; in-flight control actions listen to it. */
  private controller = new AbortController();
  private stoppedAt: number | null = null;
  private lastEnabled: boolean;
  private shotsDir: () => string;
  /** Results of the last real capability probes (capture/ocr/windows), used to upgrade the report to "available". */
  private probes = new Map<string, CapabilityProbe & { at: number }>();

  constructor(deps: ManagerDeps) {
    this.settings = deps.settings;
    this.activity = deps.activity;
    this.bus = deps.bus;
    this.adapter = deps.adapter ?? currentAdapter();
    this.shotsDir = deps.shotsDir ?? (() => tmpdir());
    this.lastEnabled = this.enabled();
  }

  enabled(): boolean {
    return this.settings.get().computerAccess.enabled;
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
      if (p.ok && (c.status === 'unverified' || c.status === 'limited')) return { ...c, status: 'available' as const, detail: `Verified: ${p.detail}` };
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
      this.activity.log('info', 'system', 'Computer Access turned off — in-flight actions aborted.');
      this.bus.emit('computer.changed', { enabled: false });
    } else if (!this.lastEnabled && enabled) {
      this.activity.log('info', 'system', `Computer Access turned on at the "${this.level()}" level.`);
      this.bus.emit('computer.changed', { enabled: true, level: this.level() });
    }
    this.lastEnabled = enabled;
  }
}
