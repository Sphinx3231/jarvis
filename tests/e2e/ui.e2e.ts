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
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startJarvis } from '../../server/main.ts';
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
const running = await startJarvis({ dataDir: dir, port: 0, quiet: true });
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.E2E_SCALE ?? 1) });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const shot = (name: string) => page.screenshot({ path: join(outDir, `${name}.png`) });
const step = (msg: string) => console.log(`  ✓ ${msg}`);

try {
  await page.goto(running.url);
  await page.getByText('Online').waitFor();
  await page.locator('.dragon').waitFor();
  assert.equal(await page.locator('.dragon--idle').count(), 1);
  assert.match(await page.locator('.hero__title').innerText(), /I’m Jarvis\./);
  await shot('01-home-idle');
  step('home renders with the dragon idle and the service online');

  const input = page.getByLabel('Message Jarvis');
  await input.fill('remember that I prefer dark roast coffee');
  await input.press('Enter');
  await page.getByText("Got it — I'll remember that (saved as preference).").waitFor();
  await page.getByRole('button', { name: /Remembered/ }).waitFor();
  step('conversation: memory saved via natural-language command');

  await input.fill('run `echo hello-from-the-ui`');
  await input.press('Enter');
  await page.getByText(/needs your approval/).first().waitFor();
  await page.locator('.approval').waitFor();
  await shot('02-home-approval');
  step('consequential command waits for approval on the dashboard');

  await page.locator('.approval').getByRole('button', { name: 'Approve' }).click();
  await page.locator('.dragon--success').waitFor({ timeout: 10_000 });
  await shot('03-home-success');
  step('approval runs the task; dragon shows success from the real completion event');

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
  assert.ok((await page.locator('.skill', { hasText: 'llm.generate' }).innerText()).includes('No model provider configured'));
  await shot('07-skills');
  step('skills page shows real availability and permissions');

  await page.getByRole('link', { name: 'Integrations' }).click();
  await page.locator('.integration', { hasText: 'Anthropic Claude' }).getByText('API key missing').waitFor();
  await shot('08-integrations');
  step('integrations never show a disconnected provider as connected');

  await page.getByRole('link', { name: 'Activity' }).click();
  await page.getByRole('tab', { name: /Audit log/ }).click();
  await page.locator('tr', { hasText: 'shell.run' }).first().waitFor();
  await shot('09-activity-audit');
  await page.getByRole('tab', { name: /Background jobs/ }).click();
  await page.locator('.job', { hasText: 'Task monitor' }).waitFor();
  step('activity shows the audit trail and background jobs');

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Policy for Run shell commands').waitFor();
  assert.equal(await page.getByLabel('Policy for Run shell commands').locator('option[value="allow"]').isDisabled(), true);
  await page.locator('.field', { hasText: 'Reduce motion' }).locator('.toggle').click();
  await page.getByText('Saved').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.reduceMotion), 'true');
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

  assert.deepEqual(errors, [], `browser errors: ${errors.join(' | ')}`);
  console.log(`\nE2E passed. Screenshots in ${outDir}`);
} finally {
  await browser.close();
  await running.stop();
  rmSync(dir, { recursive: true, force: true });
}
