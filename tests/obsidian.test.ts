import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFrontmatter, safeName } from '../server/integrations/obsidian.ts';
import { makeApp, tempDir, waitFor } from './helpers.ts';
import type { JarvisApp } from '../server/app.ts';

function vault(): string {
  const dir = tempDir('vault-');
  mkdirSync(join(dir, '.obsidian'));
  writeFileSync(join(dir, 'Ideas.md'), '# My ideas\nBuild a dragon-shaped lamp.\n');
  return dir;
}

function listAll(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listAll(full, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}

function enable(app: JarvisApp, path: string, include?: Partial<{ conversations: boolean }>) {
  app.settings.update({ integrations: { obsidian: { enabled: true, vaultPath: path, include: { ...app.settings.get().integrations.obsidian.include, ...include } } } });
}

test('obsidian: writes a linked manual, memories, tasks and journal — and nothing else', async () => {
  const v = vault();
  const { app, cleanup } = await makeApp();
  try {
    assert.equal(app.obsidian.problem(), 'Obsidian sync is turned off');
    assert.throws(() => app.settings.update({ integrations: { obsidian: { folder: '../outside' } } }), /plain folder name/);
    app.secrets.set('llm:anthropic:apiKey', 'sk-ant-supersecret-123456');
    app.secrets.set('email:password', 'mail-password-xyz');
    const pref = app.memory.add({ kind: 'preference', content: 'I prefer dark roast coffee', source: 'user', verified: true }).memory;
    app.memory.add({ kind: 'fact', content: 'User probably works from Cairo', source: 'jarvis (inferred)', verified: false, confidence: 0.5 });
    const { task } = app.engine.createTask({ title: 'Say hello', origin: 'user', steps: [{ skill: 'notify.user', input: { title: 'Hello' }, description: 'Greet' }] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'completed');
    enable(app, v);
    assert.equal(app.obsidian.problem(), null);
    assert.equal(app.obsidian.looksLikeVault(), true);

    const r = await app.obsidian.sync();
    assert.equal(r.ok, true, r.error ?? '');
    const files = listAll(join(v, 'Jarvis'));
    for (const expected of ['Jarvis.md', 'Manual/Skills.md', 'Manual/Skills/web.fetch.md', 'Manual/Agents.md', 'Manual/Permissions.md', 'Manual/Integrations.md', 'Manual/Background jobs.md', 'Manual/Docs/ARCHITECTURE.md', 'Manual/Docs/README.md', 'Memory/Memory.md', 'Tasks/Task log.md']) {
      assert.ok(files.includes(expected), `${expected} written (have: ${files.join(', ')})`);
    }
    assert.ok(files.some((f) => /^Journal\/\d{4}-\d{2}-\d{2}\.md$/.test(f)), 'daily journal');
    assert.ok(files.some((f) => f.startsWith('Tasks/') && f.includes('Say hello')), 'task note');
    assert.equal(r.written, files.length);
    assert.equal(readFileSync(join(v, 'Ideas.md'), 'utf8'), '# My ideas\nBuild a dragon-shaped lamp.\n', 'user notes outside the folder untouched');
    assert.deepEqual(readdirSync(v).sort(), ['.obsidian', 'Ideas.md', 'Jarvis']);

    const prefFile = files.find((f) => f.startsWith('Memory/Preferences/'))!;
    const { fields, body } = readFrontmatter(readFileSync(join(v, 'Jarvis', prefFile), 'utf8'));
    assert.equal(fields.jarvis_id, pref.id);
    assert.equal(fields.verified, true);
    assert.equal(fields.kind, 'preference');
    assert.match(body.trimStart(), /^I prefer dark roast coffee\n/);
    const index = readFileSync(join(v, 'Jarvis/Memory/Memory.md'), 'utf8');
    assert.match(index, /\[\[Jarvis\/Memory\/Preferences\/I prefer dark roast coffee \(\w{6}\)\|I prefer dark roast coffee\]\]/, 'wikilinks resolve to vault paths');
    assert.match(index, /works from Cairo\]\] — \*unverified\*/);
    const skill = readFrontmatter(readFileSync(join(v, 'Jarvis/Manual/Skills/shell.run.md'), 'utf8')).fields;
    assert.equal(skill.policy, 'ask');
    assert.equal(skill.repeatable, false);
    assert.match(readFileSync(join(v, 'Jarvis/Jarvis.md'), 'utf8'), /\[\[Jarvis\/Manual\/Skills\|Skills\]\]/);

    const everything = files.map((f) => readFileSync(join(v, 'Jarvis', f), 'utf8')).join('\n');
    assert.ok(!everything.includes('supersecret') && !everything.includes('mail-password'), 'no secrets in the vault');

    const again = await app.obsidian.sync();
    assert.ok(again.written <= 1, `re-sync is stable (wrote ${again.written})`);
    assert.equal(again.removed, 0);
  } finally {
    await cleanup();
  }
});

