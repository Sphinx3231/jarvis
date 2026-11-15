import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a command with no shell, with a timeout and abort support. Rejects on spawn error (e.g. the
 * tool isn't installed) so callers can report an honest "not available" rather than a silent empty
 * result. Used for every native-observation subprocess (capture, OCR, window tools).
 */
export function run(cmd: string, args: string[], signal: AbortSignal, timeoutMs = 8000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = () => child.kill('SIGTERM');
    const onAbort = () => {
      kill();
      finish(() => reject(new Error('aborted')));
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new Error(`${cmd} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
      if (stdout.length > 2_000_000) kill();
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
  });
}

const binaryCache = new Map<string, boolean>();

/** True if an executable named `name` is on PATH. Synchronous and cached, so the capability report stays cheap. */
export function hasBinary(name: string): boolean {
  const cached = binaryCache.get(name);
  if (cached !== undefined) return cached;
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  let found = false;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      try {
        accessSync(join(dir, name + ext.toLowerCase()), isWin ? constants.F_OK : constants.X_OK);
        found = true;
        break outer;
      } catch {
        /* keep scanning */
      }
    }
  }
  binaryCache.set(name, found);
  return found;
}

/** Forget cached binary lookups (after the user installs a tool, tests, etc.). */
export function clearBinaryCache(): void {
  binaryCache.clear();
}

/** The first binary from `names` that is on PATH, or null. */
export function firstBinary(names: string[]): string | null {
  for (const n of names) if (hasBinary(n)) return n;
  return null;
}

/** Width/height from a PNG's IHDR, or null if the buffer is not a PNG. Avoids an image dependency. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
