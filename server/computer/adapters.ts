import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform as osPlatform } from 'node:os';
import type { ActiveWindow, Capability, DisplayInfo, OsAdapter, ProcessInfo } from './types.ts';

/** Run a command (no shell) with a timeout; rejects on spawn error (e.g. the tool isn't installed). */
function run(cmd: string, args: string[], signal: AbortSignal, timeoutMs = 4000): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
    const done = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = () => child.kill('SIGTERM');
    const onAbort = () => done(() => reject(new Error('aborted')));
    const timer = setTimeout(() => {
      kill();
      done(() => reject(new Error(`${cmd} timed out`)));
    }, timeoutMs);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
      if (stdout.length > 500_000) kill();
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => done(() => reject(err)));
    child.on('close', (code) => done(() => resolve({ code, stdout, stderr })));
  });
}

/** Parse `ps -eo pid=,pcpu=,pmem=,comm=` output (Linux & macOS). */
function parsePs(stdout: string, limit: number): { processes: ProcessInfo[]; total: number } {
  const rows: ProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+?)\s*$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), cpu: Number(m[2]), memPercent: Number(m[3]), name: m[4] });
  }
  const total = rows.length;
  const top = rows.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0)).slice(0, limit);
  return { processes: top, total };
}

/** The native control capabilities Jarvis does NOT yet have wired, reported honestly per platform. */
function nativeControlCapabilities(platform: NodeJS.Platform, display: DisplayInfo): Capability[] {
  const headlessNote = display.headless ? ' No usable display on this host, so this is impossible here regardless.' : '';
  const accessibilityReq =
    platform === 'win32'
      ? 'Windows UI Automation bindings (native module)'
      : platform === 'darwin'
        ? 'macOS Accessibility API + granted Accessibility permission'
        : display.server === 'wayland'
          ? 'AT-SPI; limited under Wayland'
          : 'AT-SPI (X11) bindings (native module)';
  const screenReq = platform === 'darwin' ? 'screen-capture module + granted Screen Recording permission' : 'a screen-capture module (e.g. screenshot-desktop / desktopCapturer)';
  const inputReq = 'a native input module (e.g. nut.js) built for this OS';
  const base: Array<Omit<Capability, 'status' | 'detail'>> = [
    { id: 'screen.capture', label: 'Capture the screen', level: 'observe', requires: screenReq },
    { id: 'screen.ocr', label: 'Read text on screen (OCR)', level: 'observe', requires: 'an OCR engine (tesseract.js or system tesseract)' },
    { id: 'accessibility', label: 'Read the accessibility tree', level: 'observe', requires: accessibilityReq },
    { id: 'input.mouse', label: 'Move and click the mouse', level: 'interact', requires: inputReq },
    { id: 'input.keyboard', label: 'Type on the keyboard', level: 'interact', requires: inputReq },
    { id: 'window.manage', label: 'Manage windows', level: 'interact', requires: platform === 'win32' ? 'Win32 window APIs' : platform === 'darwin' ? 'AppleScript / AX API' : 'wmctrl/xdotool or a window-manager API' },
    { id: 'app.manage', label: 'Open and manage apps', level: 'extended', requires: 'OS process/launch control' },
    { id: 'browser.control', label: 'Drive a browser session', level: 'extended', requires: 'Playwright/CDP against the user’s browser' },
  ];
  return base.map((c) => ({
    ...c,
    status: 'unavailable',
    detail: `Not wired yet — needs ${c.requires}.${headlessNote} Will be enabled and verified on the user’s machine, never asserted from the cloud.`,
  }));
}

abstract class BaseAdapter implements OsAdapter {
  abstract platform: NodeJS.Platform;
  abstract displayName: string;
  abstract detectDisplay(): DisplayInfo;
  abstract listProcesses(limit: number, signal: AbortSignal): Promise<{ processes: ProcessInfo[]; total: number; available: boolean; detail: string }>;
  abstract activeWindow(signal: AbortSignal): Promise<ActiveWindow>;
  networkCounters(): { rxBytes: number; txBytes: number } | null {
    return null;
  }
  controlCapabilities(display: DisplayInfo): Capability[] {
    return nativeControlCapabilities(this.platform, display);
  }
}

class LinuxAdapter extends BaseAdapter {
  platform: NodeJS.Platform = 'linux';
  displayName = 'Linux';
  detectDisplay(): DisplayInfo {
    const wayland = process.env.WAYLAND_DISPLAY;
    const x11 = process.env.DISPLAY;
    if (wayland) return { server: 'wayland', headless: false, detail: `Wayland (${wayland}). Window text and input are often restricted under Wayland.` };
    if (x11) return { server: 'x11', headless: false, detail: `X11 (${x11}).` };
    return { server: 'headless', headless: true, detail: 'No DISPLAY or WAYLAND_DISPLAY — no graphical session (screen, windows and input are unavailable).' };
  }
  async listProcesses(limit: number, signal: AbortSignal) {
    try {
      const { stdout } = await run('ps', ['-eo', 'pid=,pcpu=,pmem=,comm='], signal);
      const { processes, total } = parsePs(stdout, limit);
      return { processes, total, available: total > 0, detail: total > 0 ? `${total} processes` : 'ps returned no rows' };
    } catch (err) {
      return { processes: [], total: 0, available: false, detail: `ps unavailable: ${(err as Error).message}` };
    }
  }
  async activeWindow(signal: AbortSignal): Promise<ActiveWindow> {
    const display = this.detectDisplay();
    if (display.headless) return { title: null, app: null, pid: null, available: false, detail: 'No display server, so there is no active window.' };
    if (display.server === 'wayland') return { title: null, app: null, pid: null, available: false, detail: 'Wayland does not expose the active window to other processes; needs a compositor-specific portal.' };
    try {
      const { stdout } = await run('xdotool', ['getactivewindow', 'getwindowname', 'getwindowpid'], signal);
      const lines = stdout.trim().split('\n');
      const pid = Number(lines.at(-1));
      const title = lines.slice(0, -1).join(' ').trim() || null;
      return { title, app: null, pid: Number.isFinite(pid) ? pid : null, available: true, detail: 'Read via xdotool.' };
    } catch (err) {
      return { title: null, app: null, pid: null, available: false, detail: `Needs xdotool on X11: ${(err as Error).message}` };
    }
  }
  networkCounters(): { rxBytes: number; txBytes: number } | null {
    try {
      const text = readFileSync('/proc/net/dev', 'utf8');
      let rx = 0;
      let tx = 0;
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([^:]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
        if (!m || m[1].trim() === 'lo') continue;
        rx += Number(m[2]);
        tx += Number(m[3]);
      }
      return { rxBytes: rx, txBytes: tx };
    } catch {
      return null;
    }
  }
}

