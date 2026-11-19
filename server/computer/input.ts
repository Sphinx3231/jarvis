import { platform as osPlatform } from 'node:os';
import { firstBinary, hasBinary, run } from './exec.ts';
import type { DisplayInfo } from './types.ts';

/**
 * Native interaction (Phase 4): move/click the mouse, type, press keys, scroll and switch windows by
 * spawning the platform's input tool — xdotool on Linux/X11 (verified), cliclick/osascript on macOS
 * and PowerShell on Windows (implemented, unverified until probed on that OS). No native node-addons.
 *
 * Every action is consequential: the permission engine gates `computer.control` and never allows it
 * automatically, and the ComputerAccessManager checks the toggle + the "interact" level and threads
 * the STOP signal through, before any of this runs.
 */

export type InputAction =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; button?: 'left' | 'right' | 'middle'; count?: number; x?: number; y?: number; /** What is being clicked (its label) — used for the critical-action check. */ label?: string }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number }
  | { kind: 'activate_window'; title: string }
  | { kind: 'drag'; from: { x: number; y: number }; to: { x: number; y: number }; button?: 'left' | 'right' }
  | { kind: 'mouse_down'; button?: 'left' | 'right' | 'middle'; x?: number; y?: number }
  | { kind: 'mouse_up'; button?: 'left' | 'right' | 'middle'; x?: number; y?: number }
  | { kind: 'window'; op: 'minimize' | 'maximize' | 'restore' | 'resize' | 'move' | 'close'; title: string; width?: number; height?: number; x?: number; y?: number };

export interface InputResult {
  action: string;
  ok: boolean;
  detail: string;
  /** Independent check that the action took effect (e.g. cursor really moved), where cheap. */
  verified?: { ok: boolean; detail: string };
}

/** Which capability an action exercises, for the capability report / probe map. */
export function actionCapability(kind: InputAction['kind']): 'input.mouse' | 'input.keyboard' | 'window.manage' {
  if (kind === 'type' || kind === 'key') return 'input.keyboard';
  if (kind === 'activate_window' || kind === 'window') return 'window.manage';
  return 'input.mouse';
}

export interface InputDriver {
  platform: NodeJS.Platform;
  available(display: DisplayInfo): { available: boolean; reason?: string };
  perform(action: InputAction, signal: AbortSignal): Promise<InputResult>;
}

const VALID_KEYS = /^[A-Za-z0-9+_]{1,40}(\s+[A-Za-z0-9+_]{1,40})*$/;

