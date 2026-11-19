/**
 * Computer Access — REAL per-platform capability test (Windows / macOS / Linux).
 *
 *   node --disable-warning=ExperimentalWarning scripts/computer-platform-test.ts [--out dir] [--strict]
 *
 * Runs on the machine it is started on, inside its desktop session, and exercises every capability
 * with the platform's real integration — no mocks:
 *
 *   screen capture · OCR · window list/accessibility · active window · mouse move · OS-level click ·
 *   OS-level keyboard · OS-level scroll · window switching · browser interaction (DevTools) ·
 *   learning pipeline (watch → store → recall) · emergency stop
 *
 * A real browser window (Chrome/Edge/Chromium, headed) shows the local test app; OS-level input is
 * cross-checked through the page itself. Each capability is recorded as PASS / FAIL / PARTIAL /
 * BLOCKED BY ENVIRONMENT with the evidence, printed as a table and written to
 * <out>/platform-<os>.json. Exit code is 0 unless --strict and something FAILED.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../tests/helpers.ts';
import { findChromium, freePort } from '../tests/_browser.ts';
import { COURSE_NAME, startSite } from '../tests/fixtures/computer-site.ts';
import { slug } from '../server/computer/learning.ts';

type Result = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED BY ENVIRONMENT' | 'NOT TESTED';
const rows: Array<{ capability: string; result: Result; evidence: string }> = [];
const record = (capability: string, result: Result, evidence: string) => {
  rows.push({ capability, result, evidence: evidence.replace(/\s+/g, ' ').slice(0, 300) });
  console.log(`  ${result.padEnd(22)} ${capability.padEnd(22)} ${evidence.slice(0, 160)}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(process.cwd(), 'test-results');
const strict = args.includes('--strict');
const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

const main = async () => {
  console.log(`\nComputer Access platform test — ${osName} (${process.platform} ${process.arch})\n`);
  const { app, cleanup } = await makeApp();
  const site = await startSite();
  const chromium = findChromium();
  const port = await freePort();
  let browserProc: ChildProcess | null = null;
  try {
    app.settings.update({ computerAccess: { enabled: true, level: 'extended', browserEndpoint: `http://127.0.0.1:${port}`, watchIntervalSec: 1 } });
    const st = app.computer.status();
    console.log(`Display: ${st.display.server}${st.display.headless ? ' (headless)' : ''} — ${st.display.detail}\n`);

    // 1-4: observation probes on this machine.
    const probes = new Map((await app.computer.verify()).map((p) => [p.id, p]));
    const probe = (id: string, cap: string, blockedIf: RegExp) => {
      const p = probes.get(id);
      if (!p) return record(cap, 'NOT TESTED', 'no probe');
      record(cap, p.ok ? 'PASS' : blockedIf.test(p.detail) ? 'BLOCKED BY ENVIRONMENT' : 'FAIL', p.detail);
    };
    probe('screen.capture', 'Screen capture', /no display|not installed|no screenshot tool|permission|not authorized/i);
    probe('screen.ocr', 'OCR', /not installed/i);
    probe('accessibility', 'Window detection', /no display|wayland|no window tool/i);
    probe('active-window', 'Active window', /no display|wayland/i);

    // 5: mouse move with independent read-back.
    const inputOk = app.computer.interactionAvailable();
    if (!inputOk.available) record('Mouse control', 'BLOCKED BY ENVIRONMENT', inputOk.reason ?? 'no input path');
    else {
      try {
        const r = await app.computer.control({ kind: 'move', x: 211, y: 177 });
        record('Mouse control', r.verified ? (r.verified.ok ? 'PASS' : 'FAIL') : 'PARTIAL', r.verified ? r.verified.detail : `${r.detail} (no read-back on this OS)`);
      } catch (err) {
        record('Mouse control', /permission|not allowed|assistive/i.test((err as Error).message) ? 'BLOCKED BY ENVIRONMENT' : 'FAIL', (err as Error).message);
      }
    }

    // Browser: a real, headed window showing the test app.
    if (!chromium) {
      for (const c of ['Browser interaction', 'Keyboard control', 'OS-level click', 'Scroll', 'Window switching', 'Learning pipeline']) record(c, 'BLOCKED BY ENVIRONMENT', 'no Chromium-family browser installed');
    } else {
      const prof = mkdtempSync(join(tmpdir(), 'jarvis-plat-'));
      const bargs = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', '--window-position=0,0', '--window-size=1200,860', `--app=${site.url}/app`];
      if (process.platform === 'linux' && process.getuid?.() === 0) bargs.push('--no-sandbox');
      if (st.display.headless) bargs.push('--headless=new');
      browserProc = spawn(chromium, bargs, { stdio: 'ignore' });
      for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false)); i++) await wait(150);
      await wait(2500);

      // 6: browser interaction (semantic, verified).
      try {
        await app.computer.browserOp({ op: 'navigate', url: `${site.url}/app` });
        const c = await app.computer.browserOp({ op: 'click', target: { name: 'Say Hello' }, expectText: 'hello clicked' });
        const t = await app.computer.browserOp({ op: 'type', target: { name: 'Full name' }, text: 'Ada' });
        const ok = 'result' in c && c.result.verified?.ok && 'result' in t && t.result.verified?.ok;
        record('Browser interaction', ok ? 'PASS' : 'FAIL', ok ? 'click verified ("hello clicked" appeared); typing verified in the field' : JSON.stringify({ c, t }).slice(0, 250));
      } catch (err) {
        record('Browser interaction', 'FAIL', (err as Error).message);
      }

      const pageState = async () => {
        const r = await app.computer.browserOp({ op: 'read' });
        return 'page' in r ? r.page : null;
      };

      if (!inputOk.available || st.display.headless) {
        for (const c of ['Keyboard control', 'OS-level click', 'Scroll', 'Window switching']) record(c, 'BLOCKED BY ENVIRONMENT', st.display.headless ? 'no display' : inputOk.reason ?? 'no input path');
      } else {
        // 7: window switching (bring the browser to the front by its title).
        try {
          const r = await app.computer.control({ kind: 'activate_window', title: process.platform === 'darwin' ? 'Google Chrome' : 'Jarvis Test App' });
          record('Window switching', r.verified ? (r.verified.ok ? 'PASS' : 'FAIL') : 'PARTIAL', r.verified?.detail ?? r.detail);
        } catch (err) {
          record('Window switching', /permission|not allowed|assistive/i.test((err as Error).message) ? 'BLOCKED BY ENVIRONMENT' : 'FAIL', (err as Error).message);
        }
        await wait(500);

        // 8: OS-level keyboard into a field focused by a semantic click; cross-checked in the page.
        try {
          await app.computer.browserOp({ op: 'click', target: { name: 'Email address' } });
          await app.computer.control({ kind: 'type', text: 'os@typed.test' });
          await wait(600);
          const v = (await pageState())?.elements.find((e) => e.name === 'Email address')?.value ?? '';
          record('Keyboard control', v.includes('os@typed.test') ? 'PASS' : 'FAIL', `field value after OS-level typing: ${JSON.stringify(v)}`);
        } catch (err) {
          record('Keyboard control', /permission|not allowed|assistive/i.test((err as Error).message) ? 'BLOCKED BY ENVIRONMENT' : 'FAIL', (err as Error).message);
        }

        // 9: OS-level click: find "Say Hello" on screen with OCR (or fall back to its page rect) and click it.
        try {
          await app.computer.browserOp({ op: 'navigate', url: `${site.url}/app` });
          await wait(800);
          let how = '';
          let point: { x: number; y: number } | null = null;
          const ocrHit = probes.get('screen.ocr')?.ok ? (await app.computer.findOnScreen('Say Hello')).matches[0] : undefined;
          if (ocrHit) {
            point = { x: ocrHit.x, y: ocrHit.y };
            how = `located by OCR at ${ocrHit.x},${ocrHit.y}`;
          } else {
            const loc = await app.computer.browser().locate((await app.computer.browser().activeTab())!.id, { name: 'Say Hello' });
            if (loc.found) {
              // Window chrome offset is approximate without OCR.
              point = { x: Math.round(loc.x!), y: Math.round(loc.y! + 30) };
              how = `located from the page layout at ${point.x},${point.y} (approximate; OCR unavailable)`;
            }
          }
          if (!point) record('OS-level click', 'FAIL', 'could not locate the button');
          else {
            await app.computer.control({ kind: 'click', x: point.x, y: point.y, label: 'Say Hello' });
            await wait(700);
            const ok = /Status: hello clicked/.test((await pageState())?.text ?? '');
            record('OS-level click', ok ? 'PASS' : ocrHit ? 'FAIL' : 'PARTIAL', `${how}; page ${ok ? 'changed to "hello clicked"' : 'did not change'}`);
          }
        } catch (err) {
          record('OS-level click', /permission|not allowed|assistive/i.test((err as Error).message) ? 'BLOCKED BY ENVIRONMENT' : 'FAIL', (err as Error).message);
        }

        // 10: OS-level scroll, cross-checked by the page's scroll position.
        try {
          await app.computer.control({ kind: 'move', x: 600, y: 450 });
          const before = (await pageState())?.scroll.y ?? 0;
          for (let i = 0; i < 3; i++) await app.computer.control({ kind: 'scroll', direction: 'down', amount: 5 });
          await wait(600);
          const after = (await pageState())?.scroll.y ?? 0;
          record('Scroll', after > before ? 'PASS' : 'FAIL', `page scrollY ${before} → ${after}`);
        } catch (err) {
          record('Scroll', /permission|not allowed|assistive/i.test((err as Error).message) ? 'BLOCKED BY ENVIRONMENT' : 'FAIL', (err as Error).message);
        }
      }

      // 11: learning pipeline through the browser, then recall.
      try {
        await app.computer.browserOp({ op: 'navigate', url: `${site.url}/course/lesson/1` });
        const s = await app.watcher.start({ autoScroll: true, nextLabel: 'Next lesson', maxLessons: 2, intervalSec: 1 });
        const done = await Promise.race([app.watcher.wait(s.id), wait(90_000).then(() => null)]);
        const hits = app.learning.recall('osmosis', { courseSlug: slug(COURSE_NAME) });
        const absent = app.learning.recall('quantum entanglement', { courseSlug: slug(COURSE_NAME) });
        const ok = done?.status === 'completed' && done.lessonsSeen === 2 && hits.some((h) => /diffusion of water/i.test(h.content)) && absent.length === 0;
        record('Learning pipeline', ok ? 'PASS' : 'FAIL', `${done?.status ?? 'timeout'}: ${done?.lessonsSeen ?? 0} lesson(s), ${done?.notesStored ?? 0} note(s); recall(osmosis)=${hits.length}; recall(absent)=${absent.length}`);
      } catch (err) {
        record('Learning pipeline', 'FAIL', (err as Error).message);
      }
    }

    // 12: emergency stop cancels a running workflow and turns access off.
    try {
      app.settings.update({ computerAccess: { enabled: true, level: 'interact' } });
      const run = app.workflows.run('stop test', [{ do: 'wait', ms: 3000 }, { do: 'observe' }]);
      await wait(400);
      app.computer.emergencyStop('platform test');
      const r = await run;
      const ok = r.status === 'cancelled' && !app.settings.get().computerAccess.enabled;
      record('Emergency stop', ok ? 'PASS' : 'FAIL', `workflow ${r.status}; access ${app.settings.get().computerAccess.enabled ? 'still ON' : 'OFF'}`);
    } catch (err) {
      record('Emergency stop', 'FAIL', (err as Error).message);
    }
  } finally {
    browserProc?.kill();
    await site.close();
    await cleanup();
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `platform-${osName}.json`), JSON.stringify({ os: osName, platform: process.platform, arch: process.arch, node: process.version, at: new Date().toISOString(), rows }, null, 2));
  console.log(`\n| Capability | ${osName} | Evidence |\n|---|---|---|\n${rows.map((r) => `| ${r.capability} | ${r.result} | ${r.evidence.replace(/\|/g, '/')} |`).join('\n')}\n`);
  const failed = rows.filter((r) => r.result === 'FAIL');
  return strict && failed.length ? 1 : 0;
};

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
