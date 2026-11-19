import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasBinary, clearBinaryCache } from '../server/computer/exec.ts';
import { ConfirmationRequired } from '../server/computer/manager.ts';
import { slug } from '../server/computer/learning.ts';
import { makeApp } from './helpers.ts';
import { findChromium, freePort } from './_browser.ts';
import { COURSE_NAME, startSite, type Site } from './fixtures/computer-site.ts';

/**
 * REAL operating-system computer-control tests (Linux/X11).
 *
 * A real X server (Xvfb) + window manager (openbox) + a real, HEADED Chromium window showing the
 * local test app. Jarvis then uses the computer the way a person does: it SEES the screen (screenshot
 * + OCR), FINDS a button by its visible text, MOVES the real mouse and CLICKS it (xdotool → X server →
 * Chromium), TYPES with the real keyboard, SCROLLS with the real wheel, SWITCHES/RESIZES windows, and
 * VERIFIES each result by looking again. A DevTools read of the page is used only as an independent
 * cross-check of what the OS-level input did — never to perform it.
 *
 * Self-skips where there is no X11 toolchain or browser (macOS/Windows CI run their own probes).
 */

const LINUX = process.platform === 'linux';
const TOOLS = ['Xvfb', 'openbox', 'scrot', 'xdotool', 'wmctrl', 'tesseract', 'xterm'];
const missing = TOOLS.filter((t) => !hasBinary(t));
const CHROMIUM = findChromium();
const CAN_RUN = LINUX && missing.length === 0 && Boolean(CHROMIUM);
const SKIP = CAN_RUN ? false : `needs X11 tools + a browser; missing: ${[...missing, ...(CHROMIUM ? [] : ['chromium'])].join(', ') || 'not Linux'}`;

const DISP = `:${110 + Math.floor(Math.random() * 20)}`;
let site: Site;
let port = 0;
let profile = '';
const procs: ChildProcess[] = [];
let savedDisplay: string | undefined;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

