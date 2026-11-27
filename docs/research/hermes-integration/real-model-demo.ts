// REAL end-to-end demonstration: the Jarvis UI → Jarvis task engine → Hermes Agent (installed by
// scripts/install-hermes.sh) → Jarvis skills under the permission engine, thinking with a real local
// model (Qwen3-1.7B on llama.cpp, 64K context). No scripted model anywhere.
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const S = '/tmp/claude-0/-home-user-jarvis/10474f38-014b-56ff-bf5b-6cb07ea4a0e9/scratchpad';
const out = join(S, 'demo', 'shots');
mkdirSync(out, { recursive: true });
const gg = mkdtempSync(join(tmpdir(), 'demo-gg-'));
process.env.JARVIS_BRAIN = 'roamies';
process.env.JARVIS_GG_DIR = gg;
process.env.JARVIS_ROAMIES_PATH = join(gg, 'Roamies.app');
mkdirSync(process.env.JARVIS_ROAMIES_PATH);
process.env.JARVIS_VAULT_DIR = join(gg, 'vault');
writeFileSync(join(gg, 'sidekick.json'), JSON.stringify({ provider: 'local', model: 'local/server-127-0-0-1-8090/qwen3-1.7b', look: 'jarvis' }));
const { startJarvis } = await import('/home/user/jarvis/server/main.ts');
const dataDir = join(S, 'jarvis-data');
const running = await startJarvis({ dataDir, port: 0, quiet: true });
const app = running.app;
app.settings.update({ llm: { localServers: ['http://127.0.0.1:8090/v1'] }, harness: { contextLength: 0 }, embeddings: { enabled: false } });
await app.llm.refresh(true);
const first = await app.harness.status();
console.log('CONTEXT as Jarvis reads it from the server:', first.contextWindow, first.contextSource, first.reason ?? '');
app.memory.add({ kind: 'preference', content: 'The user takes their coffee as a dark roast, black, no sugar.', source: 'user', verified: true });
const status = await app.harness.status();
console.log('HARNESS', JSON.stringify(status));

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
await page.goto(running.url);
await page.locator('.jv').waitFor();
await page.waitForTimeout(2500);
await page.screenshot({ path: join(out, '1-jarvis-view.png') });

// Submit the task through the Jarvis interface (Tasks → New task, described in plain words).
await page.getByRole('button', { name: 'Show the full interface (backslash)' }).click();
await page.getByRole('link', { name: 'Tasks' }).first().click();
await page.getByRole('button', { name: 'New task' }).click();
await page.getByPlaceholder(/Summarise https/).fill('Find how I take my coffee in your memory and save it to coffee.txt');
await page.getByRole('button', { name: 'Create task' }).click();
await page.getByText('Task created', { exact: true }).waitFor();
const t0 = Date.now();
const task = () => app.tasks.list({ limit: 1 })[0];
console.log('TASK', task().id, task().harness);

// Back to Jarvis-only while it works.
await page.keyboard.press('Backslash');
let shotWorking = false;
let approved = false;
while (Date.now() - t0 < 15 * 60_000) {
  const t = task();
  if (!shotWorking && app.engine.harnessActivity().length) {
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, '2-hermes-working.png') });
    shotWorking = true;
  }
  if (t.status === 'awaiting_approval' && !approved) {
    await page.locator('.jv__approval').waitFor();
    await page.screenshot({ path: join(out, '3-approval-needed.png') });
    await page.locator('.jv__approval').click();
    await page.locator('.approval').first().waitFor();
    await page.screenshot({ path: join(out, '4-approval-card.png') });
    await page.getByRole('button', { name: 'Approve' }).first().click();
    approved = true;
    console.log('APPROVED in the UI after', Math.round((Date.now() - t0) / 1000), 's');
  }
  if (['completed', 'failed', 'cancelled', 'paused'].includes(t.status)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const final = task();
console.log('FINAL', final.status, Math.round((Date.now() - t0) / 1000) + 's', JSON.stringify(final.result), final.error);
for (const st of final.plan ?? []) console.log('STEP', st.skill, st.status, JSON.stringify(st.input).slice(0, 160), '|', (st.verification ?? st.error ?? '').slice(0, 120));
for (const e of app.tasks.events(final.id)) console.log('EVENT', e.type, '-', e.message.slice(0, 160));
const file = join(app.workspaceDir(), 'coffee.txt');
console.log('FILE', existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8')) : '(not written)');
await page.goto(`${running.url}/#/tasks/${final.id}`).catch(() => {});
if (!(await page.locator('.sidebar').count())) await page.keyboard.press('Backslash');
await page.getByRole('link', { name: 'Tasks' }).first().click().catch(() => {});
await page.locator('.task-row').first().click().catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, '5-task-detail.png'), fullPage: false });
console.log('PAGE ERRORS', errors);
await browser.close();
await running.stop();
process.exit(0);
