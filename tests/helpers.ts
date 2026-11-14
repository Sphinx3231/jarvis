import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisApp } from '../server/app.ts';

export function tempDir(prefix = 'jarvis-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function makeApp(opts: { start?: boolean; dataDir?: string } = {}): Promise<{ app: JarvisApp; dir: string; cleanup: () => Promise<void> }> {
  const dir = opts.dataDir ?? tempDir();
  const app = new JarvisApp({ dataDir: dir, quiet: true });
  // Tests drive the background jobs directly.
  app.settings.update({ background: { enabled: false } });
  if (opts.start !== false) await app.start();
  return {
    app,
    dir,
    cleanup: async () => {
      await app.stop();
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

/** Build an Anthropic Messages API response. */
export function claudeMessage(content: unknown[], stop_reason = 'end_turn') {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

/** Point the Anthropic provider at a mock server with a dummy key. */
export function useMockClaude(app: JarvisApp, baseUrl: string): void {
  const providers = app.settings.get().llm.providers.map((p) => (p.id === 'anthropic' ? { ...p, baseUrl, enabled: true } : p));
  app.settings.update({ llm: { providers } });
  app.secrets.set('llm:anthropic:apiKey', 'sk-ant-test-key-0000000000');
}
