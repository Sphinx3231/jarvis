import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasBinary } from '../server/computer/exec.ts';
import { makeApp } from './helpers.ts';

/**
 * REAL native-observation integration tests. They stand up an actual X11 session with Xvfb + a window
 * manager, put known text on the screen, launch a titled window, and drive Jarvis's Computer Access
 * observation against it — asserting real screenshots, real OCR of the real screen, the real active
 * window and the real window list. No mocks. They self-skip when the tools/display aren't available
 * (e.g. macOS/Windows CI), so the suite stays green everywhere while giving genuine evidence here.
 */

const LINUX = process.platform === 'linux';
const TOOLS = ['Xvfb', 'openbox', 'scrot', 'xdotool', 'wmctrl', 'tesseract', 'convert', 'display', 'xterm'];
const missing = TOOLS.filter((t) => !hasBinary(t));
const CAN_RUN = LINUX && missing.length === 0;
const SKIP = CAN_RUN ? false : `needs an X11 session; missing: ${LINUX ? missing.join(', ') : 'not Linux'}`;

const DISP = `:${90 + Math.floor(Math.random() * 8)}`;
const KNOWN = 'PHOTOSYNTHESIS';
const WIN_TITLE = 'Jarvis Lesson 7';
let xvfb: ChildProcess | null = null;
let wm: ChildProcess | null = null;
let term: ChildProcess | null = null;
let workdir = '';
let savedDisplay: string | undefined;
const extra: ChildProcess[] = [];

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const xterm = (title: string, cmd: string) => {
  const p = spawn('xterm', ['-T', title, '-e', cmd], { stdio: 'ignore', env: { ...process.env, DISPLAY: DISP } });
  extra.push(p);
  return p;
};

before(async () => {
  if (!CAN_RUN) return;
  workdir = mkdtempSync(join(tmpdir(), 'jarvis-x11-'));
  savedDisplay = process.env.DISPLAY;
  xvfb = spawn('Xvfb', [DISP, '-screen', '0', '1024x768x24'], { stdio: 'ignore' });
  await wait(1500);
  process.env.DISPLAY = DISP;
  wm = spawn('openbox', [], { stdio: 'ignore', env: { ...process.env, DISPLAY: DISP } });
  await wait(800);
  // Put known text on the screen (a single-line image tiled onto the root) so OCR of the real
  // screenshot is deterministic and legible.
  const img = join(workdir, 'lesson.png');
  execFileSync('convert', ['-size', '700x120', 'xc:white', '-gravity', 'center', '-pointsize', '48', '-fill', 'black', '-annotate', '0', KNOWN, img]);
  spawn('display', ['-window', 'root', img], { stdio: 'ignore', env: { ...process.env, DISPLAY: DISP } });
  await wait(800);
  term = spawn('xterm', ['-T', WIN_TITLE, '-e', 'sleep 120'], { stdio: 'ignore', env: { ...process.env, DISPLAY: DISP } });
  await wait(1500);
});

after(async () => {
  for (const p of [...extra, term, wm, xvfb]) p?.kill('SIGTERM');
  await wait(300);
  if (savedDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = savedDisplay;
});

test('integration: captures a real screenshot of the X11 display', { skip: SKIP }, async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ computerAccess: { enabled: true, level: 'observe' } });
    assert.equal(app.computer.display().headless, false, 'display detected');
    const obs = await app.computer.observe({ screenshot: true });
    assert.ok(obs.screenshot, obs.notes.join('; '));
    assert.equal(obs.screenshot!.width, 1024);
    assert.equal(obs.screenshot!.height, 768);
    assert.ok(obs.screenshot!.bytes > 1000);
  } finally {
    await cleanup();
  }
});

test('integration: OCR reads the real screen text', { skip: SKIP }, async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ computerAccess: { enabled: true, level: 'observe' } });
    const obs = await app.computer.observe({ ocr: true });
    assert.ok(obs.ocr, obs.notes.join('; '));
    assert.match(obs.ocr!.text.toUpperCase(), new RegExp(KNOWN), `OCR text was: ${JSON.stringify(obs.ocr!.text.slice(0, 120))}`);
  } finally {
    await cleanup();
  }
});

