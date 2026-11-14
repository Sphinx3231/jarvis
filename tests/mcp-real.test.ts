import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { makeApp, tempDir, waitFor } from './helpers.ts';
import type { JarvisApp } from '../server/app.ts';

/** Integration tests against the official MCP reference servers (installed as dev dependencies). */
const require = createRequire(import.meta.url);
const serverPath = (pkg: string) => join(dirname(require.resolve(`${pkg}/package.json`)), 'dist', 'index.js');

async function runApproved(app: JarvisApp, skill: string, input: Record<string, unknown>) {
  const { task } = app.engine.createTask({ title: skill, origin: 'user', steps: [{ skill, input, description: skill }] });
  await waitFor(() => app.tasks.get(task.id)!.status === 'awaiting_approval', 10_000);
  app.permissions.decideApproval(app.permissions.listApprovals('pending').find((a) => a.taskId === task.id)!.id, 'approve');
  return waitFor(() => {
    const t = app.tasks.get(task.id)!;
    return t.status === 'completed' || t.status === 'failed' ? t : null;
  }, 15_000);
}

test('mcp (real): official filesystem server — read-only and write tools through approvals', async () => {
  const { app, cleanup } = await makeApp();
  const shared = tempDir('mcp-fs-');
  writeFileSync(join(shared, 'notes.md'), '# Notes\nWater the plants.\n');
  try {
    app.settings.update({ integrations: { mcpServers: [{ id: 'files', name: 'Filesystem', command: process.execPath, args: [serverPath('@modelcontextprotocol/server-filesystem'), shared], env: {}, secretEnv: [], enabled: true }] } });
    await app.mcp.sync();
    const status = app.mcp.status()[0];
    assert.equal(status.state, 'connected', status.error ?? '');
    assert.equal(status.serverInfo.name, 'secure-filesystem-server');
    const read = app.registry.get('mcp.files.read_text_file')!;
    const write = app.registry.get('mcp.files.write_file')!;
    assert.equal(read.risk, 'read', 'readOnlyHint respected');
    assert.equal(write.risk, 'consequential');
    assert.equal(write.idempotent, false, 'writes are never auto-repeated');

    const listed = await runApproved(app, 'mcp.files.list_directory', { path: shared });
    assert.equal(listed.status, 'completed', listed.error ?? '');
    assert.match(listed.plan![0].outputText!, /notes\.md/);

    const written = await runApproved(app, 'mcp.files.write_file', { path: join(shared, 'todo.md'), content: 'Buy dragon food' });
    assert.equal(written.status, 'completed', written.error ?? '');
    assert.equal(readFileSync(join(shared, 'todo.md'), 'utf8'), 'Buy dragon food');

    const outside = await runApproved(app, 'mcp.files.read_text_file', { path: '/etc/hostname' });
    assert.equal(outside.status, 'failed', 'server-side errors are reported as failures, not successes');
    assert.match(outside.error!, /Tool reported an error|denied|outside/i);
  } finally {
    await cleanup();
  }
});

test('mcp (real): official reference server — notifications, progress and structured results', async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({
      integrations: { mcpServers: [{ id: 'ref', name: 'Reference', command: process.execPath, args: [serverPath('@modelcontextprotocol/server-everything'), 'stdio'], env: {}, secretEnv: [], enabled: true }] },
      permissions: { policies: { 'mcp.ref': 'allow' } },
    });
    await app.mcp.sync();
    assert.equal(app.mcp.status()[0].state, 'connected', app.mcp.status()[0].error ?? '');
    const tools = app.mcp.status()[0].tools.map((t) => t.name);
    assert.ok(!tools.includes('trigger-sampling-request'), 'capabilities Jarvis does not offer are not negotiated');

    // Server pushes log notifications at us while we keep working.
    const logging = await app.runner.invoke({ agent: 'executor', skill: 'mcp.ref.toggle-simulated-logging', input: {} });
    assert.equal(logging.status, 'ok');
    const echo = await app.runner.invoke({ agent: 'executor', skill: 'mcp.ref.echo', input: { message: 'dragon' } });
    assert.equal(echo.status, 'ok');
    assert.equal((echo as { description: string }).description, 'Echo: dragon');

    const sum = await app.runner.invoke({ agent: 'researcher', skill: 'mcp.ref.get-sum', input: { a: 19, b: 23 } });
    assert.match((sum as { description: string }).description, /42/);

    const long = await app.runner.invoke({ agent: 'researcher', skill: 'mcp.ref.trigger-long-running-operation', input: { duration: 1, steps: 3 } });
    assert.equal(long.status, 'ok', long.status === 'failed' ? long.error : '');

    const bad = await app.runner.invoke({ agent: 'researcher', skill: 'mcp.ref.get-sum', input: { a: 'x' } });
    assert.equal(bad.status, 'failed', 'invalid arguments surface as a failure');
    assert.equal(app.mcp.status()[0].state, 'connected', 'connection survives errors');
  } finally {
    await cleanup();
  }
});
