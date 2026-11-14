import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultVaultPath, readFrontmatter, safeName } from '../server/integrations/obsidian.ts';
import { startJarvis } from '../server/main.ts';
import { makeApp, tempDir, waitFor } from './helpers.ts';
import type { JarvisApp } from '../server/app.ts';

/** A location for a vault that does not exist yet. */
const newVaultPath = () => join(tempDir('vaults-'), 'Jarvis Vault');

function listAll(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listAll(full, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}

const notes = (vault: string) => listAll(vault).filter((f) => !f.startsWith('.obsidian/') && f !== '.jarvis-vault.json');

function useVault(app: JarvisApp, path: string) {
  app.settings.update({ integrations: { obsidian: { enabled: true, vaultPath: path } } });
}

test('vault: Jarvis creates its own Obsidian vault and keeps everything it learns in it', async () => {
  const v = newVaultPath();
  const { app, cleanup } = await makeApp();
  try {
    app.secrets.set('llm:anthropic:apiKey', 'sk-ant-supersecret-123456');
    app.secrets.set('email:password', 'mail-password-xyz');
    const pref = app.memory.add({ kind: 'preference', content: 'I prefer dark roast coffee', source: 'user', verified: true }).memory;
    app.memory.add({ kind: 'fact', content: 'User probably works from Cairo', source: 'jarvis (inferred)', verified: false, confidence: 0.5 });
    await app.jarvis.handleMessage({ text: 'remember that the demo is on Friday' });
    const { task } = app.engine.createTask({ title: 'Say hello', origin: 'user', steps: [{ skill: 'notify.user', input: { title: 'Hello' }, description: 'Greet' }] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'completed');

    useVault(app, v);
    assert.equal(existsSync(v), false);
    const r = await app.obsidian.sync();
    assert.equal(r.ok, true, r.error ?? '');

    // A real Obsidian vault, created and configured by Jarvis.
    assert.equal(app.obsidian.vaultReady(), true);
    for (const f of ['app.json', 'appearance.json', 'core-plugins.json', 'daily-notes.json', 'graph.json']) assert.ok(existsSync(join(v, '.obsidian', f)), f);
    assert.deepEqual(JSON.parse(readFileSync(join(v, '.obsidian/daily-notes.json'), 'utf8')), { folder: 'Journal', format: 'YYYY-MM-DD' });
    assert.equal(JSON.parse(readFileSync(join(v, '.obsidian/appearance.json'), 'utf8')).accentColor, '#8b5cf6');
    assert.ok(existsSync(join(v, '.jarvis-vault.json')));

    const files = notes(v);
    for (const expected of ['Jarvis.md', 'Manual/Skills.md', 'Manual/Skills/web.fetch.md', 'Manual/Agents.md', 'Manual/Permissions.md', 'Manual/Integrations.md', 'Manual/Background jobs.md', 'Manual/Docs/ARCHITECTURE.md', 'Manual/Docs/README.md', 'Memory/Memory.md', 'Tasks/Task log.md']) {
      assert.ok(files.includes(expected), `${expected} written (have: ${files.join(', ')})`);
    }
    assert.ok(files.some((f) => /^Journal\/\d{4}-\d{2}-\d{2}\.md$/.test(f)), 'daily journal');
    assert.ok(files.some((f) => f.startsWith('Tasks/') && f.includes('Say hello')), 'task note');
    assert.ok(files.some((f) => f.startsWith('Conversations/') && f.includes('remember that the demo')), 'conversations included by default');
    assert.ok(files.some((f) => f.startsWith('Memory/Facts/') && f.includes('the demo is on Friday')), 'what it learned in conversation');

    const prefFile = files.find((f) => f.startsWith('Memory/Preferences/'))!;
    const { fields, body } = readFrontmatter(readFileSync(join(v, prefFile), 'utf8'));
    assert.equal(fields.jarvis_id, pref.id);
    assert.equal(fields.verified, true);
    assert.match(body.trimStart(), /^I prefer dark roast coffee\n/);
    const index = readFileSync(join(v, 'Memory/Memory.md'), 'utf8');
    assert.match(index, /\[\[Memory\/Preferences\/I prefer dark roast coffee \(\w{6}\)\|I prefer dark roast coffee\]\]/, 'vault-relative wikilinks');
    assert.match(index, /works from Cairo\]\] — \*unverified\*/);
    assert.match(readFileSync(join(v, 'Jarvis.md'), 'utf8'), /\[\[Manual\/Skills\|Skills\]\]/);
    assert.match(readFileSync(join(v, 'Jarvis.md'), 'utf8'), /Jarvis’s own vault/);

    const everything = files.map((f) => readFileSync(join(v, f), 'utf8')).join('\n');
    assert.ok(!everything.includes('supersecret') && !everything.includes('mail-password'), 'no secrets in the vault');

    // Obsidian settings are the user's after creation.
    writeFileSync(join(v, '.obsidian/appearance.json'), '{"theme":"moonstone"}');
    const again = await app.obsidian.sync();
    assert.ok(again.written <= 1, `re-sync is stable (wrote ${again.written})`);
    assert.equal(readFileSync(join(v, '.obsidian/appearance.json'), 'utf8'), '{"theme":"moonstone"}');
  } finally {
    await cleanup();
  }
});

