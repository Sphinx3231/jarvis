import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { firstBinary, hasBinary, run } from './exec.ts';

/**
 * Application management — open applications, files and folders the way a person would (the OS
 * launcher), and close them on request. Opening is an "extended" level capability; closing is also
 * treated as critical (it can discard unsaved work) and needs the user's confirmation.
 *
 * Application names are resolved conservatively: a plain name (letters, digits, dot, dash, space) is
 * passed to the platform launcher (`gtk-launch`/the binary on Linux, `open -a` on macOS, `Start-Process`
 * on Windows). No shell is ever involved, so a name can't smuggle a command.
 */

const SAFE_NAME = /^[\p{L}\p{N} ._+-]{1,80}$/u;

export interface AppResult {
  ok: boolean;
  detail: string;
  pid?: number;
}

/** Friendly aliases → per-platform launch target. */
const ALIASES: Record<string, { linux: string[]; darwin: string; win32: string }> = {
  browser: { linux: ['google-chrome', 'chromium', 'chromium-browser', 'firefox', 'microsoft-edge', 'brave-browser'], darwin: 'Safari', win32: 'msedge' },
  chrome: { linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'], darwin: 'Google Chrome', win32: 'chrome' },
  firefox: { linux: ['firefox'], darwin: 'Firefox', win32: 'firefox' },
  terminal: { linux: ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'], darwin: 'Terminal', win32: 'wt' },
  files: { linux: ['nautilus', 'thunar', 'dolphin', 'pcmanfm', 'nemo'], darwin: 'Finder', win32: 'explorer' },
  editor: { linux: ['gnome-text-editor', 'gedit', 'kate', 'mousepad', 'xed', 'code'], darwin: 'TextEdit', win32: 'notepad' },
  calculator: { linux: ['gnome-calculator', 'kcalc', 'galculator', 'xcalc'], darwin: 'Calculator', win32: 'calc' },
};

function detached(cmd: string, args: string[]): Promise<AppResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', (err) => resolve({ ok: false, detail: `Could not start ${cmd}: ${err.message}` }));
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true, detail: `Started ${cmd}${args.length ? ` ${args.join(' ')}` : ''}`, pid: child.pid });
      });
    } catch (err) {
      resolve({ ok: false, detail: (err as Error).message });
    }
  });
}

export async function openApplication(name: string, signal: AbortSignal, platform: NodeJS.Platform = process.platform): Promise<AppResult> {
  const n = name.trim();
  if (!SAFE_NAME.test(n)) return { ok: false, detail: `Refused application name ${JSON.stringify(n.slice(0, 40))} (letters, digits, spaces, . _ + - only).` };
  const alias = ALIASES[n.toLowerCase()];
  if (platform === 'darwin') {
    await run('open', ['-a', alias?.darwin ?? n], signal, 15000);
    return { ok: true, detail: `Opened ${alias?.darwin ?? n}` };
  }
  if (platform === 'win32') {
    const target = alias?.win32 ?? n;
    await run(firstBinary(['powershell', 'pwsh']) ?? 'powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${target.replace(/'/g, "''")}'`], signal, 15000);
    return { ok: true, detail: `Started ${target}` };
  }
  const candidates = alias ? alias.linux : [n, n.toLowerCase().replace(/\s+/g, '-')];
  const bin = firstBinary(candidates.filter((c) => /^[a-z0-9._+-]+$/i.test(c)));
  if (bin) return detached(bin, []);
  if (hasBinary('gtk-launch')) {
    try {
      await run('gtk-launch', [n.toLowerCase().replace(/\s+/g, '-')], signal, 10000);
      return { ok: true, detail: `Launched ${n} via its desktop entry` };
    } catch {
      /* fall through */
    }
  }
  return { ok: false, detail: `No application called "${n}" was found on this computer.` };
}

/** Open a file or folder with its default application. Absolute paths only; must exist. */
export async function openPath(path: string, signal: AbortSignal, platform: NodeJS.Platform = process.platform): Promise<AppResult> {
  if (!isAbsolute(path)) return { ok: false, detail: 'Give an absolute path.' };
  if (!existsSync(path)) return { ok: false, detail: `${path} does not exist.` };
  if (platform === 'darwin') {
    await run('open', [path], signal, 15000);
    return { ok: true, detail: `Opened ${path}` };
  }
  if (platform === 'win32') {
    await run(firstBinary(['powershell', 'pwsh']) ?? 'powershell', ['-NoProfile', '-NonInteractive', '-Command', `Invoke-Item -LiteralPath '${path.replace(/'/g, "''")}'`], signal, 15000);
    return { ok: true, detail: `Opened ${path}` };
  }
  const opener = firstBinary(['xdg-open', 'gio']);
  if (!opener) return { ok: false, detail: 'Needs xdg-open (xdg-utils) to open files.' };
  return detached(opener, opener === 'gio' ? ['open', path] : [path]);
}

/** Is a process with this name running? (crash/readiness detection) */
export async function processRunning(name: string, signal: AbortSignal, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!SAFE_NAME.test(name)) return false;
  try {
    if (platform === 'win32') {
      const r = await run(firstBinary(['powershell', 'pwsh']) ?? 'powershell', ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue) { 'yes' }`], signal);
      return r.stdout.includes('yes');
    }
    const r = await run('pgrep', ['-if', name], signal);
    return r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Ask an application to quit gracefully (it may prompt to save). Critical: callers must confirm first. */
export async function closeApplication(name: string, signal: AbortSignal, platform: NodeJS.Platform = process.platform): Promise<AppResult> {
  if (!SAFE_NAME.test(name)) return { ok: false, detail: 'Refused application name.' };
  if (platform === 'darwin') {
    await run('osascript', ['-e', `tell application "${name.replace(/"/g, '')}" to quit`], signal, 15000);
  } else if (platform === 'win32') {
    await run(firstBinary(['powershell', 'pwsh']) ?? 'powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }`], signal, 15000);
  } else {
    // SIGTERM lets the app clean up; never SIGKILL.
    await run('pkill', ['-TERM', '-x', name], signal).catch(() => undefined);
  }
  await new Promise((r) => setTimeout(r, 800));
  const still = await processRunning(name, signal, platform);
  return { ok: !still, detail: still ? `${name} is still running (it may be asking to save).` : `${name} closed.` };
}
