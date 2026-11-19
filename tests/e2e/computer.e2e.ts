/**
 * End-to-end UI test for Computer Access Mode: a real Jarvis service, the built UI in Chromium, and a
 * second real (headless) Chromium that Jarvis operates over its DevTools port.
 *
 *   npm run build && node tests/e2e/computer.e2e.ts
 *
 * Proves the user stays in control from the UI: the top-bar indicator shows OFF → ON/state; a critical
 * action (clicking "Send message") is held and appears in the panel; "Allow once" lets exactly that
 * action run; STOP aborts and turns Computer Access off. Screenshots go to test-results/.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startJarvis } from '../../server/main.ts';
import { launchBrowser } from '../../server/computer/browser.ts';
import { tempDir } from '../helpers.ts';
import { findChromium, freePort } from '../_browser.ts';
import { startSite } from '../fixtures/computer-site.ts';

const require = createRequire(import.meta.url);
let playwright: typeof import('playwright');
try {
  playwright = require('playwright');
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}
const chromium = findChromium();
if (!chromium) {
  console.log('  - skipped: no Chromium-family browser for Jarvis to operate');
  process.exit(0);
}

const outDir = process.env.E2E_SCREENSHOTS ?? join(process.cwd(), 'test-results');
mkdirSync(outDir, { recursive: true });
const dir = tempDir('jarvis-e2e-ca-');
mkdirSync(join(dir, 'Roamies.app'), { recursive: true });
process.env.JARVIS_ROAMIES_PATH = join(dir, 'Roamies.app');
const site = await startSite();
const port = await freePort();
const args = ['--headless=new', '--disable-gpu'];
if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
const target = launchBrowser({ binary: chromium, profileDir: mkdtempSync(join(tmpdir(), 'jarvis-e2e-prof-')), port, extraArgs: args, url: `${site.url}/app` });
for (let i = 0; i < 200 && !(await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 150));

const running = await startJarvis({ dataDir: join(dir, 'data'), port: 0, quiet: true });
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${running.url}${path}`, { method, headers: { 'content-type': 'application/json', 'x-jarvis-token': running.token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.E2E_SCALE ?? 1) });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (name: string) => page.screenshot({ path: join(outDir, `${name}.png`) });
const step = (msg: string) => console.log(`  ✓ ${msg}`);

try {
  await page.goto(running.url);
  await page.getByText('Online').waitFor();
  const chip = page.locator('.ca__chip');
  await chip.waitFor();
  assert.match((await chip.textContent()) ?? '', /Computer: off/);
  assert.equal(await page.locator('.ca__stop').count(), 0, 'no STOP while off');
  step('top bar shows Computer Access OFF');

  // A web page cannot turn it on: there is no unauthenticated route.
  const anon = await fetch(`${running.url}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ computerAccess: { enabled: true } }) });
  assert.equal(anon.status, 401);
  step('an unauthenticated request cannot enable Computer Access');

  await call('PATCH', '/api/settings', { computerAccess: { enabled: true, level: 'interact', browserEndpoint: `http://127.0.0.1:${port}` } });
  await page.getByText('Computer: Idle').waitFor();
  await page.locator('.ca__stop').waitFor();
  step('turning it on shows the live state and a STOP button');

  // Jarvis reads the page (observe) and tries a critical click.
  const read = await call('POST', '/api/computer/browser', { op: 'read' });
  assert.equal(read.status, 200);
  const send = await call('POST', '/api/computer/browser', { op: 'click', target: { name: 'Send message' } });
  assert.equal(send.status, 409, JSON.stringify(send.json));
  await page.getByText('Computer: Waiting for approval').waitFor();
  await chip.click();
  await page.locator('.ca__panel').waitFor();
  await page.getByText('Needs your confirmation', { exact: true }).waitFor();
  assert.match((await page.locator('.ca__confirm').textContent()) ?? '', /Send message/);
  await shot('ca-01-confirmation-pending');
  step('a critical click is held and shown in the panel');

  await page.getByRole('button', { name: 'Allow once' }).click();
  await page.locator('.ca__confirm').waitFor({ state: 'detached' });
  const sent = await call('POST', '/api/computer/browser', { op: 'click', target: { name: 'Send message' }, expectText: 'message sent' });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  await page.locator('.ca__log-item.is-ok', { hasText: 'browser.click' }).first().waitFor();
  await shot('ca-02-panel-after-action');
  step('“Allow once” lets exactly that action run; it shows in the action log');

  await page.locator('.ca__foot .btn--danger').click();
  await page.getByText('Computer: off').waitFor();
  const after = await call('POST', '/api/computer/browser', { op: 'read' });
  assert.equal(after.status, 400, 'nothing runs after STOP');
  await shot('ca-03-stopped');
  step('STOP aborts and turns Computer Access off; further actions are refused');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('Computer Access e2e passed.');
} finally {
  await browser.close();
  await running.stop();
  try {
    if (target.pid) process.kill(target.pid);
  } catch {
    /* gone */
  }
  await site.close();
}
process.exit(0);
