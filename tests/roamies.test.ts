import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJarvis } from '../server/main.ts';
import { detectRoamies, roamiesConfigPath } from '../server/roamies/detect.ts';
import { RoamiesGate } from '../server/roamies/gate.ts';
import { EventBus } from '../server/core/events.ts';
import { tempDir, waitFor } from './helpers.ts';

test('roamies: found where each installer puts it, and not found otherwise', () => {
  const root = tempDir('jarvis-roamies-detect-');
  try {
    const home = join(root, 'home');
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    mkdirSync(home, { recursive: true });
    const base = { HOME: home, PATH: empty };

    // Nothing installed anywhere.
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const d = detectRoamies({ env: { ...base, LOCALAPPDATA: join(root, 'appdata') }, platform });
      assert.equal(d.installed, false, platform);
      assert.ok(d.searched.length > 0);
    }

    // macOS: Roamies.app in ~/Applications (or /Applications), version from Info.plist.
    const app = join(home, 'Applications', 'Roamies.app', 'Contents');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key>\n<string>0.1.38</string></dict></plist>');
    const mac = detectRoamies({ env: base, platform: 'darwin' });
    assert.equal(mac.installed, true);
    assert.equal(mac.how, 'app');
    assert.equal(mac.version, '0.1.38');

    // Windows: the per-user installer's folder under %LOCALAPPDATA%.
    const local = join(root, 'appdata');
    mkdirSync(join(local, 'Roamies'), { recursive: true });
    writeFileSync(join(local, 'Roamies', 'Roamies.exe'), 'MZ');
    const win = detectRoamies({ env: { ...base, LOCALAPPDATA: local }, platform: 'win32' });
    assert.equal(win.installed, true);
    assert.equal(win.path, join(local, 'Roamies', 'Roamies.exe'));

    // Linux: the roamies command from the .deb / .rpm …
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'roamies'), '#!/bin/sh\n', { mode: 0o755 });
    const deb = detectRoamies({ env: { ...base, PATH: bin }, platform: 'linux' });
    assert.equal(deb.how, 'command');
    // … or an AppImage saved in a usual place.
    mkdirSync(join(home, 'Downloads'));
    writeFileSync(join(home, 'Downloads', 'Roamies_0.1.38_amd64.AppImage'), 'ELF', { mode: 0o755 });
    const appimage = detectRoamies({ env: base, platform: 'linux' });
    assert.equal(appimage.how, 'appimage');
    assert.equal(appimage.version, '0.1.38');

    // Where Roamies keeps its settings: ROAMIES_DATA_DIR, else ~/.gg.
    assert.equal(roamiesConfigPath({ JARVIS_GG_DIR: join(root, 'gg') }), join(root, 'gg', 'sidekick.json'));
    assert.equal(roamiesConfigPath({ ROAMIES_DATA_DIR: join(root, 'data') }), join(root, 'data', 'sidekick.json'));

    // A location the user picked must exist and be a Roamies app.
    const bus = new EventBus();
    const gate = new RoamiesGate(join(root), bus, { ...base, PATH: empty, HOME: empty });
    assert.equal(gate.installed, false);
    assert.throws(() => gate.choose(join(root, 'appdata')), /not a Roamies app/);
    assert.throws(() => gate.choose(join(root, 'Roamies-missing.AppImage')), /not a Roamies app/);
    const events: unknown[] = [];
    bus.on('roamies.changed', (e) => events.push(e.data));
    const chosen = gate.choose(join(home, 'Downloads', 'Roamies_0.1.38_amd64.AppImage'));
    assert.equal(chosen.installed, true);
    assert.equal(chosen.how, 'chosen');
    assert.equal(events.length, 1);
    assert.equal(new RoamiesGate(root, bus, { ...base, PATH: empty, HOME: empty }).installed, true, 'the choice is remembered');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('roamies: without Roamies, Jarvis is locked (only the requirement screen works) and unlocks without a restart', async () => {
  const dir = tempDir();
  const previous = process.env.JARVIS_ROAMIES_PATH;
  const fakeApp = join(dir, 'Roamies.app');
  process.env.JARVIS_ROAMIES_PATH = fakeApp;
  mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<meta name="jarvis-token" content="" />');
  const s = await startJarvis({ dataDir: join(dir, 'data'), port: 0, quiet: true, webDir: join(dir, 'web') });
  const api = (path: string, init: RequestInit = {}) => fetch(`${s.url}${path}`, { ...init, headers: { 'x-jarvis-token': s.token, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  try {
    let res = await api('/api/status');
    assert.equal(res.status, 423);
    const locked = (await res.json()) as { locked: boolean; roamies: { met: boolean; downloadUrl: string } };
    assert.equal(locked.locked, true);
    assert.equal(locked.roamies.met, false);
    assert.equal(locked.roamies.downloadUrl, 'https://github.com/KenKaiii/Roamies/releases/latest');
    assert.equal((await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'remember that I like tea' }) })).status, 423, 'nothing else runs');
    assert.equal((await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'list files' }) })).status, 423);
    assert.equal(s.app.tasks.list().length, 0);
    assert.equal(s.app.scheduler.status().some((j) => j.lastRunAt), false, 'no background jobs ran');

    res = await api('/api/about');
    assert.equal(res.status, 200);
    const about = (await res.json()) as { license: string; source: string; builtOn: Array<{ name: string }> };
    assert.equal(about.license, 'AGPL-3.0-only');
    assert.match(about.source, /github\.com/);
    assert.ok(about.builtOn.some((b) => b.name === 'Roamies'));
    assert.equal((await api('/api/roamies')).status, 200);

    // Install Roamies, choose Check again: Jarvis starts.
    mkdirSync(fakeApp);
    res = await api('/api/roamies/check', { method: 'POST' });
    assert.equal(((await res.json()) as { met: boolean }).met, true);
    await waitFor(() => s.app.requirement().running, 5000, 'services started');
    res = await api('/api/status');
    assert.equal(res.status, 200);
    res = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'list files' }) });
    assert.equal(res.status, 200);
    const { task } = (await res.json()) as { task: { id: string } };
    await waitFor(() => s.app.tasks.get(task.id)?.status === 'completed', 5000, 'task ran');
    assert.ok(s.app.activity.recent(50).some((a) => /Roamies found/.test(a.message)));
  } finally {
    await s.stop();
    if (previous === undefined) delete process.env.JARVIS_ROAMIES_PATH;
    else process.env.JARVIS_ROAMIES_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
