import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The harness stays small so the RAM belongs to the local model. A fresh Jarvis (local brain, default
 * settings) must not load the Roamies engine, the Claude Agent SDK, the mail/calendar libraries or the
 * embedding model, and its whole process must stay well under 250 MB. Measured in a separate process
 * (the test helpers themselves load the Roamies engine for the scripted model).
 */
test('lean harness: a default Jarvis loads nothing heavy and stays small', { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-lean-'));
  const script = join(dir, 'probe.ts');
  writeFileSync(
    script,
    `
const { startJarvis } = await import(${JSON.stringify(new URL('../server/main.ts', import.meta.url).pathname)});
const { roamiesEngineLoaded } = await import(${JSON.stringify(new URL('../server/llm/engine.ts', import.meta.url).pathname)});
const r = await startJarvis({ dataDir: ${JSON.stringify(join(dir, 'data'))}, port: 0, quiet: true });
await new Promise((x) => setTimeout(x, 3000));
const { createRequire } = await import('node:module');
const cache = Object.keys(createRequire(import.meta.url).cache ?? {});
const has = (m) => cache.some((k) => k.includes('node_modules/' + m + '/') || k.includes('node_modules\\\\' + m + '\\\\'));
const out = { rssMB: Math.round(process.memoryUsage().rss / 1048576), roamies: roamiesEngineLoaded(), imapflow: has('imapflow'), nodemailer: has('nodemailer'), tsdav: has('tsdav'), nodeIcal: has('node-ical'), claudeSdk: has('@anthropic-ai'), embeddings: r.app.settings.get().embeddings.enabled, brain: r.app.settings.get().brain.backend };
await r.stop();
console.log('LEAN ' + JSON.stringify(out));
process.exit(0);
`,
  );
  try {
    const env = { ...process.env, JARVIS_ROAMIES_PATH: join(dir, 'none'), JARVIS_BRAIN: '', JARVIS_VAULT_DIR: join(dir, 'vault') };
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script], { env, encoding: 'utf8', timeout: 90_000 });
    const r = JSON.parse(out.split('\n').find((l) => l.startsWith('LEAN '))!.slice(5));
    assert.equal(r.brain, 'openjarvis');
    assert.equal(r.roamies, false, 'Roamies engine not loaded');
    assert.equal(r.claudeSdk, false, 'Claude Agent SDK not loaded');
    assert.equal(r.imapflow || r.nodemailer, false, 'mail libraries not loaded');
    assert.equal(r.tsdav || r.nodeIcal, false, 'calendar libraries not loaded');
    assert.equal(r.embeddings, false, 'embedding model off by default');
    assert.ok(r.rssMB < 250, `harness RSS ${r.rssMB} MB`);
    console.log(`  harness RSS: ${r.rssMB} MB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
