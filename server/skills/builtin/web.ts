import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Skill } from '../types.ts';

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolver = (hostname: string, options: { all: true; family?: number }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const PRIVATE_NAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

/**
 * DNS lookup used by the socket itself. The address checked is the address connected to, so a
 * DNS server cannot answer "public" to a pre-check and "private" to the real connection.
 */
export function guardedLookup(allowPrivate: boolean, resolver: Resolver = dnsLookup as unknown as Resolver) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, callback: LookupCallback): void => {
    const opts = typeof options === 'number' ? { family: options } : options;
    resolver(hostname, { all: true, family: opts.family }, (err, addresses) => {
      if (err) return callback(err, []);
      if (!allowPrivate) {
        const bad = addresses.find((a) => isPrivateAddress(a.address));
        if (bad) return callback(Object.assign(new Error(`Refusing to connect to ${hostname}: it resolves to a private address (${bad.address})`), { code: 'EPRIVATE' }), []);
      }
      if (opts.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface FetchedPage {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated: boolean;
}

/** HTTP(S) GET with connect-time address checks, size limit and transparent decompression. */
export function guardedGet(
  url: URL,
  opts: { allowPrivate: boolean; maxBytes: number; signal?: AbortSignal; resolver?: Resolver; headers?: Record<string, string> },
): Promise<FetchedPage> {
  if (!/^https?:$/.test(url.protocol)) return Promise.reject(new Error('Only http(s) URLs are supported'));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!opts.allowPrivate) {
    if (PRIVATE_NAME.test(host)) return Promise.reject(new Error(`Refusing to fetch private host ${host} (enable "allow private network" in Settings to permit)`));
    // IP literals skip DNS, so they are checked here.
    if (isIP(host) && isPrivateAddress(host)) return Promise.reject(new Error(`Refusing to fetch ${host}: it is a private address`));
  }
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'GET',
        signal: opts.signal,
        lookup: guardedLookup(opts.allowPrivate, opts.resolver) as never,
        headers: { 'accept-encoding': 'gzip, deflate, br', ...opts.headers },
      },
      (res) => {
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const stream: NodeJS.ReadableStream =
          enc === 'gzip' ? res.pipe(createGunzip()) : enc === 'deflate' ? res.pipe(createInflate()) : enc === 'br' ? res.pipe(createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          chunks.push(c);
          if (size > opts.maxBytes) {
            truncated = true;
            res.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).subarray(0, opts.maxBytes), truncated });
          }
        });
        stream.on('end', () => !truncated && resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }));
        stream.on('error', (err) => !truncated && reject(err));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '');
  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title, text };
}

const Input = z.object({
  url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are supported'),
  maxChars: z.number().int().min(500).max(200_000).optional(),
});
type Out = { url: string; finalUrl: string; status: number; contentType: string; title: string; text: string; truncated: boolean };

export const webFetch: Skill<z.infer<typeof Input>, Out> = {
  name: 'web.fetch',
  title: 'Fetch web page',
  description: 'Download a web page (HTTP GET) and return its readable text. Requires approval by default.',
  category: 'web',
  scope: 'network.read',
  risk: 'read',
  idempotent: true,
  inlineSafe: false,
  untrustedOutput: true,
  input: Input,
  outputDescription: 'Status code, final URL, page title and extracted text.',
  timeoutMs: 30_000,
  dependsOn: 'Web access',
  availability: () => ({ available: true }),
  summarize: (i) => `Fetch ${i.url}`,
  async execute(input, ctx) {
    const web = ctx.services.settings.get().integrations.web;
    let url = new URL(input.url);
    let page: FetchedPage | undefined;
    // Redirects are followed manually so every hop goes through the same address checks.
    for (let hop = 0; hop < 6; hop++) {
      page = await guardedGet(url, {
        allowPrivate: web.allowPrivateNetwork,
        maxBytes: web.maxBytes,
        signal: ctx.signal,
        headers: { 'user-agent': 'Jarvis/1.0 (personal assistant)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      });
      const loc = page.headers.location;
      if (page.status >= 300 && page.status < 400 && typeof loc === 'string') {
        if (hop === 5) throw new Error('Too many redirects');
        url = new URL(loc, url);
        if (!/^https?:$/.test(url.protocol)) throw new Error('Redirect to a non-HTTP URL was blocked');
        continue;
      }
      break;
    }
    if (!page) throw new Error('No response');
    const contentType = String(page.headers['content-type'] ?? '');
    const res = { status: page.status };
    const size = page.truncated ? web.maxBytes + 1 : page.body.length;
    const raw = page.body.toString('utf8');
    const { title, text } = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : { title: '', text: raw };
    const max = input.maxChars ?? 50_000;
    return { url: input.url, finalUrl: url.toString(), status: res.status, contentType, title, text: text.slice(0, max), truncated: text.length > max || size > web.maxBytes };
  },
  async verify(_i, out) {
    if (out.status < 200 || out.status >= 300) return { ok: false, detail: `Server responded with HTTP ${out.status}` };
    return out.text.length ? { ok: true, detail: `HTTP ${out.status}, ${out.text.length} characters` } : { ok: false, detail: 'Page had no readable text' };
  },
  describe: (o) => `${o.title ? `${o.title}\n` : ''}${o.finalUrl} (HTTP ${o.status})\n\n${o.text}`,
};
