/**
 * Desktop launcher: starts the Jarvis service and opens it in a dedicated app window
 * (Chrome / Edge / Brave / Chromium "--app" mode — no browser tabs or toolbars).
 *
 *   npm run app                 open the window; closing it shuts Jarvis down safely
 *   npm run app -- --keep-running   keep Jarvis working in the background after the window closes
 *
 * Set JARVIS_BROWSER to a Chromium-based browser executable to choose one explicitly.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startJarvis, type RunningJarvis } from '../server/main.ts';

const keepRunning = process.argv.includes('--keep-running');

function findBrowser(): string | null {
  if (process.env.JARVIS_BROWSER) return existsSync(process.env.JARVIS_BROWSER) ? process.env.JARVIS_BROWSER : null;
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Arc']) candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
  } else if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(Boolean) as string[];
    for (const root of roots) {
      candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      const found = spawnSync('which', [name], { encoding: 'utf8' });
      if (found.status === 0 && found.stdout.trim()) candidates.push(found.stdout.trim());
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

function openDefault(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

async function existingInstance(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return (await res.text()).includes('name="jarvis-token"');
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.JARVIS_PORT ?? 7777);
  let running: RunningJarvis | null = null;
  let url = `http://127.0.0.1:${port}`;
  try {
    running = await startJarvis({ port });
    url = running.url;
    console.log(`\n  Jarvis is running at ${url}\n  Data directory: ${running.app.dataDir}\n`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await existingInstance(port))) {
      console.log(`Jarvis is already running at ${url}; opening a window.`);
    } else {
      console.error(`Jarvis failed to start: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const shutdown = async (why: string) => {
    if (!running) return process.exit(0);
    console.log(`${why} — shutting down safely…`);
    await running.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('Interrupted'));
  process.on('SIGTERM', () => void shutdown('Terminated'));

  const browser = findBrowser();
  if (!browser) {
    console.log('No Chromium-based browser found for an app window; opening your default browser instead.');
    console.log('Jarvis keeps running until you press Ctrl+C.');
    openDefault(url);
    return;
  }
  const profile = join(running?.app.dataDir ?? process.env.JARVIS_DATA_DIR ?? '.', 'app-window');
  mkdirSync(profile, { recursive: true });
  const args = [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1440,900', '--no-first-run', '--no-default-browser-check'];
  // Chromium refuses to start as root unless its sandbox is disabled.
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  const openedAt = Date.now();
  const child = spawn(browser, args, { stdio: 'ignore' });
  child.on('error', (err) => {
    console.error(`Could not open the app window (${err.message}); opening your default browser.`);
    openDefault(url);
  });
  child.on('exit', (code) => {
    if (Date.now() - openedAt < 5000) {
      // Exited at once: the launch failed or it handed off to an already-open window.
      console.log(`The app window process exited immediately (code ${code}). Jarvis keeps running at ${url} — press Ctrl+C to stop it.`);
      if (!running) process.exit(0);
      return;
    }
    if (keepRunning || !running) {
      if (running) console.log('Window closed. Jarvis keeps working in the background — press Ctrl+C to stop it.');
      if (!running) process.exit(0);
      return;
    }
    void shutdown('Window closed');
  });
}

void main();
