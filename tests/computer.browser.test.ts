import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser, CdpSession } from '../server/computer/browser.ts';
import { findChromium, freePort } from './_browser.ts';
import { ConfirmationRequired } from '../server/computer/manager.ts';
import { makeApp } from './helpers.ts';
import { startSite, type Site } from './fixtures/computer-site.ts';

/**
 * REAL browser-interaction integration tests: a real Chromium (headless here; headed in the OS test),
 * driven by Jarvis over a loopback DevTools port against the local test app. No mocks: clicks are real
 * trusted input events, typing lands in real fields, verification reads the real page.
 * Self-skips only when no Chromium-family browser exists on the host.
 */

const CHROMIUM = findChromium();
const SKIP = CHROMIUM ? false : 'no Chromium-family browser on this host';

let site: Site;
let port = 0;
let pid: number | undefined;
let profile = '';

before(async () => {
  if (!CHROMIUM) return;
  site = await startSite();
  port = await freePort();
  profile = mkdtempSync(join(tmpdir(), 'jarvis-browser-profile-'));
  const args = ['--headless=new', '--disable-gpu', '--window-size=1200,900'];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  pid = launchBrowser({ binary: CHROMIUM, profileDir: profile, port, extraArgs: args }).pid;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  if (pid) {
    try {
      process.kill(pid);
    } catch {
      /* gone */
    }
  }
  await site?.close();
  await new Promise((r) => setTimeout(r, 300));
  if (profile) rmSync(profile, { recursive: true, force: true });
});

async function appWithBrowser(level: 'observe' | 'interact' | 'extended' = 'interact') {
  const ctx = await makeApp();
  ctx.app.settings.update({ computerAccess: { enabled: true, level, browserEndpoint: `http://127.0.0.1:${port}` } });
  return ctx;
}

test('browser: connects to the real browser, opens the app, reads controls/dialogs/sign-in state', { skip: SKIP }, async () => {
  const { app, cleanup } = await appWithBrowser();
  try {
    const open = await app.computer.browserOp({ op: 'open', url: `${site.url}/app` });
    assert.ok('tab' in open);
    const read = await app.computer.browserOp({ op: 'read' });
    assert.ok('page' in read);
    const p = read.page;
    assert.equal(p.title, 'Jarvis Test App');
    const names = p.elements.map((e) => `${e.role}:${e.name}`);
    for (const want of ['button:Say Hello', 'button:Send message', 'tab:Details', 'textbox:Full name', 'checkbox:Subscribe to updates', 'combobox:Topic', 'menuitem:File']) assert.ok(names.includes(want), `${want} in ${names.join(' | ')}`);
    // Password values are never exposed.
    assert.equal(p.elements.find((e) => e.name === 'Password')!.value, '[hidden]');
    assert.equal(p.loginRequired, false, 'a password field alone is not a sign-in wall');
    assert.equal(p.dialogs.length, 0);
    // The capability report is now backed by a live probe.
    assert.equal(app.computer.status().capabilities.find((c) => c.id === 'browser.control')!.status, 'available');
    // The visible tab list is real.
    const tabs = await app.computer.browserOp({ op: 'tabs' });
    assert.ok('tabs' in tabs && tabs.tabs.some((t) => t.url.endsWith('/app')));
  } finally {
    await cleanup();
  }
});

test('browser: click, type, checkbox, select via keyboard, tabs, menu — each verified on the real page', { skip: SKIP }, async () => {
  const { app, cleanup } = await appWithBrowser();
  try {
    await app.computer.browserOp({ op: 'navigate', url: `${site.url}/app` });
    const click = async (name: string, expectText?: string, role?: string) => {
      const r = await app.computer.browserOp({ op: 'click', target: { name, role }, expectText });
      assert.ok('result' in r);
      return r.result;
    };
    let r = await click('Say Hello', 'hello clicked');
    assert.equal(r.verified?.ok, true, r.verified?.detail);
    r = await click('Details', 'ORCHID', 'tab');
    assert.equal(r.verified?.ok, true);
    r = await click('File', undefined, 'menuitem');
    assert.equal(r.verified?.ok, true, 'menu opened');
    r = await click('Export', 'exported');
    assert.equal(r.verified?.ok, true);
    const typed = await app.computer.browserOp({ op: 'type', target: { name: 'Full name' }, text: 'Ada Lovelace' });
    assert.ok('result' in typed && typed.result.verified?.ok, 'text landed in the field');
    r = await click('Subscribe to updates');
    assert.match(r.verified!.detail, /now on/);
    await app.computer.browserOp({ op: 'click', target: { name: 'Topic' } });
    await app.computer.browserOp({ op: 'key', key: 'ArrowDown' });
    r = await click('Submit form', 'submitted Ada Lovelace / Billing / subscribed');
    assert.equal(r.verified?.ok, true, r.verified?.detail);
    // Scrolling reveals content below the fold; the scroll is verified by the page position.
    const s = await app.computer.browserOp({ op: 'scroll', direction: 'down', amount: 3000 });
    assert.ok('result' in s && s.result.verified?.ok);
    r = await click('Bottom Button', 'bottom reached');
    assert.equal(r.verified?.ok, true);
    // Every action is in the persistent action log.
    const log = app.computer.actions.recent(50).map((a) => a.kind);
    for (const k of ['browser.navigate', 'browser.click', 'browser.type', 'browser.scroll']) assert.ok(log.includes(k), k);
  } finally {
    await cleanup();
  }
});

