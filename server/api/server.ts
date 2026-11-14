import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { JarvisApp } from '../app.ts';
import { errorMessage, UserError } from '../core/util.ts';
import { isAllowedOrigin, isLocalHost, readBody, Router, safeEqual, sendJson } from './http.ts';

/** Endpoints that work while Jarvis is locked waiting for Roamies. */
const LOCKED_PATHS = new Set(['/api/roamies', '/api/roamies/check', '/api/roamies/location', '/api/about']);
import { registerRoutes } from './routes.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export interface ServerOptions {
  port: number;
  token: string;
  webDir: string;
  /** Extra origins allowed to call the API (the Vite dev server in development). */
  extraOrigins?: string[];
}

export function createJarvisServer(app: JarvisApp, opts: ServerOptions): Server {
  const router = new Router();
  registerRoutes(router, app);
  const webRoot = resolve(opts.webDir);
  let indexHtml: string | null = null;

  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number } | null)?.port ?? opts.port;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, ...(opts.extraOrigins ?? [])]);

    // In dev mode the Vite proxy forwards requests addressed to its own port.
    if (!isLocalHost(req.headers.host, opts.extraOrigins?.length ? null : port)) {
      res.writeHead(421, { 'content-type': 'text/plain' }).end('Misdirected request');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!isAllowedOrigin(req.headers.origin, allowedOrigins)) return sendJson(res, 403, { error: 'Origin not allowed' });
      const token = (req.headers['x-jarvis-token'] as string | undefined) ?? (url.pathname === '/api/events' ? url.searchParams.get('token') : null) ?? '';
      if (!safeEqual(token, opts.token)) return sendJson(res, 401, { error: 'Unauthorized' });

      if (url.pathname === '/api/events' && req.method === 'GET') return streamEvents(app, req, res);

      // Jarvis runs on Roamies: until Roamies is found, only the "Roamies required" screen works.
      if (!app.unlocked && !LOCKED_PATHS.has(url.pathname)) {
        return sendJson(res, 423, { error: 'Roamies is required. Jarvis runs on Roamies — install it, then choose Check again.', locked: true, roamies: app.requirement() });
      }

      const match = router.match(req.method ?? 'GET', url.pathname);
      if (!match) return sendJson(res, 404, { error: 'Not found' });
      if (match === 'method') return sendJson(res, 405, { error: 'Method not allowed' });
      try {
        const body = await readBody(req);
        const result = await match.handler({ req, res, params: match.params, query: url.searchParams, body });
        if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
      } catch (err) {
        if (err instanceof UserError) return sendJson(res, err.status, { error: err.message });
        app.activity.log('error', 'api', `${req.method} ${url.pathname} failed: ${errorMessage(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      }
      return;
    }

    // Static UI
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    let filePath = normalize(join(webRoot, decodeURIComponent(url.pathname)));
    if (filePath !== webRoot && !filePath.startsWith(webRoot + sep)) return void res.writeHead(403).end();
    const isAsset = extname(url.pathname) !== '';
    if (!isAsset || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      if (isAsset) return void res.writeHead(404, SECURITY_HEADERS).end('Not found');
      filePath = join(webRoot, 'index.html');
      if (!existsSync(filePath)) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end('The Jarvis UI has not been built yet. Run "npm run build" and restart.');
      }
      indexHtml ??= readFileSync(filePath, 'utf8');
      const html = indexHtml.replace('<meta name="jarvis-token" content="" />', `<meta name="jarvis-token" content="${opts.token}" />`);
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return void res.end(html);
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(readFileSync(filePath));
  });

  return server;
}

function streamEvents(app: JarvisApp, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  send({ type: 'hello', ts: Date.now(), data: { state: app.state.get() } });
  const off = app.bus.on('*', (event) => send(event));
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    off();
    clearInterval(ping);
  });
}
