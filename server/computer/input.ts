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
  | { kind: 'click'; button?: 'left' | 'right' | 'middle'; count?: number; x?: number; y?: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number }
  | { kind: 'activate_window'; title: string };

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
  if (kind === 'activate_window') return 'window.manage';
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
  async perform(action: InputAction, signal: AbortSignal): Promise<InputResult> {
    // Implemented but NOT verified on real macOS — these paths report ok based on the tool exiting 0.
    if (action.kind === 'type') {
      const esc = action.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 2000);
      await run('osascript', ['-e', `tell application "System Events" to keystroke "${esc}"`], signal, 30000);
      return { action: 'type', ok: true, detail: 'typed via osascript (unverified on macOS)' };
    }
    if (action.kind === 'activate_window') {
      await run('osascript', ['-e', `tell application "${action.title.replace(/"/g, '')}" to activate`], signal).catch(() => {});
      return { action: 'activate', ok: true, detail: 'activate via osascript (unverified)' };
    }
    if (!hasBinary('cliclick')) return { action: action.kind, ok: false, detail: 'mouse needs cliclick on macOS' };
    const cmd = action.kind === 'move' && 'x' in action ? ['m:' + Math.round(action.x) + ',' + Math.round(action.y)] : action.kind === 'click' ? ['c:.'] : [];
    if (!cmd.length) return { action: action.kind, ok: false, detail: `${action.kind} not implemented on macOS yet` };
    await run('cliclick', cmd, signal);
    return { action: action.kind, ok: true, detail: `${action.kind} via cliclick (unverified)` };
  }
}

class WindowsInputDriver implements InputDriver {
  platform: NodeJS.Platform = 'win32';
  private shell(): string {
    return firstBinary(['powershell', 'pwsh']) ?? 'powershell';
  }
  available() {
    return firstBinary(['powershell', 'pwsh']) ? { available: true, reason: 'Implemented via PowerShell; unverified until probed on Windows.' } : { available: false, reason: 'Needs PowerShell.' };
  }
  async perform(action: InputAction, signal: AbortSignal): Promise<InputResult> {
    // Implemented but NOT verified on real Windows.
    if (action.kind === 'type') {
      const esc = action.text.replace(/[+^%~(){}]/g, '{$&}').replace(/"/g, '`"').slice(0, 2000);
      await run(this.shell(), ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait("${esc}")`], signal, 30000);
      return { action: 'type', ok: true, detail: 'typed via SendKeys (unverified on Windows)' };
    }
    if (action.kind === 'move') {
      await run(this.shell(), ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${Math.round(action.x)},${Math.round(action.y)})`], signal);
      return { action: 'move', ok: true, detail: 'moved via System.Windows.Forms (unverified on Windows)' };
    }
    return { action: action.kind, ok: false, detail: `${action.kind} not implemented on Windows yet` };
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
