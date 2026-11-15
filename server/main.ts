import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JarvisApp, VERSION } from './app.ts';
import { createJarvisServer } from './api/server.ts';
import { acquireInstanceLock } from './core/instance-lock.ts';
import { loadEnvFiles } from './core/env.ts';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

export interface StartOptions {
  dataDir?: string;
  port?: number;
  quiet?: boolean;
  webDir?: string;
  dev?: boolean;
}

export interface RunningJarvis {
  app: JarvisApp;
  server: Server;
  url: string;
  token: string;
  stop: () => Promise<void>;
}

export async function startJarvis(opts: StartOptions = {}): Promise<RunningJarvis> {
  const dataDir = resolve(opts.dataDir ?? process.env.JARVIS_DATA_DIR ?? join(homedir(), '.jarvis'));
  // API keys live in a .env file (Fish Audio, HackerOne, transcription, email/calendar). Load it first.
  const env = loadEnvFiles(dataDir);
  if (env.keys.length && !opts.quiet) console.log(`  Loaded ${env.keys.length} key(s) from ${env.files.join(', ')}`);
  const port = opts.port ?? Number(process.env.JARVIS_PORT ?? 7777);
  const dev = opts.dev ?? process.env.JARVIS_DEV === '1';
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = acquireInstanceLock(dataDir);
  let app: JarvisApp;
  try {
    app = new JarvisApp({ dataDir, quiet: opts.quiet });
  } catch (err) {
    lock.release();
    throw err;
  }
  // A fresh token every start. The UI receives it embedded in the page; other local
  // programs and websites cannot read it.
  const token = randomBytes(24).toString('hex');
  writeFileSync(join(dataDir, 'session.token'), token, { mode: 0o600 });

  await app.start();
  const server = createJarvisServer(app, {
    port,
    token,
    webDir: opts.webDir ?? join(here, '..', 'web', 'dist'),
    extraOrigins: dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolvePromise());
    });
  } catch (err) {
    await app.stop();
    lock.release();
    throw err;
  }
  const actualPort = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${actualPort}`;
  lock.setUrl(url);

  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await app.stop();
      lock.release();
    })();
    return stopping;
  };
  return { app, server, url, token, stop };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startJarvis()
    .then((running) => {
      // When started by the desktop app, tell it where to point its window.
      process.send?.({ type: 'ready', url: running.url, dataDir: running.app.dataDir });
      console.log(`\n  Jarvis ${VERSION} is running at ${running.url}`);
      console.log(`  Data directory: ${running.app.dataDir}\n`);
      const shutdown = (signal: string) => {
        console.log(`\nReceived ${signal}, shutting down safely…`);
        running.stop().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      // The desktop app asks over IPC (signals are not graceful on Windows).
      process.on('message', (msg) => {
        if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'shutdown') shutdown('desktop app quitting');
      });
      process.on('disconnect', () => shutdown('desktop app closed'));
    })
    .catch((err) => {
      process.send?.({ type: 'error', message: err instanceof Error ? err.message : String(err), url: (err as { url?: string }).url ?? null, code: (err as { code?: string }).code ?? null });
      console.error(`Jarvis failed to start: ${err instanceof Error ? err.message : err}`);
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error('Another program (or another Jarvis) is using that port. Set JARVIS_PORT to choose another.');
      process.exit(1);
    });
}
