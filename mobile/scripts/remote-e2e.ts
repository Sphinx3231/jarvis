/**
 * Cross-language end-to-end test: the Kotlin Android client (JVM) ↔ the real relay ↔ the real PC
 * Jarvis. Starts a relay and a Jarvis with Jarvis Mobile on, shows a pairing link, runs the Kotlin
 * RemoteEndToEndTest through Gradle, then verifies on the PC what really happened.
 *
 *   node mobile/scripts/remote-e2e.ts            (from the repo root; needs the Android SDK)
 *   JARVIS_E2E_RELAY=wss://your-relay/v1 node …  use a deployed relay instead of a local one
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startRelay } from '../../relay/relay.ts';

process.env.JARVIS_BRAIN ??= 'roamies';
process.env.OLLAMA_HOST = '127.0.0.1:1';
const dir = mkdtempSync(join(tmpdir(), 'jarvis-mobile-e2e-'));
process.env.JARVIS_VAULT_DIR = join(dir, 'vault');
process.env.JARVIS_ROAMIES_PATH = join(dir, 'Roamies.app');
const { mkdirSync } = await import('node:fs');
mkdirSync(process.env.JARVIS_ROAMIES_PATH, { recursive: true });
const { JarvisApp } = await import('../../server/app.ts');

const external = process.env.JARVIS_E2E_RELAY;
const relay = external ? null : await startRelay({ host: '127.0.0.1' });
const relayUrl = external ?? relay!.url;
const app = new JarvisApp({ dataDir: join(dir, 'data'), quiet: true });
app.settings.update({ background: { enabled: false }, embeddings: { enabled: false }, integrations: { obsidian: { enabled: false } } });
await app.start();
app.settings.update({ mobile: { enabled: true, relayUrl } });
const until = async (fn: () => boolean, ms: number, what: string) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
let code = 1;
try {
  await until(() => app.mobile.status().state === 'connected', 10_000, 'PC connected to the relay');
  const { uri } = app.mobile.startPairing();
  console.log(`relay ${relayUrl}\npairing link ready`);
  // When the phone pairs, create something nobody asked for: it must wait for approval.
  const watcher = setInterval(() => {
    if (app.mobile.devices().some((d) => d.online) && !app.tasks.list({ limit: 50 }).some((t) => t.title === 'Kotlin approval check')) {
      app.engine.createTask({ title: 'Kotlin approval check', origin: 'system', steps: [{ skill: 'shell.run', input: { command: 'echo from-kotlin' }, description: 'Approval check' }] });
    }
  }, 300);
  const gradle = spawn(join(import.meta.dirname, '..', 'android', 'gradlew'), ['-q', ':app:testDebugUnitTest', '--tests', 'ai.jarvis.mobile.RemoteEndToEndTest', '--rerun-tasks', '--console=plain'], {
    cwd: join(import.meta.dirname, '..', 'android'),
    env: { ...process.env, JARVIS_E2E_PAIRING: uri },
    stdio: 'inherit',
  });
  const gradleCode: number = await new Promise((r) => gradle.on('exit', (c) => r(c ?? 1)));
  clearInterval(watcher);
  if (gradleCode !== 0) console.error('PC-side mobile audit (newest first):\n' + app.mobile.auditLog().slice(0, 15).map((a) => `  ${a.type} → ${a.outcome}${a.detail ? ` (${a.detail})` : ''}`).join('\n'));
  assert.equal(gradleCode, 0, 'the Kotlin end-to-end test failed');

  // Verify on the PC side.
  const dev = app.mobile.devices();
  assert.equal(dev.length, 1, 'exactly one phone paired');
  assert.equal(dev[0].name, 'Kotlin E2E phone');
  const mem = app.memory.list({ limit: 100 }).map((m) => m.content);
  assert.equal(mem.filter((m) => /Kotlin phone test works/i.test(m)).length, 1, 'the typed command ran once (the redelivery did not re-run it)');
  assert.equal(mem.filter((m) => /voice from the phone arrives/i.test(m)).length, 1, 'the voice command ran once');
  const audit = app.mobile.auditLog(200);
  assert.ok(audit.some((a) => a.type === 'jarvis.command.submit' && a.outcome === 'deduplicated'), 'the duplicate was recognised');
  assert.ok(audit.some((a) => a.type === 'approval.resolve' && a.outcome === 'approved'), 'approved from the phone');
  assert.ok(audit.some((a) => a.type === 'system.emergency_stop' && a.outcome === 'stopped'), 'emergency stop reached the PC');
  assert.equal(app.tasks.list({ limit: 50 }).find((t) => t.title === 'Kotlin approval check')?.status, 'completed');
  assert.equal(mem.filter((m) => /pairing survives an app restart/i.test(m)).length, 1, 'the reopened app reconnected from its stored pairing and its command ran');
  console.log('\nREMOTE E2E PASSED: Kotlin client ↔ relay ↔ PC Jarvis (pairing, command, voice, dedupe, approval, emergency stop, app restart without re-pairing)');
  code = 0;
} catch (err) {
  console.error('\nREMOTE E2E FAILED:', (err as Error).message);
} finally {
  await app.stop();
  await relay?.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
