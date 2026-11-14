import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBus } from '../core/events.ts';
import { UserError } from '../core/util.ts';
import { acceptablePath, detectRoamies, type RoamiesDetection } from './detect.ts';

/**
 * Jarvis only works where Roamies is installed. The gate remembers the last detection, re-checks on
 * request (the lock screen's "Check again", and every few seconds while locked), and announces changes.
 */
export class RoamiesGate {
  private file: string;
  private bus: EventBus;
  private current: RoamiesDetection;
  private env: NodeJS.ProcessEnv;

  constructor(dataDir: string, bus: EventBus, env: NodeJS.ProcessEnv = process.env) {
    this.file = join(dataDir, 'roamies.json');
    this.bus = bus;
    this.env = env;
    this.current = detectRoamies({ env, chosenPath: this.chosenPath() });
  }

  /** A location the user pointed Jarvis at ("I installed it somewhere else"). */
  chosenPath(): string | null {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as { path?: unknown };
      return typeof v.path === 'string' && v.path ? v.path : null;
    } catch {
      return null;
    }
  }

  detection(): RoamiesDetection {
    return this.current;
  }

  get installed(): boolean {
    return this.current.installed;
  }

  check(): RoamiesDetection {
    const prev = this.current;
    this.current = detectRoamies({ env: this.env, chosenPath: this.chosenPath() });
    if (prev.installed !== this.current.installed || prev.path !== this.current.path) {
      this.bus.emit('roamies.changed', { installed: this.current.installed, path: this.current.path });
    }
    return this.current;
  }

  /** Remember where Roamies is, if it really is there. */
  choose(path: string): RoamiesDetection {
    const p = path.trim().replace(/^"|"$/g, '');
    if (!acceptablePath(p)) throw new UserError('That is not a Roamies app. Choose the Roamies app (Roamies.app, Roamies.exe, the roamies command or the Roamies AppImage).');
    writeFileSync(this.file, JSON.stringify({ path: p }, null, 2), { mode: 0o600 });
    return this.check();
  }
}
