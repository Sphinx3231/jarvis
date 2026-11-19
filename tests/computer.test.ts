import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, waitFor } from './helpers.ts';

const enable = (app: Awaited<ReturnType<typeof makeApp>>['app'], level: 'observe' | 'interact' | 'extended' = 'observe') =>
  app.settings.update({ computerAccess: { enabled: true, level } });

test('computer: capability report is honest — telemetry works, native control is not faked', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const status = app.computer.status();
    // The report is always available, even with Computer Access off.
    assert.equal(status.enabled, false);
    assert.equal(status.level, 'observe');
    assert.ok(['linux', 'darwin', 'win32'].includes(status.platform));

    const byId = new Map(status.capabilities.map((c) => [c.id, c]));
    // Telemetry is implemented here, so it is reported available.
    assert.equal(byId.get('telemetry')!.status, 'available');
    // Native input/screen/accessibility are NOT wired yet — they must report unavailable, never faked.
    // Nothing native is claimed before a live probe has passed on this machine…
    for (const id of ['screen.capture', 'screen.ocr', 'input.mouse', 'input.keyboard', 'window.manage', 'app.manage']) {
      assert.notEqual(byId.get(id)!.status, 'available', `${id} must not claim to work before a probe`);
      assert.ok(byId.get(id)!.detail);
    }
    // …and on a host with no display (CI containers), the screen/input paths say they're impossible.
    if (status.display.headless) {
      for (const id of ['screen.capture', 'input.mouse', 'input.keyboard', 'accessibility', 'window.manage']) {
        assert.equal(byId.get(id)!.status, 'unavailable', `${id} must not claim to work`);
        assert.ok(byId.get(id)!.requires, `${id} says what it needs`);
      }
    }
    // Browser control works without a display (DevTools), but is never claimed before a live probe.
    assert.notEqual(byId.get('browser.control')!.status, 'available');
    assert.ok(byId.get('browser.control')!.requires);
  } finally {
    await cleanup();
  }
});

test('computer: telemetry is gated behind the toggle and returns real host data when on', async () => {
  const { app, cleanup } = await makeApp();
  try {
    // Off: observing the machine is refused.
    await assert.rejects(() => app.computer.telemetry(), /Computer Access is off/);

    enable(app);
    const t = await app.computer.telemetry();
    // Real numbers from node:os — not mocked.
    assert.ok(t.memory.totalBytes > 0 && t.memory.usedBytes > 0);
    assert.ok(t.cpu.cores >= 1);
    assert.ok(t.cpu.usagePercent === null || (t.cpu.usagePercent >= 0 && t.cpu.usagePercent <= 100));
    // ps is present on this Linux host, so the process list is real.
    if (t.platform === 'linux') {
      assert.equal(t.processes.available, true, t.processes.detail);
      assert.ok(t.processes.total > 0);
      // In a headless container there is no active window, and that is reported honestly.
      if (app.computer.display().headless) assert.equal(t.activeWindow.available, false);
    }
  } finally {
    await cleanup();
  }
});

test('computer: access levels gate what is permitted', async () => {
  const { app, cleanup } = await makeApp();
  try {
    assert.equal(app.computer.permits('observe').ok, false, 'nothing permitted while off');

    enable(app, 'observe');
    assert.equal(app.computer.permits('observe').ok, true);
    assert.equal(app.computer.permits('interact').ok, false, 'observe level cannot interact');
    assert.match(app.computer.permits('interact').reason, /observe/);

    enable(app, 'interact');
    assert.equal(app.computer.permits('interact').ok, true);
    assert.equal(app.computer.permits('extended').ok, false);
  } finally {
    await cleanup();
  }
});

test('computer: the telemetry skill is unavailable until Computer Access is on', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const find = () => app.registry.info().find((s) => s.name === 'computer.telemetry')!;
    assert.equal(find().available, false);
    assert.match(find().unavailableReason!, /Turn on Computer Access/);

    enable(app);
    assert.equal(find().available, true);

    // The capabilities skill is a pure report and is always available.
    assert.equal(app.registry.info().find((s) => s.name === 'computer.capabilities')!.available, true);
  } finally {
    await cleanup();
  }
});

test('computer: telemetry runs through the permission engine (observe scope)', async () => {
  const { app, cleanup } = await makeApp();
  try {
    enable(app);
    // computer.observe defaults to "ask", so a direct call needs approval.
    const needs = await app.runner.invoke({ agent: 'researcher', skill: 'computer.telemetry', input: {} });
    assert.equal(needs.status, 'needs_approval');

    app.settings.update({ permissions: { policies: { 'computer.observe': 'allow' } } });
    const ok = await app.runner.invoke({ agent: 'researcher', skill: 'computer.telemetry', input: {} });
    assert.equal(ok.status, 'ok');
    assert.equal((ok as { untrusted: boolean }).untrusted, true, 'window/process text is untrusted data');
    assert.ok((ok as { output: { memory: { totalBytes: number } } }).output.memory.totalBytes > 0);
  } finally {
    await cleanup();
  }
});

