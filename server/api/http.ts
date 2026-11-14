import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import { UserError } from '../core/util.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      })}$`,
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  get = (p: string, h: Handler) => this.add('GET', p, h);
  post = (p: string, h: Handler) => this.add('POST', p, h);
  put = (p: string, h: Handler) => this.add('PUT', p, h);
  patch = (p: string, h: Handler) => this.add('PATCH', p, h);
  delete = (p: string, h: Handler) => this.add('DELETE', p, h);

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = path.match(r.pattern);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export async function readBody(req: IncomingMessage, limit = 2_000_000): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new UserError('Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  const ct = req.headers['content-type'] ?? '';
  if (!ct.includes('application/json')) throw new UserError('Expected application/json', 415);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new UserError('Invalid JSON body');
  }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new UserError(`Invalid request: ${issue.path.join('.') || 'body'} — ${issue.message}`);
  }
  return result.data;
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** DNS-rebinding defence: only accept requests addressed to a loopback host name. */
export function isLocalHost(hostHeader: string | undefined, port: number | null): boolean {
  if (!hostHeader) return false;
  const m = hostHeader.toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  if (port === null) return LOCAL_HOSTS.has(m[1]);
  return LOCAL_HOSTS.has(m[1]) && (m[2] === undefined ? port === 80 : Number(m[2]) === port);
}

/** CSRF defence: browsers send Origin on cross-site requests; only our own origins are accepted. */
export function isAllowedOrigin(origin: string | undefined, allowed: Set<string>): boolean {
  if (!origin) return true; // same-origin GETs and non-browser clients (which still need the token)
  return allowed.has(origin.toLowerCase());
}
