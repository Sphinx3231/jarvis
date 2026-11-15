import { readFileSync } from 'node:fs';
import { platform as osPlatform } from 'node:os';
import { detectCaptureTool } from './capture.ts';
import { firstBinary, hasBinary, run } from './exec.ts';
import { currentInputDriver } from './input.ts';
import { ocrAvailable } from './ocr.ts';
import type { ActiveWindow, Capability, DisplayInfo, OsAdapter, ProcessInfo, WindowInfo } from './types.ts';

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

/** Is a window-listing tool present for this platform? (Coarse accessibility.) */
function windowToolPresent(platform: NodeJS.Platform, display: DisplayInfo): boolean {
  if (platform === 'win32') return firstBinary(['powershell', 'pwsh']) !== null;
  if (platform === 'darwin') return hasBinary('osascript');
  return !display.headless && (hasBinary('wmctrl') || hasBinary('xdotool'));
}

/**
 * Report the observe/interact capability surface with its HONEST status on this host, from real
 * detection (which tools exist, whether there's a display). Things that are merely detected are
 * reported "unverified" — the ComputerAccessManager upgrades them to "available" only after a live
 * probe actually succeeds. Interaction capabilities stay "unavailable" until Phase 4 wires them.
 */
function observeCapabilities(platform: NodeJS.Platform, display: DisplayInfo): Capability[] {
  const cap = detectCaptureTool(platform, display);
  const ocr = ocrAvailable();
  const winTool = windowToolPresent(platform, display);
  const input = currentInputDriver(platform).available(display);
  const inputReq = platform === 'linux' ? 'xdotool (apt install xdotool) on X11' : platform === 'darwin' ? 'cliclick (mouse) / osascript (keyboard) + Accessibility permission' : 'PowerShell / a native input module';
  const inputStatus = (label: string, id: string, level: 'interact'): Capability =>
    input.available
      ? { id, label, level, status: 'unverified', detail: `Input tool detected${input.reason ? ` (${input.reason})` : ''}. Verify or act to confirm it works here.`, requires: inputReq }
      : { id, label, level, status: 'unavailable', detail: input.reason ?? 'No input tool.', requires: inputReq };
  const out: Capability[] = [
    cap
      ? { id: 'screen.capture', label: 'Capture the screen', level: 'observe', status: 'unverified', detail: `Capture tool detected (${cap.id}). Run a verification or an observation to confirm it works here.`, requires: cap.install }
      : { id: 'screen.capture', label: 'Capture the screen', level: 'observe', status: 'unavailable', detail: display.headless ? 'No display to capture on this host.' : 'No screenshot tool found.', requires: platform === 'linux' ? 'scrot / maim / imagemagick (X11) or grim (Wayland)' : 'a screen-capture tool' },
    ocr
      ? { id: 'screen.ocr', label: 'Read text on screen (OCR)', level: 'observe', status: 'unverified', detail: 'tesseract detected. Run a verification to confirm it reads text here.', requires: 'tesseract-ocr' }
      : { id: 'screen.ocr', label: 'Read text on screen (OCR)', level: 'observe', status: 'unavailable', detail: 'tesseract is not installed.', requires: 'tesseract-ocr (apt install tesseract-ocr / brew install tesseract)' },
    winTool
      ? { id: 'accessibility', label: 'Inspect windows / accessibility', level: 'observe', status: 'limited', detail: 'Top-level window listing is available. The widget-level accessibility tree (AT-SPI / UI Automation / AX) needs native bindings and is not wired yet.', requires: platform === 'win32' ? 'UI Automation bindings for the full tree' : platform === 'darwin' ? 'AX API for the full tree' : 'AT-SPI bindings for the full tree' }
      : { id: 'accessibility', label: 'Inspect windows / accessibility', level: 'observe', status: 'unavailable', detail: display.headless ? 'No display, so no windows to inspect.' : 'No window tool (wmctrl/xdotool).', requires: 'wmctrl / xdotool (X11)' },
    inputStatus('Move and click the mouse', 'input.mouse', 'interact'),
    inputStatus('Type on the keyboard', 'input.keyboard', 'interact'),
    inputStatus('Switch and manage windows', 'window.manage', 'interact'),
    { id: 'app.manage', label: 'Open and manage apps', level: 'extended', status: 'unavailable', detail: 'Not wired yet (Phase 4).', requires: 'OS process/launch control' },
    { id: 'browser.control', label: 'Drive a browser session', level: 'extended', status: 'unavailable', detail: 'Not wired yet (Phase 4).', requires: 'Playwright/CDP against the user’s browser' },
  ];
  return out;
}

