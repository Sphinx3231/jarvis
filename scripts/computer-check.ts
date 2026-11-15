/**
 * Real-hardware diagnostic for Computer Access Mode.
 *
 *   node --disable-warning=ExperimentalWarning scripts/computer-check.ts
 *
 * Run it ON the machine you want to check (inside your desktop session, so there is a real display).
 * It turns Computer Access on in a throwaway in-memory config — it changes NOTHING in your installed
 * Jarvis — then runs the real capability probes against your actual screen and prints honest PASS/FAIL
 * evidence per capability, plus one live observation. This is how you verify the Windows/macOS paths
 * that the test suite can only mark "unverified".
 */
import { ComputerAccessManager } from '../server/computer/manager.ts';

const cfg = { computerAccess: { enabled: true, level: 'interact', screenshotRetentionMin: 0 } };
const settings = { get: () => cfg, update: () => cfg } as unknown as ConstructorParameters<typeof ComputerAccessManager>[0]['settings'];
const activity = { log: (lvl: string, _cat: string, msg: string) => console.log(`    · [${lvl}] ${msg}`) } as unknown as ConstructorParameters<typeof ComputerAccessManager>[0]['activity'];
const bus = { emit: () => {} } as unknown as ConstructorParameters<typeof ComputerAccessManager>[0]['bus'];

const m = new ComputerAccessManager({ settings, activity, bus });

const main = async () => {
  const s = m.status();
  console.log(`\nComputer Access check — ${s.os} (${s.platform})`);
  console.log(`Display: ${s.display.server}${s.display.headless ? ' [headless — screen/input impossible here]' : ''} — ${s.display.detail}\n`);

  console.log('Running real capability probes (this touches your actual screen/windows):');
  for (const p of await m.verify()) console.log(`  ${p.ok ? 'PASS' : 'FAIL'}  ${p.id.padEnd(16)} ${p.detail}`);

  console.log('\nCapability report (after probes):');
  for (const c of m.status().capabilities) console.log(`  [${c.status.padEnd(11)}] ${c.id.padEnd(16)} ${c.detail}`);

  console.log('\nLive observation:');
  try {
    const o = await m.observe({ ocr: true, windows: true, activeWindow: true });
    console.log(`  active window : ${o.activeWindow?.available ? o.activeWindow.title ?? o.activeWindow.app : `(unavailable: ${o.activeWindow?.detail})`}`);
    console.log(`  open windows  : ${o.windows?.available ? o.windows.list.length : `(unavailable: ${o.windows?.detail})`}`);
    console.log(`  screenshot    : ${o.screenshot ? `${o.screenshot.width}x${o.screenshot.height} via ${o.screenshot.tool}` : `(none) ${o.notes.join('; ')}`}`);
    console.log(`  OCR text      : ${o.ocr ? `${o.ocr.text.length} chars — ${JSON.stringify(o.ocr.text.replace(/\s+/g, ' ').slice(0, 160))}` : '(no OCR)'}`);
    for (const n of o.notes) console.log(`  note          : ${n}`);
  } catch (err) {
    console.log(`  observe failed: ${(err as Error).message}`);
  }
  console.log('\nInteraction path:', m.interactionAvailable().available ? 'available' : `unavailable — ${m.interactionAvailable().reason}`);
  console.log('Done. Nothing on your system was changed.\n');
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