class XdotoolDriver implements InputDriver {
  platform: NodeJS.Platform = 'linux';
  available(display: DisplayInfo) {
    if (display.headless) return { available: false, reason: 'No display server.' };
    if (display.server === 'wayland') return { available: false, reason: 'Wayland blocks synthetic input to other apps; needs a native/portal path.' };
    if (!hasBinary('xdotool')) return { available: false, reason: 'Needs xdotool (apt install xdotool).' };
    return { available: true };
  }
  async perform(action: InputAction, signal: AbortSignal): Promise<InputResult> {
    switch (action.kind) {
      case 'move': {
        await run('xdotool', ['mousemove', '--sync', String(Math.round(action.x)), String(Math.round(action.y))], signal);
        const loc = await run('xdotool', ['getmouselocation', '--shell'], signal).catch(() => null);
        const x = loc && Number(loc.stdout.match(/^X=(\d+)/m)?.[1]);
        const y = loc && Number(loc.stdout.match(/^Y=(\d+)/m)?.[1]);
        const ok = x === Math.round(action.x) && y === Math.round(action.y);
        return { action: `move ${action.x},${action.y}`, ok: true, detail: `moved to ${action.x},${action.y}`, verified: { ok, detail: `cursor at ${x},${y}` } };
      }
      case 'click': {
        const button = action.button === 'right' ? '3' : action.button === 'middle' ? '2' : '1';
        if (typeof action.x === 'number' && typeof action.y === 'number') await run('xdotool', ['mousemove', '--sync', String(Math.round(action.x)), String(Math.round(action.y))], signal);
        await run('xdotool', ['click', '--repeat', String(Math.min(5, Math.max(1, action.count ?? 1))), button], signal);
        return { action: `click ${action.button ?? 'left'}`, ok: true, detail: `clicked ${action.button ?? 'left'}${action.x !== undefined ? ` at ${action.x},${action.y}` : ''}` };
      }
      case 'type': {
        await run('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--', action.text.slice(0, 2000)], signal, 30000);
        return { action: 'type', ok: true, detail: `typed ${action.text.length} char(s)` };
      }
      case 'key': {
        if (!VALID_KEYS.test(action.keys)) return { action: 'key', ok: false, detail: `rejected key spec ${JSON.stringify(action.keys)}` };
        await run('xdotool', ['key', '--clearmodifiers', ...action.keys.trim().split(/\s+/)], signal);
        return { action: `key ${action.keys}`, ok: true, detail: `pressed ${action.keys}` };
      }
      case 'scroll': {
        const button = action.direction === 'up' ? '4' : action.direction === 'down' ? '5' : action.direction === 'left' ? '6' : '7';
        await run('xdotool', ['click', '--repeat', String(Math.min(50, Math.max(1, action.amount ?? 3))), button], signal);
        return { action: `scroll ${action.direction}`, ok: true, detail: `scrolled ${action.direction}` };
      }
      case 'activate_window': {
        await run('xdotool', ['search', '--name', action.title, 'windowactivate', '--sync'], signal).catch(async () => {
          await run('wmctrl', ['-a', action.title], signal);
        });
        const name = await run('xdotool', ['getactivewindow', 'getwindowname'], signal).catch(() => null);
        const active = name?.stdout.trim() ?? '';
        return { action: `activate "${action.title}"`, ok: true, detail: `activated window matching "${action.title}"`, verified: { ok: active.includes(action.title), detail: `active window: ${active || '(none)'}` } };
      }
      case 'drag': {
        const b = action.button === 'right' ? '3' : '1';
        const r = (n: number) => String(Math.round(n));
        await run('xdotool', ['mousemove', '--sync', r(action.from.x), r(action.from.y), 'mousedown', b], signal);
        // Move in a few steps so drag-and-drop targets see intermediate motion events.
        for (let i = 1; i <= 5; i++) {
          const x = action.from.x + ((action.to.x - action.from.x) * i) / 5;
          const y = action.from.y + ((action.to.y - action.from.y) * i) / 5;
          await run('xdotool', ['mousemove', '--sync', r(x), r(y)], signal);
        }
        await run('xdotool', ['mouseup', b], signal);
        const loc = await run('xdotool', ['getmouselocation', '--shell'], signal).catch(() => null);
        const x = loc && Number(loc.stdout.match(/^X=(\d+)/m)?.[1]);
        const y = loc && Number(loc.stdout.match(/^Y=(\d+)/m)?.[1]);
        return { action: 'drag', ok: true, detail: `dragged ${r(action.from.x)},${r(action.from.y)} → ${r(action.to.x)},${r(action.to.y)}`, verified: { ok: x === Math.round(action.to.x) && y === Math.round(action.to.y), detail: `released at ${x},${y}` } };
      }
      case 'mouse_down':
      case 'mouse_up': {
        const button = action.button === 'right' ? '3' : action.button === 'middle' ? '2' : '1';
        if (typeof action.x === 'number' && typeof action.y === 'number') await run('xdotool', ['mousemove', '--sync', String(Math.round(action.x)), String(Math.round(action.y))], signal);
        await run('xdotool', [action.kind === 'mouse_down' ? 'mousedown' : 'mouseup', button], signal);
        return { action: action.kind, ok: true, detail: `${action.kind === 'mouse_down' ? 'pressed' : 'released'} ${action.button ?? 'left'} button` };
      }
      case 'window': {
        const id = (await run('xdotool', ['search', '--name', action.title], signal).catch(() => null))?.stdout.trim().split(/\s+/)[0];
        if (!id) return { action: `window ${action.op}`, ok: false, detail: `no window matching "${action.title}"` };
        if (action.op === 'minimize') await run('xdotool', ['windowminimize', '--sync', id], signal).catch(() => run('wmctrl', ['-i', '-r', id, '-b', 'add,hidden'], signal));
        else if (action.op === 'maximize') await run('wmctrl', ['-i', '-r', id, '-b', 'add,maximized_vert,maximized_horz'], signal);
        else if (action.op === 'restore') await run('wmctrl', ['-i', '-r', id, '-b', 'remove,maximized_vert,maximized_horz,hidden'], signal).then(() => run('xdotool', ['windowactivate', id], signal).catch(() => undefined));
        else if (action.op === 'resize') await run('xdotool', ['windowsize', '--sync', id, String(Math.round(action.width ?? 800)), String(Math.round(action.height ?? 600))], signal);
        else if (action.op === 'move') await run('xdotool', ['windowmove', '--sync', id, String(Math.round(action.x ?? 0)), String(Math.round(action.y ?? 0))], signal);
        else if (action.op === 'close') await run('wmctrl', ['-i', '-c', id], signal);
        let verified: { ok: boolean; detail: string } | undefined;
        if (action.op === 'resize') {
          const g = await run('xdotool', ['getwindowgeometry', '--shell', id], signal).catch(() => null);
          const w = Number(g?.stdout.match(/^WIDTH=(\d+)/m)?.[1]);
          const h = Number(g?.stdout.match(/^HEIGHT=(\d+)/m)?.[1]);
          // Some windows resize in steps (terminals snap to character cells), so allow a small tolerance
          // and always report the real size.
          const ww = Math.round(action.width ?? 800);
          const wh = Math.round(action.height ?? 600);
          const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(16, b * 0.05);
          verified = { ok: near(w, ww) && near(h, wh), detail: `window is ${w}x${h} (asked ${ww}x${wh})` };
        } else if (action.op === 'close') {
          await new Promise((r) => setTimeout(r, 300));
          const still = (await run('xdotool', ['search', '--name', action.title], signal).catch(() => null))?.stdout.trim();
          verified = { ok: !still?.split(/\s+/).includes(id), detail: still?.split(/\s+/).includes(id) ? 'window still open (it may be asking to save)' : 'window closed' };
        } else if (action.op === 'minimize' || action.op === 'maximize') {
          const st = await run('xprop', ['-id', id, '_NET_WM_STATE'], signal).catch(() => null);
          const want = action.op === 'minimize' ? 'HIDDEN' : 'MAXIMIZED';
          verified = st ? { ok: st.stdout.includes(want), detail: st.stdout.trim().slice(0, 120) } : undefined;
        }
        return { action: `window ${action.op} "${action.title}"`, ok: true, detail: `${action.op} window "${action.title}"`, verified };
      }
    }
  }
}