before(async () => {
  if (!CAN_RUN) return;
  savedDisplay = process.env.DISPLAY;
  procs.push(spawn('Xvfb', [DISP, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' }));
  await wait(1200);
  process.env.DISPLAY = DISP;
  clearBinaryCache();
  procs.push(spawn('openbox', [], { stdio: 'ignore', env: { ...process.env, DISPLAY: DISP } }));
  await wait(700);
  site = await startSite();
  port = await freePort();
  profile = mkdtempSync(join(tmpdir(), 'jarvis-os-profile-'));
  const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--force-device-scale-factor=1', '--window-position=0,0', '--window-size=1280,900', `--app=${site.url}/app`];
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  procs.push(spawn(CHROMIUM!, args, { stdio: 'ignore', env: { ...process.env, DISPLAY: DISP } }));
  for (let i = 0; i < 80; i++) {
    if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false)) break;
    await wait(150);
  }
  await wait(1500); // first paint
});

after(async () => {
  for (const p of procs.reverse()) p.kill('SIGTERM');
  await site?.close();
  await wait(400);
  if (profile) rmSync(profile, { recursive: true, force: true });
  if (savedDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = savedDisplay;
});

async function osApp(level: 'observe' | 'interact' | 'extended' = 'interact') {
  const ctx = await makeApp();
  ctx.app.settings.update({ computerAccess: { enabled: true, level, browserEndpoint: `http://127.0.0.1:${port}` } });
  return ctx;
}

/** Independent cross-check of the page state (NOT used to act). */
async function pageText(app: Awaited<ReturnType<typeof makeApp>>['app']): Promise<string> {
  const r = await app.computer.browserOp({ op: 'read' });
  return 'page' in r ? r.page.text : '';
}

async function focusBrowser(app: Awaited<ReturnType<typeof makeApp>>['app']) {
  await app.computer.control({ kind: 'activate_window', title: 'Jarvis Test App' });
  await wait(300);
}

test('os: Jarvis sees the real screen — the browser window, its title and its text', { skip: SKIP, timeout: 60_000 }, async () => {
  const { app, cleanup } = await osApp('observe');
  try {
    const o = await app.computer.observe({ ocr: true, activeWindow: true, windows: true });
    assert.ok(o.screenshot && o.screenshot.width === 1280 && o.screenshot.height === 900, JSON.stringify(o.screenshot));
    assert.match(o.ocr!.text, /Jarvis Test App/, o.ocr!.text.slice(0, 300));
    assert.match(o.ocr!.text, /Say Hello/);
    assert.ok(o.windows!.list.some((w) => /Jarvis Test App/.test(w.title)), JSON.stringify(o.windows!.list));
    // The on-screen injection paragraph is flagged as data, not followed.
    assert.ok(o.notes.some((n) => /tries to give instructions/.test(n)), o.notes.join(' | '));
    const found = await app.computer.findOnScreen('Say Hello');
    assert.ok(found.matches.length > 0, 'button located by OCR');
  } finally {
    await cleanup();
  }
});

test('os: finds a button by its text on screen, clicks it with the real mouse, verifies by looking again', { skip: SKIP, timeout: 90_000 }, async () => {
  const { app, cleanup } = await osApp();
  try {
    await focusBrowser(app);
    const r = await app.computer.clickText('Say Hello', { expectText: 'hello clicked' });
    assert.equal(r.verified.ok, true, r.verified.detail);
    // Independent cross-check: the page really changed because of the X11 click.
    assert.match(await pageText(app), /Status: hello clicked/);
    assert.ok(app.computer.actions.recent(10).some((a) => a.kind === 'input.click' && a.outcome === 'ok'));
    assert.equal(app.computer.status().capabilities.find((c) => c.id === 'input.mouse')!.status, 'available');
  } finally {
    await cleanup();
  }
});

test('os: types with the real keyboard into the field it clicked, then submits with Enter', { skip: SKIP, timeout: 90_000 }, async () => {
  const { app, cleanup } = await osApp();
  try {
    await focusBrowser(app);
    // Clicking the label focuses its input (like a person would).
    await app.computer.clickText('Full name');
    await app.computer.control({ kind: 'key', keys: 'ctrl+a' });
    const t = await app.computer.control({ kind: 'type', text: 'Linus Torvalds' });
    assert.equal(t.ok, true);
    // Cross-check: the real field holds what the real keyboard typed.
    const read = await app.computer.browserOp({ op: 'read' });
    assert.ok('page' in read);
    assert.equal(read.page.elements.find((e) => e.name === 'Full name')!.value, 'Linus Torvalds');
    await app.computer.control({ kind: 'key', keys: 'Return' });
    await wait(500);
    assert.match(await pageText(app), /Status: submitted Linus Torvalds/);
    // And Jarvis can confirm it on screen too.
    const seen = await app.computer.findOnScreen('submitted');
    assert.ok(seen.matches.length > 0, 'submission visible on screen');
  } finally {
    await cleanup();
  }
});

test('os: scrolls with the real mouse wheel and reaches content below the fold', { skip: SKIP, timeout: 90_000 }, async () => {
  const { app, cleanup } = await osApp();
  try {
    await focusBrowser(app);
    await app.computer.control({ kind: 'move', x: 640, y: 450 });
    const before = await app.computer.findOnScreen('Bottom Button');
    assert.equal(before.matches.length, 0, 'not visible before scrolling');
    for (let i = 0; i < 6; i++) await app.computer.control({ kind: 'scroll', direction: 'down', amount: 10 });
    await wait(500);
    const r = await app.computer.clickText('Bottom Button', { expectText: 'bottom reached' }).catch((e: Error) => ({ verified: { ok: false, detail: e.message } }));
    // "Status:" sits at the top of the page, so verify via the page as well.
    assert.match(await pageText(app), /Status: bottom reached/, JSON.stringify(r.verified));
  } finally {
    await cleanup();
  }
});

test('os: switches between real windows, resizes one, and drag lands where intended', { skip: SKIP, timeout: 90_000 }, async () => {
  const { app, cleanup } = await osApp();
  const term = spawn('xterm', ['-T', 'Notes Window', '-geometry', '60x10+700+500', '-e', 'sleep 60'], { stdio: 'ignore', env: { ...process.env, DISPLAY: DISP } });
  try {
    await wait(1200);
    let r = await app.computer.control({ kind: 'activate_window', title: 'Notes Window' });
    assert.equal(r.verified?.ok, true, r.verified?.detail);
    r = await app.computer.control({ kind: 'activate_window', title: 'Jarvis Test App' });
    assert.equal(r.verified?.ok, true, r.verified?.detail);
    r = await app.computer.control({ kind: 'window', op: 'resize', title: 'Notes Window', width: 500, height: 300 });
    assert.equal(r.verified?.ok, true, r.verified?.detail);
    r = await app.computer.control({ kind: 'drag', from: { x: 100, y: 100 }, to: { x: 300, y: 250 } });
    assert.equal(r.verified?.ok, true, r.verified?.detail);
  } finally {
    term.kill();
    await cleanup();
  }
});

test('os: a critical on-screen click waits for confirmation; off/STOP prevent any further input', { skip: SKIP, timeout: 90_000 }, async () => {
  const { app, cleanup } = await osApp();
  try {
    await focusBrowser(app);
    await app.computer.browserOp({ op: 'navigate', url: `${site.url}/app` });
    await wait(500);
    await assert.rejects(() => app.computer.clickText('Send message'), (e: unknown) => e instanceof ConfirmationRequired);
    assert.doesNotMatch(await pageText(app), /message sent/, 'nothing was sent');
    // Off → refused.
    app.settings.update({ computerAccess: { enabled: false } });
    await assert.rejects(() => app.computer.control({ kind: 'move', x: 10, y: 10 }), /off/);
    // On again, then STOP mid-workflow: the click after the wait never happens.
    app.settings.update({ computerAccess: { enabled: true, level: 'interact' } });
    const run = app.workflows.run('stop me', [{ do: 'wait', ms: 2500 }, { do: 'click_text', text: 'Say Hello', expectText: 'hello clicked' }]);
    await wait(600);
    app.computer.emergencyStop('test');
    const res = await run;
    assert.equal(res.status, 'cancelled');
    assert.doesNotMatch(await pageText(app).catch(() => ''), /hello clicked/);
  } finally {
    await cleanup();
  }
});

test('os: learns from what is on the SCREEN (OCR source) when told to watch an app', { skip: SKIP, timeout: 120_000 }, async () => {
  const { app, cleanup } = await osApp();
  try {
    await app.computer.browserOp({ op: 'navigate', url: `${site.url}/course/lesson/1` });
    await focusBrowser(app).catch(() => undefined);
    await app.computer.control({ kind: 'activate_window', title: 'Cell Membrane' }).catch(() => undefined);
    await wait(800);
    const s = await app.watcher.start({ source: 'screen', course: COURSE_NAME, intervalSec: 1, maxMinutes: 1 });
    await wait(4500);
    await app.watcher.stop(s.id);
    const notes = app.learning.notesFor(slug(COURSE_NAME));
    const text = notes.map((n) => n.content).join('\n');
    // OCR of the real screen yields real, attributed definitions from the visible lesson.
    assert.match(text, /phospholipid bilayer/i, text);
    assert.ok(notes.every((n) => n.source.includes('session=')), 'attributed to the session');
  } finally {
    await cleanup();
  }
});
