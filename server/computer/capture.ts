import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstBinary, hasBinary, pngSize, run } from './exec.ts';
import type { DisplayInfo, Screenshot } from './types.ts';

/**
 * Screenshot capture by spawning the platform's standard tool — no native node-addons, so nothing
 * needs an ABI rebuild to ship inside Electron, and the same approach works in the forked server
 * process. Each platform writes a PNG to a temp file we then read; the capability is only ever
 * reported usable when the tool is actually present (and, at runtime, after a real capture succeeds).
 */

export interface CaptureTool {
  id: string;
  /** Build the argv that writes a PNG to `out`. */
  argv(out: string, region: 'screen' | 'active'): { cmd: string; args: string[] };
  /** How the user installs it, for the honest capability report. */
  install: string;
}

/** The best capture tool available for this platform + display, or null if none is usable here. */
export function detectCaptureTool(platform: NodeJS.Platform, display: DisplayInfo): CaptureTool | null {
  if (platform === 'win32') {
    const sh = firstBinary(['powershell', 'pwsh']);
    if (!sh) return null;
    return {
      id: sh,
      install: 'built into Windows',
      argv: (out) => ({ cmd: sh, args: ['-NoProfile', '-NonInteractive', '-Command', windowsCaptureScript(out)] }),
    };
  }
  if (platform === 'darwin') {
    // Full screen only: -W / -l window selection is interactive or needs a window id, so we never
    // hang the capture waiting for a click; active-window cropping is a Phase-4 concern.
    return {
      id: 'screencapture',
      install: 'built into macOS (needs Screen Recording permission)',
      argv: (out) => ({ cmd: 'screencapture', args: ['-x', out] }),
    };
  }
  // Linux / other unix.
  if (display.headless) return null;
  if (display.server === 'wayland') {
    if (hasBinary('grim')) return { id: 'grim', install: 'apt install grim (wlroots compositors)', argv: (out) => ({ cmd: 'grim', args: [out] }) };
    if (hasBinary('gnome-screenshot')) return { id: 'gnome-screenshot', install: 'apt install gnome-screenshot', argv: (out) => ({ cmd: 'gnome-screenshot', args: ['-f', out] }) };
    return null;
  }
  // X11.
  if (hasBinary('scrot')) return { id: 'scrot', install: 'apt install scrot', argv: (out, region) => ({ cmd: 'scrot', args: region === 'active' ? ['-u', '-o', out] : ['-o', out] }) };
  if (hasBinary('maim')) return { id: 'maim', install: 'apt install maim', argv: (out) => ({ cmd: 'maim', args: [out] }) };
  if (hasBinary('import')) return { id: 'import', install: 'apt install imagemagick', argv: (out) => ({ cmd: 'import', args: ['-window', 'root', out] }) };
  if (hasBinary('gnome-screenshot')) return { id: 'gnome-screenshot', install: 'apt install gnome-screenshot', argv: (out) => ({ cmd: 'gnome-screenshot', args: ['-f', out] }) };
  return null;
}

function windowsCaptureScript(out: string): string {
  const path = out.replace(/'/g, "''");
  return [
    "$ErrorActionPreference='Stop';",
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;',
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;',
    '$g=[System.Drawing.Graphics]::FromImage($bmp);',
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);',
    `$bmp.Save('${path}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    '$g.Dispose();$bmp.Dispose();',
  ].join('');
}

export interface CaptureOptions {
  tool: CaptureTool;
  signal: AbortSignal;
  region?: 'screen' | 'active';
  /** Directory for the temp PNG (defaults to the OS temp dir). */
  dir?: string;
  /** When true, delete the file after reading its size and return path:null (retention 0). */
  deleteAfter?: boolean;
}

/** Capture the screen (or active window) to a PNG and return its metadata. Throws on failure — honestly. */
export async function captureScreen(opts: CaptureOptions): Promise<Screenshot> {
  const region = opts.region ?? 'screen';
  const out = join(opts.dir ?? tmpdir(), `jarvis-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  const { cmd, args } = opts.tool.argv(out, region);
  const res = await run(cmd, args, opts.signal, 15000);
  let buf: Buffer;
  try {
    buf = await readFile(out);
  } catch {
    throw new Error(`${opts.tool.id} produced no image${res.stderr ? `: ${res.stderr.trim().slice(0, 200)}` : ` (exit ${res.code})`}`);
  }
  const size = pngSize(buf);
  if (!size) {
    await unlink(out).catch(() => {});
    throw new Error(`${opts.tool.id} output was not a PNG`);
  }
  const shot: Screenshot = { path: out, width: size.width, height: size.height, bytes: buf.length, tool: opts.tool.id, capturedAt: Date.now() };
  if (opts.deleteAfter) {
    await unlink(out).catch(() => {});
    shot.path = null;
  }
  return shot;
}
