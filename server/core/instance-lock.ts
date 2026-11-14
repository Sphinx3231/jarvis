import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One Jarvis per data directory. Two running task engines on the same database would each treat
 * the other's running tasks as crashed, so a second start is refused and pointed at the first.
 */
export class AlreadyRunningError extends Error {
  readonly code = 'EJARVISRUNNING';
  readonly pid: number;
  readonly url: string | null;
  constructor(pid: number, url: string | null) {
    super(`Jarvis is already running for this data folder (process ${pid}${url ? ` at ${url}` : ''})`);
    this.pid = pid;
    this.url = url;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface InstanceLock {
  setUrl(url: string): void;
  release(): void;
}

/** Locks held by this process (a pid check alone cannot tell two in-process instances apart). */
const heldHere = new Map<string, { url: string | null }>();

export function acquireInstanceLock(dataDir: string): InstanceLock {
  const path = join(dataDir, 'jarvis.lock');
  const mine = heldHere.get(path);
  if (mine) throw new AlreadyRunningError(process.pid, mine.url);
  const write = (url: string | null) => writeFileSync(path, JSON.stringify({ pid: process.pid, url, startedAt: Date.now() }));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, url: null, startedAt: Date.now() }));
      closeSync(fd);
      let released = false;
      const entry = { url: null as string | null };
      heldHere.set(path, entry);
      return {
        setUrl: (url) => {
          entry.url = url;
          write(url);
        },
        release: () => {
          if (released) return;
          released = true;
          heldHere.delete(path);
          try {
            const held = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
            if (held.pid === process.pid) unlinkSync(path);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let held: { pid?: number; url?: string | null } = {};
      try {
        held = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        /* unreadable: treat as stale */
      }
      if (held.pid && held.pid !== process.pid && alive(held.pid)) throw new AlreadyRunningError(held.pid, held.url ?? null);
      try {
        unlinkSync(path); // stale lock from a process that is gone
      } catch {
        /* raced with another starter; retry */
      }
    }
  }
  throw new Error('Could not acquire the Jarvis instance lock');
}
