import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from './helpers.ts';

test('full access: off → sandboxed and asks; on → whole disk and shell with no approval', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'jarvis-outside-'));
  const secretFile = join(outside, 'secret.txt');
  writeFileSync(secretFile, 'top secret');
  const { app, cleanup } = await makeApp();
  try {
    // --- Default: the sandbox and approvals hold. ---
    const readDenied = await app.runner.invoke({ agent: 'jarvis', skill: 'files.read', input: { path: secretFile } });
    assert.equal(readDenied.status, 'failed');
    assert.match(readDenied.error ?? '', /outside the Jarvis workspace/);

    const shellAsk = await app.runner.invoke({ agent: 'executor', skill: 'shell.run', input: { command: 'echo locked' } });
    assert.equal(shellAsk.status, 'needs_approval', 'shell asks for approval by default');

    // --- Full access ON. ---
    app.settings.update({ permissions: { fullAccess: true } });
    assert.ok(app.insights().some((i) => i.id === 'full-access'), 'an insight warns that full access is on');

    // Reads anywhere on disk.
    const read = await app.runner.invoke({ agent: 'jarvis', skill: 'files.read', input: { path: secretFile } });
    assert.equal(read.status, 'ok', read.status === 'ok' ? '' : JSON.stringify(read));
    assert.match(read.description, /top secret/);

    // Runs shell with no approval.
    const shell = await app.runner.invoke({ agent: 'executor', skill: 'shell.run', input: { command: 'echo full-access-works' } });
    assert.equal(shell.status, 'ok', shell.status === 'ok' ? '' : JSON.stringify(shell));
    assert.match(shell.description, /full-access-works/);

    // --- Back off: the sandbox returns. ---
    app.settings.update({ permissions: { fullAccess: false } });
    const readAgain = await app.runner.invoke({ agent: 'jarvis', skill: 'files.read', input: { path: secretFile } });
    assert.equal(readAgain.status, 'failed');
    assert.match(readAgain.error ?? '', /outside the Jarvis workspace/);
  } finally {
    await cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});