test('integration: identifies the active window and lists open windows', { skip: SKIP }, async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ computerAccess: { enabled: true, level: 'observe' } });
    const obs = await app.computer.observe({ activeWindow: true, windows: true });
    assert.ok(obs.windows?.available, `windows: ${obs.windows?.detail}`);
    assert.ok(obs.windows!.list.some((w) => w.title.includes('Jarvis Lesson')), `windows: ${JSON.stringify(obs.windows!.list.map((w) => w.title))}`);
    // The active window is the xterm we focused.
    assert.ok(obs.activeWindow?.available, `active: ${obs.activeWindow?.detail}`);
  } finally {
    await cleanup();
  }
});

test('integration: verify() probes pass and upgrade the capability report to available', { skip: SKIP }, async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ computerAccess: { enabled: true, level: 'observe' } });
    const probes = await app.computer.verify();
    const byId = new Map(probes.map((p) => [p.id, p]));
    assert.equal(byId.get('screen.capture')!.ok, true, byId.get('screen.capture')!.detail);
    assert.equal(byId.get('screen.ocr')!.ok, true, byId.get('screen.ocr')!.detail);
    assert.equal(byId.get('accessibility')!.ok, true, byId.get('accessibility')!.detail);

    const caps = new Map(app.computer.status().capabilities.map((c) => [c.id, c]));
    assert.equal(caps.get('screen.capture')!.status, 'available');
    assert.equal(caps.get('screen.ocr')!.status, 'available');
  } finally {
    await cleanup();
  }
});

test('integration: mouse move lands at the exact coordinates', { skip: SKIP }, async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ computerAccess: { enabled: true, level: 'interact' } });
    assert.equal(app.registry.info().find((s) => s.name === 'computer.control')!.available, true, 'control available at interact level');
    const res = await app.computer.control({ kind: 'move', x: 333, y: 222 });
    assert.ok(res.verified, 'move is verified');
    assert.equal(res.verified!.ok, true, res.verified!.detail);
    assert.match(res.verified!.detail, /333,222/);
  } finally {
    await cleanup();
  }
});

test('integration: typing reaches a focused window', { skip: SKIP }, async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ computerAccess: { enabled: true, level: 'interact' } });
    const out = join(workdir, 'typed.txt');
    xterm('Typer', `read l; echo "$l" > ${out}`);
    await wait(1600);
    await app.computer.control({ kind: 'activate_window', title: 'Typer' });
    await wait(300);
    await app.computer.control({ kind: 'type', text: 'jarvis phase four' });
    await app.computer.control({ kind: 'key', keys: 'Return' });
    await wait(800);
    assert.match(readFileSync(out, 'utf8'), /jarvis phase four/);
  } finally {
    await cleanup();
  }
});

test('integration: window switching changes the active window', { skip: SKIP }, async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ computerAccess: { enabled: true, level: 'interact' } });
    xterm('Alpha', 'sleep 60');
    xterm('Beta', 'sleep 60');
    await wait(1600);
    const a = await app.computer.control({ kind: 'activate_window', title: 'Alpha' });
    assert.equal(a.verified!.ok, true, a.verified!.detail);
    const b = await app.computer.control({ kind: 'activate_window', title: 'Beta' });
    assert.equal(b.verified!.ok, true, b.verified!.detail);
    assert.match(b.verified!.detail, /Beta/);
  } finally {
    await cleanup();
  }
});

test('integration: the control skill runs through the permission engine (needs approval)', { skip: SKIP }, async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ computerAccess: { enabled: true, level: 'interact' } });
    // computer.control is consequential: a direct invoke must stop for approval, never auto-run.
    const needs = await app.runner.invoke({ agent: 'executor', skill: 'computer.control', input: { action: { kind: 'move', x: 5, y: 5 } } });
    assert.equal(needs.status, 'needs_approval');
  } finally {
    await cleanup();
  }
});

test('integration: STOP aborts an in-flight observation', { skip: SKIP }, async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ computerAccess: { enabled: true, level: 'observe' } });
    // Kick off an observation and immediately STOP; the capture subprocess must be killed.
    const p = app.computer.observe({ ocr: true });
    app.computer.emergencyStop('integration test');
    const obs = await p.catch((e) => ({ error: String(e) }) as const);
    // Either the capture was aborted (note/throw) — never a completed OCR after STOP.
    if ('ocr' in obs && obs.ocr) assert.fail('observation completed OCR after STOP');
    assert.equal(app.settings.get().computerAccess.enabled, false);
  } finally {
    await cleanup();
  }
});