class MacInputDriver implements InputDriver {
  platform: NodeJS.Platform = 'darwin';
  available() {
    const mouse = hasBinary('cliclick');
    const keyboard = hasBinary('osascript');
    if (!mouse && !keyboard) return { available: false, reason: 'Needs cliclick (mouse) and/or osascript (keyboard) + Accessibility permission.' };
    return { available: true, reason: mouse ? undefined : 'Keyboard only; mouse needs cliclick (brew install cliclick).' };
  }
  private async osa(script: string, signal: AbortSignal) {
    return run('osascript', ['-e', script], signal, 30000);
  }
  async perform(action: InputAction, signal: AbortSignal): Promise<InputResult> {
    // Implemented but NOT verified on real macOS until a probe passes there. macOS requires the
    // Accessibility permission for synthetic input (System Settings → Privacy & Security → Accessibility).
    const r = (n: number) => String(Math.round(n));
    switch (action.kind) {
      case 'type': {
        const esc = action.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 2000);
        await this.osa(`tell application "System Events" to keystroke "${esc}"`, signal);
        return { action: 'type', ok: true, detail: 'typed via osascript' };
      }
      case 'key': {
        if (!VALID_KEYS.test(action.keys)) return { action: 'key', ok: false, detail: `rejected key spec ${JSON.stringify(action.keys)}` };
        const parts = action.keys.trim().split('+');
        const key = parts.pop()!.toLowerCase();
        const mods = parts.map((m) => ({ ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down', cmd: 'command down', super: 'command down', command: 'command down' })[m.toLowerCase()]).filter(Boolean);
        const codes: Record<string, number> = { return: 36, enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, left: 123, right: 124, down: 125, up: 126, pagedown: 121, pageup: 116, home: 115, end: 119, delete: 117 };
        const using = mods.length ? ` using {${mods.join(', ')}}` : '';
        const script = key in codes ? `tell application "System Events" to key code ${codes[key]}${using}` : `tell application "System Events" to keystroke "${key.replace(/"/g, '')}"${using}`;
        await this.osa(script, signal);
        return { action: `key ${action.keys}`, ok: true, detail: `pressed ${action.keys} via osascript` };
      }
      case 'activate_window': {
        await this.osa(`tell application "${action.title.replace(/"/g, '')}" to activate`, signal);
        const front = await this.osa('tell application "System Events" to get name of first application process whose frontmost is true', signal).catch(() => null);
        const name = front?.stdout.trim() ?? '';
        return { action: 'activate', ok: true, detail: `activated "${action.title}"`, verified: { ok: name.toLowerCase().includes(action.title.toLowerCase()), detail: `frontmost: ${name || '(unknown)'}` } };
      }
      case 'window': {
        const app = action.title.replace(/"/g, '');
        const scripts: Record<string, string> = {
          minimize: `tell application "System Events" to set value of attribute "AXMinimized" of window 1 of process "${app}" to true`,
          restore: `tell application "System Events" to set value of attribute "AXMinimized" of window 1 of process "${app}" to false`,
          maximize: `tell application "System Events" to tell process "${app}" to set value of attribute "AXFullScreen" of window 1 to true`,
          resize: `tell application "System Events" to tell process "${app}" to set size of window 1 to {${r(action.width ?? 800)}, ${r(action.height ?? 600)}}`,
          move: `tell application "System Events" to tell process "${app}" to set position of window 1 to {${r(action.x ?? 0)}, ${r(action.y ?? 0)}}`,
          close: `tell application "${app}" to close front window`,
        };
        await this.osa(scripts[action.op], signal);
        return { action: `window ${action.op}`, ok: true, detail: `${action.op} "${app}" via System Events` };
      }
    }
    if (!hasBinary('cliclick')) return { action: action.kind, ok: false, detail: 'mouse actions need cliclick on macOS (brew install cliclick)' };
    let cmd: string[] = [];
    switch (action.kind) {
      case 'move':
        cmd = [`m:${r(action.x)},${r(action.y)}`];
        break;
      case 'click': {
        const at = typeof action.x === 'number' && typeof action.y === 'number' ? `${r(action.x)},${r(action.y)}` : '.';
        const verb = action.button === 'right' ? 'rc' : (action.count ?? 1) >= 2 ? 'dc' : 'c';
        cmd = [`${verb}:${at}`];
        break;
      }
      case 'drag':
        cmd = [`dd:${r(action.from.x)},${r(action.from.y)}`, `m:${r(action.to.x)},${r(action.to.y)}`, `du:${r(action.to.x)},${r(action.to.y)}`];
        break;
      case 'mouse_down':
      case 'mouse_up': {
        const at = typeof action.x === 'number' && typeof action.y === 'number' ? `${r(action.x)},${r(action.y)}` : '.';
        cmd = [`${action.kind === 'mouse_down' ? 'dd' : 'du'}:${at}`];
        break;
      }
      case 'scroll': {
        // cliclick has no wheel; use arrow/page keys via System Events instead.
        const code = action.direction === 'down' ? 121 : action.direction === 'up' ? 116 : action.direction === 'left' ? 123 : 124;
        for (let i = 0; i < Math.min(10, Math.max(1, Math.ceil((action.amount ?? 3) / 3))); i++) await this.osa(`tell application "System Events" to key code ${code}`, signal);
        return { action: `scroll ${action.direction}`, ok: true, detail: `scrolled ${action.direction} with page keys` };
      }
    }
    await run('cliclick', cmd, signal);
    let verified: InputResult['verified'];
    if (action.kind === 'move' || action.kind === 'drag') {
      const p = await run('cliclick', ['p'], signal).catch(() => null);
      const want = action.kind === 'move' ? action : action.to;
      const m = p?.stdout.match(/(\d+),(\d+)/);
      if (m) verified = { ok: Number(m[1]) === Math.round(want.x) && Number(m[2]) === Math.round(want.y), detail: `cursor at ${m[1]},${m[2]}` };
    }
    return { action: action.kind, ok: true, detail: `${action.kind} via cliclick`, verified };
  }
}

/** user32 P/Invoke helpers, compiled once per PowerShell call. */
const WIN_USER32 =
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class JU{[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int x,int y);[DllImport(\"user32.dll\")]public static extern bool GetCursorPos(out POINT p);[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,int dx,int dy,int d,UIntPtr e);[DllImport(\"user32.dll\")]public static extern IntPtr FindWindow(string c,string t);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int n);[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport(\"user32.dll\")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out RECT r);[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int n);[DllImport(\"user32.dll\")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);public struct POINT{public int X;public int Y;}public struct RECT{public int L;public int T;public int R;public int B;}}';";

/** Find a top-level window handle whose title contains $t (case-insensitive). */
const WIN_FIND = "$h=[IntPtr]::Zero;foreach($p in (Get-Process | Where-Object {$_.MainWindowTitle -like ('*'+$t+'*')})){$h=$p.MainWindowHandle;break};";

/** SendKeys syntax for "ctrl+shift+Return"-style chords. */
function sendKeysChord(spec: string): string | null {
  const map: Record<string, string> = { return: '{ENTER}', enter: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', space: ' ', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', page_up: '{PGUP}', pageup: '{PGUP}', page_down: '{PGDN}', pagedown: '{PGDN}', f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f10: '{F10}', f11: '{F11}', f12: '{F12}' };
  const out: string[] = [];
  for (const chord of spec.trim().split(/\s+/)) {
    const parts = chord.split('+');
    const key = parts.pop()!;
    let mods = '';
    for (const m of parts) {
      const k = m.toLowerCase();
      if (k === 'ctrl' || k === 'control') mods += '^';
      else if (k === 'alt') mods += '%';
      else if (k === 'shift') mods += '+';
      else return null; // win/super can't be sent with SendKeys
    }
    const base = map[key.toLowerCase()] ?? (key.length === 1 ? key.replace(/[+^%~(){}[\]]/g, '{$&}').toLowerCase() : null);
    if (!base) return null;
    out.push(mods + base);
  }
  return out.join('');
}

class WindowsInputDriver implements InputDriver {
  platform: NodeJS.Platform = 'win32';
  private shell(): string {
    return firstBinary(['powershell', 'pwsh']) ?? 'powershell';
  }
  available() {
    return firstBinary(['powershell', 'pwsh']) ? { available: true, reason: 'Implemented via PowerShell + user32; unverified until probed on Windows.' } : { available: false, reason: 'Needs PowerShell.' };
  }
  private ps(script: string, signal: AbortSignal, timeoutMs = 20000) {
    return run(this.shell(), ['-NoProfile', '-NonInteractive', '-Command', script], signal, timeoutMs);
  }
  private async cursor(signal: AbortSignal): Promise<{ x: number; y: number } | null> {
    const res = await this.ps(`${WIN_USER32}$p=New-Object JU+POINT;[void][JU]::GetCursorPos([ref]$p);Write-Output "$($p.X),$($p.Y)"`, signal).catch(() => null);
    const m = res?.stdout.match(/(-?\d+),(-?\d+)/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  }
  async perform(action: InputAction, signal: AbortSignal): Promise<InputResult> {
    const r = (n: number) => String(Math.round(n));
    // mouse_event flags
    const DOWN = { left: 0x0002, right: 0x0008, middle: 0x0020 } as const;
    const UP = { left: 0x0004, right: 0x0010, middle: 0x0040 } as const;
    switch (action.kind) {
      case 'type': {
        const esc = action.text.replace(/[+^%~(){}[\]]/g, '{$&}').replace(/'/g, "''").slice(0, 2000);
        await this.ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${esc}')`, signal, 30000);
        return { action: 'type', ok: true, detail: `typed ${action.text.length} char(s) via SendKeys` };
      }
      case 'key': {
        if (!VALID_KEYS.test(action.keys)) return { action: 'key', ok: false, detail: `rejected key spec ${JSON.stringify(action.keys)}` };
        const chord = sendKeysChord(action.keys);
        if (!chord) return { action: 'key', ok: false, detail: `"${action.keys}" can't be sent with SendKeys` };
        await this.ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${chord.replace(/'/g, "''")}')`, signal);
        return { action: `key ${action.keys}`, ok: true, detail: `pressed ${action.keys}` };
      }
      case 'move': {
        await this.ps(`${WIN_USER32}[void][JU]::SetCursorPos(${r(action.x)},${r(action.y)})`, signal);
        const at = await this.cursor(signal);
        return { action: `move ${r(action.x)},${r(action.y)}`, ok: true, detail: `moved to ${r(action.x)},${r(action.y)}`, verified: at ? { ok: at.x === Math.round(action.x) && at.y === Math.round(action.y), detail: `cursor at ${at.x},${at.y}` } : undefined };
      }
      case 'click': {
        const b = action.button ?? 'left';
        const pos = typeof action.x === 'number' && typeof action.y === 'number' ? `[void][JU]::SetCursorPos(${r(action.x)},${r(action.y)});` : '';
        const n = Math.min(5, Math.max(1, action.count ?? 1));
        await this.ps(`${WIN_USER32}${pos}for($i=0;$i -lt ${n};$i++){[JU]::mouse_event(${DOWN[b]},0,0,0,[UIntPtr]::Zero);[JU]::mouse_event(${UP[b]},0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 40}`, signal);
        return { action: `click ${b}`, ok: true, detail: `clicked ${b}${pos ? ` at ${r(action.x!)},${r(action.y!)}` : ''}` };
      }
      case 'mouse_down':
      case 'mouse_up': {
        const b = action.button ?? 'left';
        const pos = typeof action.x === 'number' && typeof action.y === 'number' ? `[void][JU]::SetCursorPos(${r(action.x)},${r(action.y)});` : '';
        await this.ps(`${WIN_USER32}${pos}[JU]::mouse_event(${action.kind === 'mouse_down' ? DOWN[b] : UP[b]},0,0,0,[UIntPtr]::Zero)`, signal);
        return { action: action.kind, ok: true, detail: `${action.kind === 'mouse_down' ? 'pressed' : 'released'} ${b}` };
      }
      case 'drag': {
        const b = action.button ?? 'left';
        const steps = [1, 2, 3, 4, 5].map((i) => `[void][JU]::SetCursorPos(${r(action.from.x + ((action.to.x - action.from.x) * i) / 5)},${r(action.from.y + ((action.to.y - action.from.y) * i) / 5)});Start-Sleep -Milliseconds 30;`).join('');
        await this.ps(`${WIN_USER32}[void][JU]::SetCursorPos(${r(action.from.x)},${r(action.from.y)});[JU]::mouse_event(${DOWN[b]},0,0,0,[UIntPtr]::Zero);${steps}[JU]::mouse_event(${UP[b]},0,0,0,[UIntPtr]::Zero)`, signal);
        const at = await this.cursor(signal);
        return { action: 'drag', ok: true, detail: `dragged to ${r(action.to.x)},${r(action.to.y)}`, verified: at ? { ok: at.x === Math.round(action.to.x) && at.y === Math.round(action.to.y), detail: `released at ${at.x},${at.y}` } : undefined };
      }
      case 'scroll': {
        const amount = Math.min(50, Math.max(1, action.amount ?? 3));
        const vertical = action.direction === 'up' || action.direction === 'down';
        const delta = (action.direction === 'down' || action.direction === 'left' ? -120 : 120) * amount;
        await this.ps(`${WIN_USER32}[JU]::mouse_event(${vertical ? '0x0800' : '0x1000'},0,0,${delta},[UIntPtr]::Zero)`, signal);
        return { action: `scroll ${action.direction}`, ok: true, detail: `scrolled ${action.direction}` };
      }
      case 'activate_window': {
        const t = action.title.replace(/'/g, "''");
        const res = await this.ps(`${WIN_USER32}$t='${t}';${WIN_FIND}if($h -ne [IntPtr]::Zero){[void][JU]::ShowWindow($h,9);[void][JU]::SetForegroundWindow($h)};Start-Sleep -Milliseconds 200;$f=[JU]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder 512;[void][JU]::GetWindowText($f,$sb,512);Write-Output $sb.ToString()`, signal);
        const active = res.stdout.trim();
        return { action: `activate "${action.title}"`, ok: true, detail: `activated window matching "${action.title}"`, verified: { ok: active.toLowerCase().includes(action.title.toLowerCase()), detail: `active window: ${active || '(none)'}` } };
      }
      case 'window': {
        const t = action.title.replace(/'/g, "''");
        const ops: Record<string, string> = {
          minimize: '[void][JU]::ShowWindow($h,6)',
          maximize: '[void][JU]::ShowWindow($h,3)',
          restore: '[void][JU]::ShowWindow($h,9)',
          resize: `$rc=New-Object JU+RECT;[void][JU]::GetWindowRect($h,[ref]$rc);[void][JU]::MoveWindow($h,$rc.L,$rc.T,${r(action.width ?? 800)},${r(action.height ?? 600)},$true)`,
          move: `$rc=New-Object JU+RECT;[void][JU]::GetWindowRect($h,[ref]$rc);[void][JU]::MoveWindow($h,${r(action.x ?? 0)},${r(action.y ?? 0)},$rc.R-$rc.L,$rc.B-$rc.T,$true)`,
          close: '[void][JU]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)',
        };
        const res = await this.ps(`${WIN_USER32}$t='${t}';${WIN_FIND}if($h -eq [IntPtr]::Zero){Write-Output 'NOWINDOW';exit};${ops[action.op]};Start-Sleep -Milliseconds 300;$rc=New-Object JU+RECT;[void][JU]::GetWindowRect($h,[ref]$rc);Write-Output "$($rc.R-$rc.L)x$($rc.B-$rc.T)"`, signal);
        if (res.stdout.includes('NOWINDOW')) return { action: `window ${action.op}`, ok: false, detail: `no window matching "${action.title}"` };
        const size = res.stdout.trim();
        const verified = action.op === 'resize' ? { ok: size === `${r(action.width ?? 800)}x${r(action.height ?? 600)}`, detail: `window is ${size}` } : undefined;
        return { action: `window ${action.op} "${action.title}"`, ok: true, detail: `${action.op} window "${action.title}"`, verified };
      }
    }
  }
}

export function currentInputDriver(platform: NodeJS.Platform = osPlatform()): InputDriver {
  switch (platform) {
    case 'win32':
      return new WindowsInputDriver();
    case 'darwin':
      return new MacInputDriver();
    default:
      return new XdotoolDriver();
  }
}
