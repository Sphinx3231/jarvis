import { cpus, freemem, hostname, loadavg, networkInterfaces, totalmem, uptime } from 'node:os';
import type { ActivityLog } from '../core/activity.ts';
import type { EventBus } from '../core/events.ts';
import type { SettingsStore } from '../core/settings.ts';
import { sleep, UserError } from '../core/util.ts';
import { currentAdapter } from './adapters.ts';
import type { AccessLevel, Capability, DisplayInfo, OsAdapter, Telemetry } from './types.ts';
import { levelRank } from './types.ts';

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

  constructor(deps: ManagerDeps) {
    this.settings = deps.settings;
    this.activity = deps.activity;
    this.bus = deps.bus;
    this.adapter = deps.adapter ?? currentAdapter();
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
    return [telemetry, ...this.adapter.controlCapabilities(display)];
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