test('computer: observe is gated and honest about what this host can do', async () => {
  const { app, cleanup } = await makeApp();
  try {
    await assert.rejects(() => app.computer.observe({ ocr: true }), /Computer Access is off/);

    enable(app);
    const obs = await app.computer.observe({ ocr: true, activeWindow: true, windows: true });
    // In a headless container there is no screen to capture — reported as a note, not faked.
    if (app.computer.display().headless) {
      assert.equal(obs.screenshot, null);
      assert.equal(obs.ocr, null);
      assert.ok(obs.notes.some((n) => /capture unavailable/i.test(n)), obs.notes.join('; '));
      assert.equal(obs.activeWindow?.available, false);
      assert.equal(obs.windows?.available, false);
    }
  } finally {
    await cleanup();
  }
});

test('computer: verify runs real probes — OCR genuinely works headless here', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const probes = await app.computer.verify();
    const byId = new Map(probes.map((p) => [p.id, p]));
    // Real OCR of a known embedded image — this actually runs tesseract and reads "JARVIS".
    assert.equal(byId.get('screen.ocr')!.ok, true, byId.get('screen.ocr')!.detail);
    // Headless: capture and window inspection genuinely cannot work, and say so.
    if (app.computer.display().headless) {
      assert.equal(byId.get('screen.capture')!.ok, false);
      assert.equal(byId.get('accessibility')!.ok, false);
    }
    // A passed probe upgrades the capability report to "available"; a failed one keeps it honest.
    const caps = new Map(app.computer.status().capabilities.map((c) => [c.id, c]));
    assert.equal(caps.get('screen.ocr')!.status, 'available');
    if (app.computer.display().headless) assert.equal(caps.get('screen.capture')!.status, 'unavailable');
  } finally {
    await cleanup();
  }
});

test('computer: the observe skill is gated behind the toggle', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const find = () => app.registry.info().find((s) => s.name === 'computer.observe')!;
    assert.equal(find().available, false);
    assert.match(find().unavailableReason!, /Turn on Computer Access/);
    assert.equal(find().untrustedOutput, true);
    enable(app);
    assert.equal(find().available, true);
  } finally {
    await cleanup();
  }
});

test('computer: interaction is gated by the interact level and is honest when unavailable', async () => {
  const { app, cleanup } = await makeApp();
  try {
    enable(app, 'observe');
    // At observe level, control is refused for needing a higher level.
    await assert.rejects(() => app.computer.control({ kind: 'move', x: 1, y: 1 }), /interact/);
    const find = () => app.registry.info().find((s) => s.name === 'computer.control')!;
    assert.equal(find().available, false);
    assert.match(find().unavailableReason!, /interact/);
    assert.equal(find().risk, 'consequential');
    assert.equal(find().scope, 'computer.control');

    // At interact level on a headless host there is no input path — reported honestly, not faked.
    enable(app, 'interact');
    if (app.computer.display().headless) {
      await assert.rejects(() => app.computer.control({ kind: 'move', x: 1, y: 1 }), /unavailable/i);
      assert.equal(find().available, false);
    }
  } finally {
    await cleanup();
  }
});

test('computer: the control scope can never be allowed automatically', async () => {
  const { app, cleanup } = await makeApp();
  try {
    // The API-level validation rejects a global "allow" for this consequential scope…
    assert.throws(() => app.permissions.validatePolicyPatch({ 'computer.control': 'allow' }), /cannot be allowed/i);
    // …and even if one were stored, the engine downgrades it to "ask".
    app.settings.update({ permissions: { policies: { 'computer.control': 'allow' } } });
    assert.equal(app.permissions.policyFor('computer.control'), 'ask');
    assert.equal(app.permissions.scopes().find((s) => s.id === 'computer.control')!.allowPermitted, false);
  } finally {
    await cleanup();
  }
});

test('computer: emergency stop turns access off and aborts in-flight actions', async () => {
  const { app, cleanup } = await makeApp();
  try {
    enable(app, 'interact');
    const sig = app.computer.signal; // what an in-flight control action would be holding
    assert.equal(sig.aborted, false);

    const status = app.computer.emergencyStop('test');
    assert.equal(status.enabled, false);
    assert.equal(app.settings.get().computerAccess.enabled, false, 'STOP flips the setting off');
    assert.equal(sig.aborted, true, 'in-flight actions are aborted');
    assert.ok(status.stoppedAt && status.stoppedAt > 0);
    // A fresh signal is handed out for any later session.
    assert.equal(app.computer.signal.aborted, false);
  } finally {
    await cleanup();
  }
});

test('computer: turning the toggle off aborts in-flight actions', async () => {
  const { app, cleanup } = await makeApp();
  try {
    enable(app, 'interact');
    const sig = app.computer.signal;
    app.settings.update({ computerAccess: { enabled: false } });
    await waitFor(() => (sig.aborted ? true : null));
    assert.equal(sig.aborted, true);
  } finally {
    await cleanup();
  }
});