test('vault: refuses to write into a folder that already holds someone else’s notes', async () => {
  const personal = tempDir('personal-vault-');
  mkdirSync(join(personal, '.obsidian'));
  writeFileSync(join(personal, 'Diary.md'), 'private');
  const { app, cleanup } = await makeApp();
  try {
    useVault(app, personal);
    assert.match(app.obsidian.problem()!, /already contains other files/);
    const r = await app.obsidian.sync();
    assert.equal(r.ok, false);
    assert.deepEqual(readdirSync(personal).sort(), ['.obsidian', 'Diary.md'], 'nothing written');
    assert.ok(app.insights().some((i) => i.id === 'obsidian'));

    const empty = tempDir('empty-');
    useVault(app, empty);
    assert.equal(app.obsidian.problem(), null, 'an empty folder is fine');
    assert.equal((await app.obsidian.sync()).ok, true);
    assert.ok(existsSync(join(empty, 'Jarvis.md')));
  } finally {
    await cleanup();
  }
});

test('vault: default location, and the API reverts a refused location', async () => {
  assert.match(defaultVaultPath(), /Jarvis Vault$/);
  const dir = tempDir();
  const s = await startJarvis({ dataDir: dir, port: 0, quiet: true, webDir: dir });
  try {
    // On by default, at JARVIS_VAULT_DIR in tests (~/Documents/Jarvis Vault for real users).
    assert.equal(s.app.settings.get().integrations.obsidian.enabled, true);
    assert.equal(s.app.obsidian.vaultPath(), process.env.JARVIS_VAULT_DIR);
    await waitFor(() => s.app.obsidian.lastReport?.ok, 10_000, 'vault created at start');
    assert.ok(existsSync(join(process.env.JARVIS_VAULT_DIR!, 'Jarvis.md')));

    const personal = tempDir('personal-');
    writeFileSync(join(personal, 'Notes.md'), 'mine');
    const res = await fetch(`${s.url}/api/integrations/obsidian`, {
      method: 'PUT',
      headers: { 'x-jarvis-token': s.token, 'content-type': 'application/json' },
      body: JSON.stringify({ vaultPath: personal }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /already contains other files/);
    assert.equal(s.app.settings.get().integrations.obsidian.vaultPath, '', 'setting reverted');
    const info = (await (await fetch(`${s.url}/api/integrations`, { headers: { 'x-jarvis-token': s.token } })).json()) as { obsidian: { location: string; ready: boolean; openUri: string } };
    assert.equal(info.obsidian.ready, true);
    assert.match(info.obsidian.openUri, /^obsidian:\/\/open\?path=.*Jarvis\.md$/);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vault: memory edits flow back; other edits and the user’s own notes are never touched', async () => {
  const v = newVaultPath();
  const { app, cleanup } = await makeApp();
  try {
    const guess = app.memory.add({ kind: 'fact', content: 'User lives in Berlin', source: 'jarvis (inferred)', verified: false, confidence: 0.4 }).memory;
    const temp = app.memory.add({ kind: 'decision', content: 'Use Postgres for the demo', source: 'user', verified: true }).memory;
    const { task } = app.engine.createTask({ title: 'Ping', origin: 'user', steps: [{ skill: 'system.status', input: {}, description: 'Status' }] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'completed');
    useVault(app, v);
    await app.obsidian.sync();
    const files = notes(v);
    mkdirSync(join(v, 'Inbox'), { recursive: true });
    writeFileSync(join(v, 'Inbox', 'My idea.md'), '# Lamp\nA dragon-shaped lamp.\n');

    const guessFile = join(v, files.find((f) => f.includes('User lives in Berlin'))!);
    writeFileSync(guessFile, readFileSync(guessFile, 'utf8').replace('User lives in Berlin', 'User lives in Cairo').replace('verified: false', 'verified: true'));
    const taskFile = join(v, files.find((f) => f.startsWith('Tasks/') && f.includes('Ping'))!);
    writeFileSync(taskFile, `${readFileSync(taskFile, 'utf8')}\n## My notes\nRan this before the demo.\n`);

    const r = await app.obsidian.sync();
    assert.equal(r.imported, 1);
    assert.equal(app.memory.get(guess.id)!.content, 'User lives in Cairo');
    assert.equal(app.memory.get(guess.id)!.verified, true);
    assert.ok(notes(v).some((f) => f.includes('User lives in Cairo')));
    assert.ok(!existsSync(guessFile), 'old note replaced');
    assert.ok(r.keptUserEdits.some((p) => p.includes('Ping')));
    assert.match(readFileSync(taskFile, 'utf8'), /Ran this before the demo/);

    app.memory.delete(temp.id);
    app.tasks.delete(task.id);
    await app.obsidian.sync();
    assert.ok(!notes(v).some((f) => f.includes('Use Postgres')), 'deleted memory removed');
    assert.ok(existsSync(taskFile), 'edited note kept even after the task was deleted');
    assert.equal(readFileSync(join(v, 'Inbox', 'My idea.md'), 'utf8'), '# Lamp\nA dragon-shaped lamp.\n', 'user’s own note untouched');

    app.settings.update({ permissions: { policies: { 'obsidian.read': 'allow' } } });
    const found = await app.runner.invoke({ agent: 'jarvis', skill: 'obsidian.search', input: { query: 'dragon-shaped' } });
    assert.match((found as { description: string }).description, /\[\[Inbox\/My idea\]\]:2/);
  } finally {
    await cleanup();
  }
});

test('vault: write_note asks first and never overwrites; reading cannot escape the vault', async () => {
  const v = newVaultPath();
  const { app, cleanup } = await makeApp();
  try {
    useVault(app, v);
    await app.obsidian.sync();
    const step = { skill: 'obsidian.write_note', input: { title: 'Meeting: dragon lamp', content: 'Decided on [[Inbox/My idea]]. #meeting', folder: 'Meetings' }, description: 'Write notes' };
    const { task } = app.engine.createTask({ title: 'Notes', origin: 'user', steps: [step] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'awaiting_approval');
    app.permissions.decideApproval(app.permissions.listApprovals('pending')[0].id, 'approve');
    const done = await waitFor(() => {
      const t = app.tasks.get(task.id)!;
      return ['completed', 'failed'].includes(t.status) ? t : null;
    });
    assert.equal(done.status, 'completed', done.error ?? '');
    const note = join(v, 'Notes/Meetings/Meeting dragon lamp.md');
    assert.match(readFileSync(note, 'utf8'), /# Meeting: dragon lamp\n\nDecided on/);
    assert.match(done.plan![0].outputText!, /\[\[Notes\/Meetings\/Meeting dragon lamp\]\]/);

    app.settings.update({ permissions: { policies: { 'obsidian.write': 'allow', 'obsidian.read': 'allow' } } });
    assert.equal((await app.runner.invoke({ agent: 'executor', skill: 'obsidian.write_note', input: step.input })).status, 'ok', 'identical repeat is a no-op');
    const clash = await app.runner.invoke({ agent: 'executor', skill: 'obsidian.write_note', input: { ...step.input, content: 'Different' } });
    assert.match((clash as { error: string }).error, /already exists/);
    await app.obsidian.sync();
    assert.ok(existsSync(note), 'requested notes are never removed by syncs');
    const escape = await app.runner.invoke({ agent: 'jarvis', skill: 'obsidian.read', input: { note: '../../etc/passwd' } });
    assert.equal(escape.status, 'failed');
  } finally {
    await cleanup();
  }
});

test('vault: moving to a new location starts a fresh vault and leaves the old one alone', async () => {
  const first = newVaultPath();
  const second = newVaultPath();
  const { app, cleanup } = await makeApp();
  try {
    app.memory.add({ kind: 'preference', content: 'Use metric units', source: 'user', verified: true });
    useVault(app, first);
    await app.obsidian.sync();
    const before = notes(first).sort();
    useVault(app, second);
    const r = await app.obsidian.sync();
    assert.equal(r.ok, true);
    assert.equal(r.removed, 0);
    assert.deepEqual(notes(first).sort(), before, 'old vault untouched');
    assert.ok(notes(second).some((f) => f.includes('Use metric units')));
  } finally {
    await cleanup();
  }
});

test('vault: new knowledge reaches the vault automatically', async () => {
  const v = newVaultPath();
  const { app, cleanup } = await makeApp();
  try {
    useVault(app, v);
    await app.obsidian.sync();
    app.memory.add({ kind: 'procedure', content: 'Deploy with npm run deploy after tests pass', source: 'user', verified: true });
    await waitFor(() => notes(v).some((f) => f.startsWith('Memory/Procedures/Deploy')), 12_000, 'event-driven sync');
  } finally {
    await cleanup();
  }
});

test('vault: safe file names', () => {
  assert.equal(safeName('Meeting: Q4 / plan?'), 'Meeting Q4 plan');
  assert.equal(safeName('...'), 'Untitled');
  assert.equal(safeName('[[link]] #tag^x'), 'link tag x');
});