test('obsidian: memory edits are imported; other user edits are never overwritten; deletions are mirrored', async () => {
  const v = vault();
  const { app, cleanup } = await makeApp();
  try {
    const guess = app.memory.add({ kind: 'fact', content: 'User lives in Berlin', source: 'jarvis (inferred)', verified: false, confidence: 0.4 }).memory;
    const temp = app.memory.add({ kind: 'decision', content: 'Use Postgres for the demo', source: 'user', verified: true }).memory;
    const { task } = app.engine.createTask({ title: 'Ping', origin: 'user', steps: [{ skill: 'system.status', input: {}, description: 'Status' }] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'completed');
    enable(app, v);
    await app.obsidian.sync();
    const base = join(v, 'Jarvis');
    const files = listAll(base);

    // Correct a memory in Obsidian: new text + confirm it.
    const guessFile = join(base, files.find((f) => f.includes('User lives in Berlin'))!);
    writeFileSync(guessFile, readFileSync(guessFile, 'utf8').replace('User lives in Berlin', 'User lives in Cairo').replace('verified: false', 'verified: true'));
    // Annotate a task note.
    const taskFile = join(base, files.find((f) => f.startsWith('Tasks/') && f.includes('Ping'))!);
    writeFileSync(taskFile, `${readFileSync(taskFile, 'utf8')}\n## My notes\nRan this before the demo.\n`);

    const r = await app.obsidian.sync();
    assert.equal(r.imported, 1);
    const corrected = app.memory.get(guess.id)!;
    assert.equal(corrected.content, 'User lives in Cairo');
    assert.equal(corrected.verified, true);
    assert.ok(corrected.sources.includes('user (edited)'));
    assert.ok(files.length && listAll(base).some((f) => f.includes('User lives in Cairo')), 'note regenerated under its new title');
    assert.ok(!existsSync(guessFile), 'old note replaced');
    assert.ok(r.keptUserEdits.some((p) => p.includes('Ping')), 'task edit reported as kept');
    assert.match(readFileSync(taskFile, 'utf8'), /Ran this before the demo/);

    // Deleting in Jarvis removes the untouched note; the user-edited task note survives deletion.
    app.memory.delete(temp.id);
    app.tasks.delete(task.id);
    const r2 = await app.obsidian.sync();
    assert.ok(!listAll(base).some((f) => f.includes('Use Postgres')), 'deleted memory removed from the vault');
    assert.ok(existsSync(taskFile), 'edited note kept even after the task was deleted');
    assert.ok(r2.removed >= 1);
  } finally {
    await cleanup();
  }
});

test('obsidian: write_note asks first, never overwrites; search reads the whole vault', async () => {
  const v = vault();
  const { app, cleanup } = await makeApp();
  try {
    enable(app, v);
    const step = { skill: 'obsidian.write_note', input: { title: 'Meeting: dragon lamp', content: 'Decided on [[Ideas]]. #meeting', folder: 'Meetings' }, description: 'Write notes' };
    const { task } = app.engine.createTask({ title: 'Notes', origin: 'user', steps: [step] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'awaiting_approval');
    app.permissions.decideApproval(app.permissions.listApprovals('pending')[0].id, 'approve');
    const done = await waitFor(() => {
      const t = app.tasks.get(task.id)!;
      return ['completed', 'failed'].includes(t.status) ? t : null;
    });
    assert.equal(done.status, 'completed', done.error ?? '');
    const note = join(v, 'Jarvis/Notes/Meetings/Meeting dragon lamp.md');
    assert.match(readFileSync(note, 'utf8'), /# Meeting: dragon lamp\n\nDecided on \[\[Ideas\]\]\. #meeting/);

    app.settings.update({ permissions: { policies: { 'obsidian.write': 'allow', 'obsidian.read': 'allow' } } });
    const same = await app.runner.invoke({ agent: 'executor', skill: 'obsidian.write_note', input: step.input });
    assert.equal(same.status, 'ok', 'writing identical content again is a no-op');
    const clash = await app.runner.invoke({ agent: 'executor', skill: 'obsidian.write_note', input: { ...step.input, content: 'Different' } });
    assert.equal(clash.status, 'failed');
    assert.match((clash as { error: string }).error, /already exists/);

    // Notes written on request belong to the user: syncs never remove them.
    await app.obsidian.sync();
    assert.ok(existsSync(note));

    const found = await app.runner.invoke({ agent: 'jarvis', skill: 'obsidian.search', input: { query: 'dragon-shaped' } });
    assert.equal(found.status, 'ok');
    assert.match((found as { description: string }).description, /\[\[Ideas\]\]:2/);
    const read = await app.runner.invoke({ agent: 'jarvis', skill: 'obsidian.read', input: { note: 'Ideas' } });
    assert.match((read as { description: string }).description, /dragon-shaped lamp/);
    const escape = await app.runner.invoke({ agent: 'jarvis', skill: 'obsidian.read', input: { note: '../../etc/passwd' } });
    assert.equal(escape.status, 'failed');
  } finally {
    await cleanup();
  }
});

test('obsidian: changes reach the vault automatically', async () => {
  const v = vault();
  const { app, cleanup } = await makeApp();
  try {
    enable(app, v);
    await app.obsidian.sync();
    app.memory.add({ kind: 'procedure', content: 'Deploy with npm run deploy after tests pass', source: 'user', verified: true });
    await waitFor(() => listAll(join(v, 'Jarvis')).some((f) => f.startsWith('Memory/Procedures/Deploy')), 12_000, 'event-driven sync');
  } finally {
    await cleanup();
  }
});

test('obsidian: safe file names', () => {
  assert.equal(safeName('Meeting: Q4 / plan?'), 'Meeting Q4 plan');
  assert.equal(safeName('...'), 'Untitled');
  assert.equal(safeName('[[link]] #tag^x'), 'link tag x');
});
