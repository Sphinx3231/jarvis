/**
 * End-to-end: the desktop "Jarvis Mobile" card. A real Jarvis service, a real local relay and a
 * test phone (same protocol and crypto as the Android app). Connects to the relay from Settings,
 * shows a pairing code, pairs the phone with the link behind the QR code, checks the device row,
 * and unpairs it. Screenshots go to test-results/.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startJarvis } from '../../server/main.ts';
import { startRelay } from '../../relay/relay.ts';
import { tempDir } from '../helpers.ts';
import { TestPhone, waitUntil } from '../_phone.ts';

const require = createRequire(import.meta.url);
const playwright: typeof import('playwright') = require('playwright');
const outDir = process.env.E2E_SCREENSHOTS ?? join(process.cwd(), 'test-results');
mkdirSync(outDir, { recursive: true });
const dir = tempDir('jarvis-mobile-e2e-');
process.env.JARVIS_ROAMIES_PATH = join(dir, 'Roamies.app');
mkdirSync(process.env.JARVIS_ROAMIES_PATH);

const relay = await startRelay({ host: '127.0.0.1' });
const running = await startJarvis({ dataDir: join(dir, 'data'), port: 0, quiet: true });
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: Number(process.env.E2E_SCALE ?? 1) });
// These checks run in the full interface (Jarvis-only is the default view; see ui.e2e.ts).
await page.addInitScript(() => localStorage.setItem('jarvis.view', 'full'));
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const step = (msg: string) => console.log(`  ✓ ${msg}`);
let ok = false;
try {
  await page.goto(running.url);
  await page.getByRole('link', { name: 'Settings' }).click();
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Jarvis Mobile' }) });
  await card.waitFor();
  await card.getByLabel('Relay URL').fill(relay.url);
  await card.getByLabel('Relay URL').blur();
  await card.locator('.field', { hasText: 'Connect to the relay' }).locator('.toggle').click();
  await card.getByText('connected', { exact: true }).waitFor({ timeout: 10_000 });
  step('connects out to the relay from Settings');

  await card.getByRole('button', { name: 'Pair a phone' }).click();
  await card.getByRole('img', { name: 'Pairing QR code' }).waitFor();
  await card.locator('details', { hasText: 'Can’t scan?' }).locator('summary').click();
  const uri = (await card.locator('.mobile-link').textContent())!.trim();
  assert.match(uri, /^jarvis:\/\/pair\?v=1&/);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(outDir, 'mobile-01-pairing-code.png') });
  step('shows a one-time pairing QR code');

  const phone = new TestPhone();
  await phone.connect(relay.url);
  assert.equal((await phone.pair(uri)).type, 'device.pair.confirm');
  await card.getByText('Paired with Test Pixel').waitFor({ timeout: 10_000 });
  await card.locator('.mobile-device', { hasText: 'Test Pixel' }).getByText('online').waitFor({ timeout: 10_000 });
  assert.equal(await card.getByRole('img', { name: 'Pairing QR code' }).count(), 0, 'the code disappears once used');
  await card.screenshot({ path: join(outDir, 'mobile-02-paired.png') });
  step('the phone pairs with the code; the card shows it online');

  page.once('dialog', (d) => d.accept());
  await card.locator('.mobile-device', { hasText: 'Test Pixel' }).getByRole('button', { name: 'Unpair' }).click();
  await card.getByText('No phones paired.').waitFor();
  await phone.waitFor((e) => e.type === 'device.revoke');
  step('Unpair revokes the phone (it is told, and loses access)');
  assert.deepEqual(errors, []);
  ok = true;
} finally {
  TestPhone.stopAll();
  await browser.close();
  await running.stop();
  await relay.close();
}
console.log(ok ? '\nMOBILE UI E2E PASSED' : '\nMOBILE UI E2E FAILED');
process.exit(ok ? 0 : 1);