abstract class BaseAdapter implements OsAdapter {
  abstract platform: NodeJS.Platform;
  abstract displayName: string;
  abstract detectDisplay(): DisplayInfo;
  abstract listProcesses(limit: number, signal: AbortSignal): Promise<{ processes: ProcessInfo[]; total: number; available: boolean; detail: string }>;
  abstract activeWindow(signal: AbortSignal): Promise<ActiveWindow>;
  abstract listWindows(signal: AbortSignal): Promise<{ windows: WindowInfo[]; available: boolean; detail: string }>;
  networkCounters(): { rxBytes: number; txBytes: number } | null {
    return null;
  }
  controlCapabilities(display: DisplayInfo): Capability[] {
    return observeCapabilities(this.platform, display);
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
  async listWindows(signal: AbortSignal) {
    const display = this.detectDisplay();
    if (display.headless) return { windows: [], available: false, detail: 'No display server.' };
    if (display.server === 'wayland') return { windows: [], available: false, detail: 'Wayland does not expose the window list to other processes.' };
    try {
      // `wmctrl -lp` → id, desktop, pid, host, title…
      const { stdout } = await run('wmctrl', ['-lp'], signal);
      const windows: WindowInfo[] = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+\S+\s+(.*)$/);
        if (!m) continue;
        windows.push({ id: m[1], desktop: Number(m[2]), pid: Number(m[3]) || null, title: m[4].trim() });
      }
      return { windows, available: true, detail: `${windows.length} window(s) via wmctrl` };
    } catch (err) {
      return { windows: [], available: false, detail: `Needs wmctrl on X11: ${(err as Error).message}` };
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
  async listWindows(signal: AbortSignal) {
    try {
      const script = 'tell application "System Events" to get name of every application process whose visible is true';
      const { stdout } = await run('osascript', ['-e', script], signal);
      const windows: WindowInfo[] = stdout
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name, i) => ({ id: `app:${i}`, title: name, desktop: null, pid: null }));
      return { windows, available: windows.length > 0, detail: windows.length > 0 ? `${windows.length} visible app(s) via osascript (app-level only)` : 'osascript returned nothing (grant Automation permission).' };
    } catch (err) {
      return { windows: [], available: false, detail: `Needs osascript + Automation permission: ${(err as Error).message}` };
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
        if (!Number.isFinite(pid)) continue;
        rows.push({ pid, name: cols[0], cpu: null, memPercent: null });
      }
      return { processes: rows.slice(0, limit), total: rows.length, available: rows.length > 0, detail: rows.length > 0 ? `${rows.length} processes (CPU% needs WMI/PerfCounters)` : 'tasklist returned no rows' };
    } catch (err) {
      return { processes: [], total: 0, available: false, detail: `tasklist unavailable: ${(err as Error).message}` };
    }
  }
  private shell(): string {
    return firstBinary(['powershell', 'pwsh']) ?? 'powershell';
  }
  async activeWindow(signal: AbortSignal): Promise<ActiveWindow> {
    const ps = [
      'Add-Type \'using System;using System.Runtime.InteropServices;using System.Text;public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}\';',
      '$h=[W]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder 512;[void][W]::GetWindowText($h,$sb,512);$p=0;[void][W]::GetWindowThreadProcessId($h,[ref]$p);Write-Output $sb.ToString();Write-Output $p',
    ].join('');
    try {
      const { stdout } = await run(this.shell(), ['-NoProfile', '-NonInteractive', '-Command', ps], signal, 8000);
      const lines = stdout.trim().split('\n');
      const pid = Number(lines.at(-1));
      const title = lines.slice(0, -1).join(' ').trim() || null;
      return { title, app: null, pid: Number.isFinite(pid) ? pid : null, available: title !== null, detail: 'Read via PowerShell + GetForegroundWindow (unverified from cloud).' };
    } catch (err) {
      return { title: null, app: null, pid: null, available: false, detail: `Needs PowerShell: ${(err as Error).message}` };
    }
  }
  async listWindows(signal: AbortSignal) {
    const ps = "Get-Process | Where-Object {$_.MainWindowTitle} | ForEach-Object { \"$($_.Id)`t$($_.MainWindowTitle)\" }";
    try {
      const { stdout } = await run(this.shell(), ['-NoProfile', '-NonInteractive', '-Command', ps], signal, 8000);
      const windows: WindowInfo[] = [];
      for (const line of stdout.split('\n')) {
        const [pid, ...rest] = line.trim().split('\t');
        const title = rest.join(' ').trim();
        if (!title || !Number.isFinite(Number(pid))) continue;
        windows.push({ id: `pid:${pid}`, title, desktop: null, pid: Number(pid) });
      }
      return { windows, available: windows.length > 0, detail: windows.length > 0 ? `${windows.length} window(s) via PowerShell` : 'no titled windows (unverified from cloud)' };
    } catch (err) {
      return { windows: [], available: false, detail: `Needs PowerShell: ${(err as Error).message}` };
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
