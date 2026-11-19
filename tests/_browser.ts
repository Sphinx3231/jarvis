import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { detectBrowserBinary } from '../server/computer/browser.ts';

/** A Chromium-family browser for the real-browser tests (override with JARVIS_TEST_CHROMIUM). */
export function findChromium(): string | null {
  for (const p of [process.env.JARVIS_TEST_CHROMIUM, '/opt/pw-browsers/chromium']) if (p && existsSync(p)) return p;
  return detectBrowserBinary();
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}