test('browser: a dead button is reported unverified; passwords are refused; a covering dialog blocks the click', { skip: SKIP }, async () => {
  const { app, cleanup } = await appWithBrowser();
  try {
    await app.computer.browserOp({ op: 'navigate', url: `${site.url}/app` });
    const dead = await app.computer.browserOp({ op: 'click', target: { name: 'Broken Button' } });
    assert.ok('result' in dead);
    assert.equal(dead.result.verified?.ok, false, 'no fake success');
    assert.equal(app.computer.actions.recent(1)[0].outcome, 'unverified');
    const pw = await app.computer.browserOp({ op: 'type', target: { name: 'Password' }, text: 'hunter2' });
    assert.ok('result' in pw && !pw.result.ok && /never enters passwords/.test(pw.result.detail));
    await app.computer.browserOp({ op: 'click', target: { name: 'Open Settings' } });
    const blocked = await app.computer.browserOp({ op: 'click', target: { name: 'Say Hello' } });
    assert.ok('result' in blocked && /covered by another element/.test(blocked.result.detail));
    const closed = await app.computer.browserOp({ op: 'click', target: { name: 'Close dialog' } });
    assert.ok('result' in closed && closed.result.verified?.ok);
  } finally {
    await cleanup();
  }
});

test('browser: clicking "Send message" waits for the user; their confirmation authorizes exactly one click', { skip: SKIP }, async () => {
  const { app, cleanup } = await appWithBrowser();
  try {
    app.settings.update({ permissions: { fullAccess: true } }); // even with Full Access
    await app.computer.browserOp({ op: 'navigate', url: `${site.url}/app` });
    let pending: ConfirmationRequired | null = null;
    try {
      await app.computer.browserOp({ op: 'click', target: { name: 'Send message' } });
    } catch (err) {
      pending = err as ConfirmationRequired;
    }
    assert.ok(pending instanceof ConfirmationRequired, 'held for confirmation');
    assert.equal(pending!.confirmation.finding.category, 'send-message');
    assert.equal(app.computer.status().live.state, 'WAITING_FOR_APPROVAL');
    // Nothing was sent.
    const page = await app.computer.browserOp({ op: 'read' });
    assert.ok('page' in page && /Status: ready/.test(page.page.text));
    // The user approves → exactly that click runs once.
    app.computer.decideConfirmation(pending!.confirmation.id, true);
    const sent = await app.computer.browserOp({ op: 'click', target: { name: 'Send message' }, expectText: 'message sent' });
    assert.ok('result' in sent && sent.result.verified?.ok);
    assert.equal(app.computer.actions.recent(1)[0].critical, 'send-message');
    await assert.rejects(() => app.computer.browserOp({ op: 'click', target: { name: 'Send message' } }), (e: unknown) => e instanceof ConfirmationRequired);
  } finally {
    await cleanup();
  }
});

test('workflow: multi-step form fill is planned, executed and verified end-to-end', { skip: SKIP }, async () => {
  const { app, cleanup } = await appWithBrowser();
  try {
    const res = await app.workflows.run('Fill in and submit the contact form', [
      { do: 'browser', action: { op: 'navigate', url: `${site.url}/app` } },
      { do: 'browser', action: { op: 'read' } },
      { do: 'browser', action: { op: 'type', target: { name: 'Full name' }, text: 'Grace Hopper' } },
      { do: 'browser', action: { op: 'type', target: { name: 'Email address' }, text: 'grace@example.com' } },
      { do: 'browser', action: { op: 'click', target: { name: 'Subscribe to updates' } } },
      { do: 'browser', action: { op: 'click', target: { name: 'Submit form' }, expectText: 'submitted Grace Hopper' } },
    ]);
    assert.equal(res.status, 'completed', res.summary + '\n' + res.steps.map((s) => `${s.step}: ${s.status} ${s.detail}`).join('\n'));
    assert.equal(res.steps.length, 6);
    assert.ok(res.steps.every((s) => s.status === 'ok'));
    assert.match(res.finalState ?? '', /Jarvis Test App/);
    assert.equal(app.computer.status().live.state, 'COMPLETED');
  } finally {
    await cleanup();
  }
});

