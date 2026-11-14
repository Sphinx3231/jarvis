import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, waitFor } from './helpers.ts';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs');

test('mcp: tools are discovered, registered as permission-gated skills, and results verified', async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.secrets.set(app.mcp.secretName('fake', 'FAKE_TOKEN'), 's3cret-token');
    app.settings.update({ integrations: { mcpServers: [{ id: 'fake', name: 'Fake', command: process.execPath, args: [fixture], env: {}, secretEnv: ['FAKE_TOKEN'], enabled: true }] } });
    await app.mcp.sync();
    const status = app.mcp.status()[0];
    assert.equal(status.state, 'connected', status.error ?? '');
    assert.equal(status.serverInfo.name, 'fake-mcp');
    assert.deepEqual(status.tools.map((t) => t.skill), ['mcp.fake.echo', 'mcp.fake.save_note', 'mcp.fake.crash']);
    assert.deepEqual(status.secretEnv, [{ name: 'FAKE_TOKEN', configured: true }]);

    const echo = app.registry.get('mcp.fake.echo')!;
    assert.equal(echo.risk, 'read');
    assert.equal(echo.scope, 'mcp.fake');
    assert.equal(app.permissions.policyFor('mcp.fake'), 'ask', 'MCP tools need approval by default');
    assert.ok(app.permissions.scopes().some((s) => s.id === 'mcp.fake' && s.label === 'MCP: Fake'));

    const { task } = app.engine.createTask({ title: 'Echo', origin: 'user', steps: [{ skill: 'mcp.fake.echo', input: { text: 'hi' }, description: '' }] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'awaiting_approval');
    app.permissions.decideApproval(app.permissions.listApprovals('pending')[0].id, 'approve');
    const done = await waitFor(() => {
      const t = app.tasks.get(task.id)!;
      return t.status === 'completed' ? t : null;
    });
    assert.equal(done.plan![0].outputText, 'echo: hi (token=s3cret-token)', 'secret env reached the server process');
    const audit = app.db.get<{ input: string }>("SELECT input FROM audit_log WHERE skill = 'mcp.fake.echo' AND outcome = 'success'")!;
    assert.ok(!audit.input.includes('s3cret'), 'secrets never logged');

    // A tool-level error is not reported as success.
    app.settings.update({ permissions: { policies: { 'mcp.fake': 'allow' } } });
    const bad = await app.runner.invoke({ agent: 'executor', skill: 'mcp.fake.save_note', input: { note: 'x' } });
    assert.equal(bad.status, 'failed');
    assert.match((bad as { error: string }).error, /storage full/);

    // Server crash: tools are unregistered and the status shows the disconnection.
    await app.runner.invoke({ agent: 'executor', skill: 'mcp.fake.crash', input: {} });
    await waitFor(() => app.mcp.status()[0].state === 'error');
    assert.equal(app.registry.get('mcp.fake.echo'), undefined, 'disconnected tools are not offered');
    await app.mcp.reconnect('fake');
    assert.equal(app.mcp.status()[0].state, 'connected');
  } finally {
    await cleanup();
  }
});

test('mcp: a server that cannot start is reported as an error, never as connected', async () => {
  const { app, cleanup } = await makeApp();
  try {
    app.settings.update({ integrations: { mcpServers: [{ id: 'broken', name: 'Broken', command: '/nonexistent/binary', args: [], env: {}, secretEnv: [], enabled: true }] } });
    await app.mcp.sync();
    const s = app.mcp.status()[0];
    assert.equal(s.state, 'error');
    assert.match(s.error!, /Could not start/);
    assert.ok(app.insights().some((i) => i.id === 'mcp-broken'));
  } finally {
    await cleanup();
  }
});
