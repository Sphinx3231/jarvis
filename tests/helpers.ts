import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPalsuProvider, type PalsuProviderHandle, type PalsuResponse } from '@kenkaiiii/gg-ai';
import { JarvisApp } from '../server/app.ts';

// All test instances share one copy of the built-in embedding model (downloaded at most once).
process.env.JARVIS_MODEL_DIR ??= join(tmpdir(), 'jarvis-test-model-cache');
// Never create a real ~/Documents/Jarvis Vault from tests.
process.env.JARVIS_VAULT_DIR ??= join(mkdtempSync(join(tmpdir(), 'jarvis-test-vaults-')), 'Jarvis Vault');

// Jarvis only runs where Roamies is installed: tests get a stand-in Roamies and their own ~/.gg.
const roamiesRoot = mkdtempSync(join(tmpdir(), 'jarvis-test-roamies-'));
process.env.JARVIS_ROAMIES_PATH ??= join(roamiesRoot, 'Roamies.app');
mkdirSync(process.env.JARVIS_ROAMIES_PATH, { recursive: true });
process.env.JARVIS_GG_DIR ??= join(roamiesRoot, 'gg');
mkdirSync(process.env.JARVIS_GG_DIR, { recursive: true });
delete process.env.ROAMIES_DATA_DIR;

/** Write Roamies' settings file (the provider and model picked in Roamies). */
export function roamiesConfig(cfg: Record<string, unknown>): void {
  writeFileSync(join(process.env.JARVIS_GG_DIR!, 'sidekick.json'), JSON.stringify({ provider: null, model: null, look: 'jarvis', ...cfg }));
}

/** Remove every Roamies sign-in. */
export function clearRoamiesAuth(): void {
  rmSync(join(process.env.JARVIS_GG_DIR!, 'auth.json'), { force: true });
}

const palsus: PalsuProviderHandle[] = [];

/** Pick gg-ai's offline test provider in Roamies, so Jarvis thinks with scripted replies. */
export async function usePalsu(app: JarvisApp, responses: PalsuResponse[] = []): Promise<PalsuProviderHandle> {
  const palsu = registerPalsuProvider();
  palsus.push(palsu);
  palsu.setResponses(responses);
  roamiesConfig({ provider: 'palsu', model: 'jarvis-test' });
  await app.llm.refresh(true);
  return palsu;
}

export function tempDir(prefix = 'jarvis-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function makeApp(opts: { start?: boolean; dataDir?: string } = {}): Promise<{ app: JarvisApp; dir: string; cleanup: () => Promise<void> }> {
  const dir = opts.dataDir ?? tempDir();
  roamiesConfig({});
  clearRoamiesAuth();
  const app = new JarvisApp({ dataDir: dir, quiet: true });
  // Tests drive the background jobs directly.
  // Semantic search model downloads are exercised in their own test.
  app.settings.update({ background: { enabled: false }, embeddings: { enabled: false }, integrations: { obsidian: { enabled: false } } });
  if (opts.start !== false) await app.start();
  return {
    app,
    dir,
    cleanup: async () => {
      await app.stop();
      for (const p of palsus.splice(0)) p.unregister();
      if (!opts.dataDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000, label = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export interface MockServer {
  url: string;
  requests: Array<{ method: string; path: string; body: any; headers: Record<string, unknown> }>;
  close: () => Promise<void>;
}

/** Start an HTTP server whose responses are produced by `handler`. */
export async function mockServer(handler: (req: { method: string; path: string; body: any }, index: number) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const server: Server = createServer(async (req, res) => {
    const body = req.method === 'GET' ? null : await readJson(req).catch(() => null);
    const entry = { method: req.method ?? 'GET', path: req.url ?? '/', body, headers: req.headers as Record<string, unknown> };
    requests.push(entry);
    const out = handler(entry, requests.length - 1);
    res.writeHead(out.status ?? 200, { 'content-type': out.text !== undefined ? 'text/html' : 'application/json', ...(out.headers ?? {}) });
    res.end(out.text ?? JSON.stringify(out.json ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A text-only Anthropic Messages API streaming response (server-sent events). */
export function claudeStream(text: string, model = 'claude-sonnet-5-5'): string {
  const ev = (type: string, d: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  return (
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }) +
    ev('message_stop', {})
  );
}