test('workflow: recovers from slow content, never retries a click, and stops at sign-in / missing elements / confirmations', { skip: SKIP }, async () => {
  const { app, cleanup } = await appWithBrowser();
  try {
    // Slow: wait_text is retried with backoff until the delayed result appears.
    let res = await app.workflows.run('Slow action', [
      { do: 'browser', action: { op: 'navigate', url: `${site.url}/app` } },
      { do: 'browser', action: { op: 'click', target: { name: 'Load Slowly' } } },
      { do: 'browser', action: { op: 'wait_text', text: 'slow done', timeoutMs: 1000 } },
    ]);
    // The click itself shows no change within its window → unverified → stop (not retried).
    if (res.status === 'failed') {
      assert.equal(res.steps[1].status, 'unverified');
      assert.equal(res.steps[1].attempts, 1, 'a click is never retried automatically');
    } else {
      assert.equal(res.status, 'completed');
      assert.ok(res.steps[2].attempts >= 1);
    }
    // A slow page load is waited for.
    res = await app.workflows.run('Open a slow page', [{ do: 'browser', action: { op: 'navigate', url: `${site.url}/slow` } }, { do: 'browser', action: { op: 'wait_text', text: 'Finally loaded' } }]);
    assert.equal(res.status, 'completed', res.summary);
    // Missing element: looked for again (safe — nothing was clicked), then a clear failure.
    res = await app.workflows.run('Click something that does not exist', [{ do: 'browser', action: { op: 'navigate', url: `${site.url}/app` } }, { do: 'browser', action: { op: 'click', target: { name: 'Launch rocket' } } }], { maxRetries: 1 });
    assert.equal(res.status, 'failed');
    assert.equal(res.steps[1].attempts, 2);
    assert.match(res.steps[1].detail, /No element matching/);
    assert.equal(res.resumeFrom, 1);
    // Session expired → sign-in page → blocked, with the reason; Jarvis does not type credentials.
    res = await app.workflows.run('Open my course', [{ do: 'browser', action: { op: 'navigate', url: `${site.url}/login` } }, { do: 'browser', action: { op: 'click', target: { name: 'Sign in' } } }]);
    assert.equal(res.status, 'blocked');
    assert.match(res.summary, /sign in/i);
    // Critical step → needs_confirmation with a resume point; approving + resuming finishes it.
    res = await app.workflows.run('Send the message', [{ do: 'browser', action: { op: 'navigate', url: `${site.url}/app` } }, { do: 'browser', action: { op: 'click', target: { name: 'Send message' }, expectText: 'message sent' } }]);
    assert.equal(res.status, 'needs_confirmation');
    assert.equal(res.resumeFrom, 1);
    app.computer.decideConfirmation(res.confirmationId!, true);
    res = await app.workflows.run('Send the message', [{ do: 'browser', action: { op: 'navigate', url: `${site.url}/app` } }, { do: 'browser', action: { op: 'click', target: { name: 'Send message' }, expectText: 'message sent' } }], { startAt: 1 });
    assert.equal(res.status, 'completed', res.summary);
    assert.equal(res.steps[0].status, 'skipped');
  } finally {
    await cleanup();
  }
});

test('STOP and the toggle: a running workflow is cancelled and nothing further executes', { skip: SKIP }, async () => {
  const { app, cleanup } = await appWithBrowser();
  try {
    const steps = [{ do: 'browser' as const, action: { op: 'navigate' as const, url: `${site.url}/app` } }, { do: 'wait' as const, ms: 3000 }, { do: 'browser' as const, action: { op: 'click' as const, target: { name: 'Say Hello' }, expectText: 'hello clicked' } }];
    const running = app.workflows.run('Stoppable', steps);
    await new Promise((r) => setTimeout(r, 900));
    app.computer.emergencyStop('test STOP');
    const res = await running;
    assert.equal(res.status, 'cancelled');
    assert.equal(app.settings.get().computerAccess.enabled, false, 'STOP turns Computer Access off');
    // The click never happened.
    app.settings.update({ computerAccess: { enabled: true, level: 'observe' } });
    const page = await app.computer.browserOp({ op: 'read' });
    assert.ok('page' in page && /Status: ready/.test(page.page.text), 'no click after STOP');
    // Observe level: interaction is refused.
    await assert.rejects(() => app.computer.browserOp({ op: 'click', target: { name: 'Say Hello' } }), /interact/);
    // Off: everything is refused.
    app.settings.update({ computerAccess: { enabled: false } });
    await assert.rejects(() => app.computer.browserOp({ op: 'read' }), /off/);
    await assert.rejects(() => app.workflows.run('x', [{ do: 'observe' }]), /off/);
  } finally {
    await cleanup();
  }
});

test('browser: cookies/storage are unreachable even with a direct DevTools session; a closed tab fails cleanly', { skip: SKIP }, async () => {
  const { app, cleanup } = await appWithBrowser();
  try {
    const open = await app.computer.browserOp({ op: 'open', url: `${site.url}/app` });
    assert.ok('tab' in open);
    const s = await CdpSession.connect(open.tab.wsUrl!);
    for (const m of ['Network.getAllCookies', 'Network.getCookies', 'Storage.getCookies', 'DOMStorage.getDOMStorageItems']) await assert.rejects(() => s.send(m), /Blocked DevTools method/);
    s.close();
    await app.computer.browserOp({ op: 'close_tab', tabId: open.tab.id });
    await assert.rejects(() => app.computer.browserOp({ op: 'read', tabId: open.tab.id }), /gone|closed/);
  } finally {
    await cleanup();
  }
});