class MacAdapter extends BaseAdapter {
  platform: NodeJS.Platform = 'darwin';
  displayName = 'macOS';
  detectDisplay(): DisplayInfo {
    return { server: 'quartz', headless: false, detail: 'Quartz (macOS). Screen Recording and Accessibility permissions are required for capture and control.' };
  }
  async listProcesses(limit: number, signal: AbortSignal) {
    try {
      const { stdout } = await run('ps', ['-eo', 'pid=,pcpu=,pmem=,comm='], signal);
      const { processes, total } = parsePs(stdout, limit);
      return { processes, total, available: total > 0, detail: total > 0 ? `${total} processes` : 'ps returned no rows' };
    } catch (err) {
      return { processes: [], total: 0, available: false, detail: `ps unavailable: ${(err as Error).message}` };
    }
  }
  async activeWindow(signal: AbortSignal): Promise<ActiveWindow> {
    try {
      const script = 'tell application "System Events" to get name of first application process whose frontmost is true';
      const { stdout } = await run('osascript', ['-e', script], signal);
      const app = stdout.trim() || null;
      return { title: null, app, pid: null, available: Boolean(app), detail: app ? 'Front app read via osascript; window title needs Accessibility permission.' : 'osascript returned nothing (grant Automation permission).' };
    } catch (err) {
      return { title: null, app: null, pid: null, available: false, detail: `Needs osascript + Automation permission: ${(err as Error).message}` };
    }
  }
}

class WindowsAdapter extends BaseAdapter {
  platform: NodeJS.Platform = 'win32';
  displayName = 'Windows';
  detectDisplay(): DisplayInfo {
    return { server: 'windows', headless: false, detail: 'Windows desktop. Elevated apps and the secure desktop (UAC/lock screen) are out of reach.' };
  }
  async listProcesses(limit: number, signal: AbortSignal) {
    try {
      const { stdout } = await run('tasklist', ['/fo', 'csv', '/nh'], signal);
      const rows: ProcessInfo[] = [];
      for (const line of stdout.split('\n')) {
        const cols = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1));
        if (!cols || cols.length < 5) continue;
        const pid = Number(cols[1]);
        const memKb = Number(cols[4].replace(/[^\d]/g, ''));
        if (!Number.isFinite(pid)) continue;
        // tasklist gives no CPU%; memPercent is left null (we only have absolute KB, not total here).
        rows.push({ pid, name: cols[0], cpu: null, memPercent: null, });
        void memKb;
      }
      return { processes: rows.slice(0, limit), total: rows.length, available: rows.length > 0, detail: rows.length > 0 ? `${rows.length} processes (CPU% needs WMI/PerfCounters)` : 'tasklist returned no rows' };
    } catch (err) {
      return { processes: [], total: 0, available: false, detail: `tasklist unavailable: ${(err as Error).message}` };
    }
  }
  async activeWindow(signal: AbortSignal): Promise<ActiveWindow> {
    // Best-effort via PowerShell + Win32 GetForegroundWindow. Honest failure if PowerShell is absent.
    const ps = [
      'Add-Type \'using System;using System.Runtime.InteropServices;using System.Text;public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}\';',
      '$h=[W]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder 512;[void][W]::GetWindowText($h,$sb,512);$p=0;[void][W]::GetWindowThreadProcessId($h,[ref]$p);Write-Output $sb.ToString();Write-Output $p',
    ].join('');
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], signal, 6000);
      const lines = stdout.trim().split('\n');
      const pid = Number(lines.at(-1));
      const title = lines.slice(0, -1).join(' ').trim() || null;
      return { title, app: null, pid: Number.isFinite(pid) ? pid : null, available: title !== null, detail: 'Read via PowerShell + GetForegroundWindow (unverified from cloud).' };
    } catch (err) {
      return { title: null, app: null, pid: null, available: false, detail: `Needs PowerShell: ${(err as Error).message}` };
    }
  }
}

export function currentAdapter(platform: NodeJS.Platform = osPlatform()): OsAdapter {
  switch (platform) {
    case 'win32':
      return new WindowsAdapter();
    case 'darwin':
      return new MacAdapter();
    case 'linux':
      return new LinuxAdapter();
    default:
      return new LinuxAdapter();
  }
}
