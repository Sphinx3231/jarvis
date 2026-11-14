import { lookup } from 'node:dns/promises';
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

async function assertPublic(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`Refusing to fetch private host ${host} (enable "allow private network" in Settings to permit)`);
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) throw new Error(`Refusing to fetch ${host}: it resolves to a private address (${a.address})`);
  }
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
    let res: Response | undefined;
    // Follow redirects manually so every hop is checked against the private-network rule.
    for (let hop = 0; hop < 5; hop++) {
      if (!web.allowPrivateNetwork) await assertPublic(url);
      res = await fetch(url, {
        redirect: 'manual',
        signal: ctx.signal,
        headers: { 'user-agent': 'Jarvis/1.0 (personal assistant)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url);
        if (!/^https?:$/.test(url.protocol)) throw new Error('Redirect to a non-HTTP URL was blocked');
        continue;
      }
      break;
    }
    if (!res) throw new Error('No response');
    if (res.status >= 300 && res.status < 400) throw new Error('Too many redirects');
    const contentType = res.headers.get('content-type') ?? '';
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        chunks.push(value);
        if (size > web.maxBytes) {
          await reader.cancel();
          break;
        }
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
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
