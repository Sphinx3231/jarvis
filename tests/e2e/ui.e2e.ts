/**
 * End-to-end UI test: starts a real Jarvis service on a temporary data directory, drives the
 * built UI in Chromium, and saves a screenshot of every page.
 *
 *   npm run build && npm run test:e2e
 *
 * Requires Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startJarvis } from '../../server/main.ts';
import { HACKERONE_SECRET } from '../../server/integrations/hackerone.ts';
import { tempDir } from '../helpers.ts';

const require = createRequire(import.meta.url);
let playwright: typeof import('playwright');
try {
  playwright = require('playwright');
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const outDir = process.env.E2E_SCREENSHOTS ?? join(process.cwd(), 'test-results');
mkdirSync(outDir, { recursive: true });
const dir = tempDir('jarvis-e2e-');
let h1: ReturnType<typeof createServer> | null = null;
// Start without Roamies: Jarvis must show only the "Roamies required" screen.
const roamiesApp = join(dir, 'Roamies.app');
process.env.JARVIS_ROAMIES_PATH = roamiesApp;
const running = await startJarvis({ dataDir: join(dir, 'data'), port: 0, quiet: true });
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.E2E_SCALE ?? 1) });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const shot = (name: string) => page.screenshot({ path: join(outDir, `${name}.png`) });
const step = (msg: string) => console.log(`  ✓ ${msg}`);

try {
  await page.goto(running.url);
  await page.getByRole('heading', { name: 'Jarvis runs on Roamies' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Download Roamies' }).getAttribute('href'), 'https://github.com/KenKaiii/Roamies/releases/latest');
  assert.equal(await page.locator('.sidebar').count(), 0, 'nothing else is available while Roamies is missing');
  await page.getByRole('link', { name: 'Source code' }).waitFor();
  await shot('00-roamies-required');
  step('without Roamies, only the Roamies-required screen is shown');
  mkdirSync(roamiesApp);
  await page.getByRole('button', { name: 'Check again' }).click();
  await page.getByText('Online').waitFor();
  step('Check again finds Roamies and opens Jarvis without a restart');
  await page.locator('.core').waitFor();
  // Services have only just started after unlocking: wait for the core to settle.
  await page.locator('.core--idle').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.core--idle').count(), 1);
  assert.match(await page.locator('.hero__title').innerText(), /I’m Jarvis\./);
  // The core is a live inline-SVG vector rig — prove it is actually animating (rotating/pulsing),
  // not a static image: its outer ring transform must change between frames.
  const coreXform = () => page.locator('#c-ringOuter').getAttribute('transform');
  assert.ok(await page.locator('.core__svg #c-core').count(), 'core is inline SVG vector, not an <img>');
  assert.equal(await page.locator('.core img').count(), 0, 'no raster image stands in for the core');
  const a1 = await coreXform();
  await page.waitForTimeout(450);
  const a2 = await coreXform();
  assert.notEqual(a1, a2, 'the idle core animates frame to frame');
  await shot('01-home-idle');
  step('home renders with the core as a live animating vector, service online');

  const input = page.getByLabel('Message Jarvis');
  await input.fill('remember that I prefer dark roast coffee');
  await input.press('Enter');
  await page.getByText("Got it — I'll remember that (saved as preference).").waitFor();
  await page.getByRole('button', { name: /Remembered/ }).waitFor();
  step('conversation: memory saved via natural-language command');

  await input.fill('run `echo hello-from-the-ui`');
  await input.press('Enter');
  await page.getByText(/You asked for it, so it runs without another approval/).first().waitFor();
  await page.locator('.core--success').waitFor({ timeout: 10_000 });
  await shot('02-home-requested');
  step('a command you asked for runs straight away (your request is the approval)');

  // Something nobody asked for still waits for explicit approval, and says why.
  running.app.engine.createTask({ title: 'Housekeeping', origin: 'system', steps: [{ skill: 'shell.run', input: { command: 'echo unrequested' }, description: 'Run housekeeping' }] });
  await page.locator('.approval', { hasText: 'echo unrequested' }).waitFor();
  await page.locator('.approval__reason', { hasText: 'Nobody asked for this task directly' }).waitFor();
  await shot('03-home-approval');
  step('an action nobody asked for waits for approval with the reason');

  await page.locator('.approval').getByRole('button', { name: 'Approve' }).click();
  await page.locator('.core--success').waitFor({ timeout: 10_000 });
  await page.locator('.approval').waitFor({ state: 'detached' });
  step('approving runs it; core shows success from the real completion event');

  await page.getByRole('button', { name: /Task queued: Run: echo hello-from-the-ui/ }).click();
  await page.locator('.task-detail').waitFor();
  await page.getByText('Exit code 0').first().waitFor();
  await page.locator('.result__body', { hasText: 'hello-from-the-ui' }).waitFor();
  await shot('04-task-detail');
  step('task detail shows verified step output and history');

  await page.getByRole('link', { name: 'Tasks' }).click();
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByPlaceholder(/Summarise https/).fill('Stretch reminder');
  await page.getByRole('radio', { name: 'Choose steps myself' }).click();
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('.manual-step select').selectOption('notify.user');
  await page.getByLabel('Step input (JSON)').fill('{"title": "Time to stretch"}');
  await page.locator('.form__row', { hasText: 'When' }).locator('select').selectOption('delay');
  await shot('05-new-task');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByText('Task created').waitFor();
  await page.getByRole('tab', { name: /Scheduled/ }).click();
  await page.locator('.task-row', { hasText: 'Stretch reminder' }).waitFor();
  step('manual task with a delay is created and listed as scheduled');

  await page.getByRole('link', { name: 'Memory' }).click();
  await page.locator('.memory', { hasText: 'I prefer dark roast coffee' }).waitFor();
  await page.getByLabel('Search memories').fill('coffee');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.memory').count(), 1);
  await page.getByLabel('Search memories').fill('');
  await page.waitForTimeout(400);
  await shot('06-memory');
  step('memory page lists and searches memories with provenance');

  await page.getByRole('link', { name: 'Skills' }).click();
  await page.locator('.skill', { hasText: 'shell.run' }).waitFor();
  assert.ok((await page.locator('.skill', { hasText: 'llm.generate' }).innerText()).includes('No model from Roamies'));
  await shot('07-skills');
  step('skills page shows real availability and permissions');

  await page.getByRole('link', { name: 'Integrations' }).click();
  await page.locator('.integration', { hasText: 'No model yet' }).getByText('Not ready').waitFor();
  await page.getByText('Roamies has no AI sign-in yet').first().waitFor();
  await shot('08-integrations');
  step('integrations show the Roamies engine honestly (no sign-in, not ready)');

  await page.getByRole('link', { name: 'Activity' }).click();
  await page.getByRole('tab', { name: /Audit log/ }).click();
  await page.locator('tr', { hasText: 'shell.run' }).first().waitFor();
  await shot('09-activity-audit');
  await page.getByRole('tab', { name: /Background jobs/ }).click();
  await page.locator('.job', { hasText: 'Task monitor' }).waitFor();
  step('activity shows the audit trail and background jobs');

  // Bug-bounty pipeline: a stand-in HackerOne so the dashboard shows real numbers.
  const h1Data = {
    programs: [{ id: 'acme', attributes: { handle: 'acme', name: 'Acme', offers_bounties: true, currency: 'usd' } }],
    reports: [{ id: '1', attributes: { title: 'XSS in login', state: 'resolved', created_at: new Date().toISOString() } }],
    earnings: [{ id: 'e1', attributes: { amount: 1500, currency: 'usd', awarded_at: new Date().toISOString() } }],
  };
  h1 = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const list = path.endsWith('/programs') ? h1Data.programs : path.endsWith('/me/reports') ? h1Data.reports : path.endsWith('/payments/earnings') ? h1Data.earnings : null;
    if (!list) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: list, links: {} }));
  });
  await new Promise<void>((r) => h1.listen(0, '127.0.0.1', () => r()));
  process.env.JARVIS_HACKERONE_API = `http://127.0.0.1:${(h1.address() as { port: number }).port}`;
  running.app.settings.update({ integrations: { hackerone: { enabled: true, username: 'hunter', autoRun: true } } });
  running.app.secrets.set(HACKERONE_SECRET, 'e2e-token-123456');
  await running.app.pipeline.sync();
  h1Data.programs.push({ id: 'globex', attributes: { handle: 'globex', name: 'Globex', offers_bounties: true, currency: 'usd' } });
  await running.app.pipeline.sync();

  await page.getByRole('link', { name: 'Pipeline' }).click();
  await page.getByRole('heading', { name: 'Bug-bounty pipeline' }).waitFor();
  await page.getByText('$1,500').first().waitFor();
  await page.locator('.pl-run').getByText('Running').waitFor();
  await page.locator('.pl-programs', { hasText: 'Globex' }).waitFor();
  await page.locator('.pl-programs__tags', { hasText: 'New' }).first().waitFor();
  await shot('09b-pipeline');
  step('pipeline dashboard shows earnings, reports and a newly discovered program');

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Policy for Run shell commands').waitFor();
  assert.equal(await page.getByLabel('Policy for Run shell commands').locator('option[value="allow"]').isDisabled(), true);
  await page.locator('.field', { hasText: 'Reduce motion' }).locator('.toggle').click();
  await page.getByText('Saved').first().waitFor();
  // The page applies settings when the live update arrives, which can land just after the toast.
  await page.waitForFunction(() => document.documentElement.dataset.reduceMotion === 'true', undefined, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'the app shell never scrolls the document');
  await shot('10-settings');
  step('settings save immediately; shell cannot be auto-allowed');

  // Narrow window check (sidebar collapses, no horizontal scroll).
  await page.setViewportSize({ width: 760, height: 900 });
  await page.getByRole('link', { name: 'Home' }).click();
  await page.locator('.conversation').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'no horizontal overflow at narrow width');
  await shot('11-home-narrow');
  step('responsive layout at narrow width');

  // Reduced motion was turned on above: the core rig must now hold a static pose.
  await page.locator('.core__svg').waitFor();
  const r1 = await page.locator('#c-ringOuter').getAttribute('transform');
  await page.waitForTimeout(450);
  const r2 = await page.locator('#c-ringOuter').getAttribute('transform');
  assert.equal(r1, r2, 'with reduced motion on, the core holds still');
  step('reduced motion freezes the core into a static pose');

  assert.deepEqual(errors, [], `browser errors: ${errors.join(' | ')}`);
  console.log(`\nE2E passed. Screenshots in ${outDir}`);
} finally {
  await browser.close();
  await running.stop();
  h1?.close();
  rmSync(dir, { recursive: true, force: true });
}
