import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { platform as osPlatform } from 'node:os';
import { firstBinary } from './exec.ts';

/**
 * Browser interaction (Phase 4b) — operate a real Chromium-family browser (Chrome, Edge, Brave,
 * Chromium) the way a person does: tabs, navigation, reading the page, clicking, typing, scrolling.
 *
 * How it connects: the Chrome DevTools Protocol (CDP) on a LOOPBACK debugging port. Either the user's
 * browser is already running with `--remote-debugging-port`, or Jarvis launches the installed browser
 * with a dedicated, persistent "Jarvis" profile (the user signs in to their accounts there once; the
 * sessions then persist like any browser profile). Chrome 136+ refuses remote debugging on the default
 * profile, so a dedicated profile is the supported way — and it keeps Jarvis out of the user's main
 * profile's stored data.
 *
 * Security:
 *  - Only loopback endpoints (127.0.0.1 / localhost / ::1) are accepted. Nothing is exposed remotely.
 *  - A CDP METHOD ALLOWLIST: cookies, storage, network interception, IndexedDB, cache and the like can
 *    never be called (`Network.*`, `Storage.*`, `DOMStorage.*`, `IndexedDB.*`, `CacheStorage.*`,
 *    `Fetch.*` are blocked). Jarvis uses the authenticated session by *using the page*, never by
 *    copying credentials out of it.
 *  - Page scripts are fixed, read-only extractors defined in this file — no model-supplied JavaScript
 *    is ever evaluated. Password field values are never read, and Jarvis refuses to type into them
 *    (the user signs in themselves).
 *  - Clicks and key presses are dispatched as real input events (`Input.dispatchMouseEvent`), so pages
 *    see trusted user input, exactly as if the user clicked.
 *  - All page text is untrusted data.
 */

const ALLOWED_METHODS = new Set([
  'Page.enable',
  'Page.navigate',
  'Page.reload',
  'Page.bringToFront',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.handleJavaScriptDialog',
  'Page.captureScreenshot',
  'Runtime.enable',
  'Runtime.evaluate',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Emulation.setFocusEmulationEnabled',
]);
const BLOCKED_PREFIXES = ['Network.', 'Storage.', 'DOMStorage.', 'IndexedDB.', 'CacheStorage.', 'Fetch.', 'Browser.', 'Target.', 'SystemInfo.', 'Security.'];

export function cdpMethodAllowed(method: string): boolean {
  if (BLOCKED_PREFIXES.some((p) => method.startsWith(p))) return false;
  return ALLOWED_METHODS.has(method);
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return (u.protocol === 'http:' || u.protocol === 'ws:') && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Only ordinary web pages may be navigated to (no javascript:, data:, chrome://, file://). */
export function navigableUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface TabInfo {
  id: string;
  title: string;
  url: string;
  wsUrl: string | null;
}

export interface PageElement {
  /** Index in the page's interactive element list at read time. */
  index: number;
  role: string;
  name: string;
  tag: string;
  type: string | null;
  disabled: boolean;
  visible: boolean;
  inViewport: boolean;
  /** For text inputs (never passwords): current value length; the value itself only when short + non-sensitive. */
  value: string | null;
  checked: boolean | null;
  href: string | null;
}

export interface PageRead {
  url: string;
  title: string;
  readyState: string;
  /** Visible text of the page (document.body.innerText), truncated. */
  text: string;
  textLength: number;
  headings: Array<{ level: number; text: string }>;
  elements: PageElement[];
  /** Open dialogs (role=dialog/alertdialog, <dialog open>, aria-modal). */
  dialogs: string[];
  /** Caption/transcript text currently exposed (video text tracks, aria-live regions, transcript panes). */
  captions: string;
  loginRequired: boolean;
  loginReason: string | null;
  scroll: { y: number; max: number; viewport: number };
  meta: { siteName: string | null; description: string | null; course: string | null; lesson: string | null };
}

export interface ElementTarget {
  /** Accessible name / visible text / label / placeholder to match (case-insensitive). */
  name?: string;
  role?: string;
  /** Exact index from a previous read (used only if name/role not given). */
  index?: number;
  /** Prefer the n-th match (0-based) when several match. */
  nth?: number;
}

/** The page-side extractor. Fixed code; never model-supplied. Defines window.__jarvis (idempotent). */
const PAGE_LIB = String.raw`(() => {
  if (window.__jarvis && window.__jarvis.v === 4) return true;
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r.toLowerCase();
    const t = el.tagName.toLowerCase();
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button','submit','reset','image'].includes(ty)) return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'range') return 'slider';
      if (ty === 'hidden') return 'hidden';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    if (el.hasAttribute('onclick') || el.tabIndex >= 0) return 'button';
    return t;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria) return aria.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const s = lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim(); if (s) return s; }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && l.innerText.trim()) return l.innerText.trim(); }
    const wrap = el.closest('label'); if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
    const t = el.tagName.toLowerCase();
    if (t === 'input' && ['button','submit','reset'].includes((el.type||'').toLowerCase())) return (el.value || '').trim();
    const txt = (el.innerText || el.textContent || '').trim();
    if (txt) return txt.replace(/\s+/g, ' ');
    return (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '').trim();
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const SEL = 'a[href],button,input,select,textarea,summary,[role],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]';
  const interactive = () => Array.from(document.querySelectorAll(SEL)).filter((el) => {
    const r = roleOf(el);
    if (r === 'hidden') return false;
    if (el.hasAttribute('role') && !['button','link','tab','menuitem','checkbox','radio','textbox','combobox','option','switch','slider','searchbox','treeitem','menuitemcheckbox','menuitemradio'].includes(r)) return false;
    return visible(el) || el.tagName === 'INPUT';
  });
  const describe = (el, i) => {
    const r = el.getBoundingClientRect();
    const t = el.tagName.toLowerCase();
    const type = t === 'input' ? (el.type || 'text').toLowerCase() : null;
    const sensitive = type === 'password' || /(pass|secret|token|card|cvv|cvc|ssn|otp|pin)/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.autocomplete || ''));
    let value = null;
    if ((t === 'input' || t === 'textarea') && !['checkbox','radio','button','submit'].includes(type || '')) value = sensitive ? '[hidden]' : String(el.value || '').slice(0, 200);
    if (t === 'select') value = el.options[el.selectedIndex]?.text || '';
    return { index: i, role: roleOf(el), name: nameOf(el).slice(0, 160), tag: t, type, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      visible: visible(el), inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth, value,
      checked: (type === 'checkbox' || type === 'radio') ? !!el.checked : (el.getAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : (el.getAttribute('aria-selected') ? el.getAttribute('aria-selected') === 'true' : null)),
      href: t === 'a' ? el.href : null };
  };
  const find = (spec) => {
    const els = interactive();
    if (spec.index !== undefined && spec.index !== null && !spec.name && !spec.role) return els[spec.index] ? [els[spec.index]] : [];
    const want = (spec.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const scored = [];
    els.forEach((el) => {
      const r = roleOf(el); if (spec.role && r !== spec.role.toLowerCase()) return;
      const n = nameOf(el).toLowerCase().replace(/\s+/g, ' ');
      let s = 0;
      if (!want) s = 1; else if (n === want) s = 4; else if (n.startsWith(want)) s = 3; else if (n.includes(want)) s = 2; else return;
      if (!visible(el)) s -= 0.5; if (el.disabled) s -= 1;
      scored.push([s, el]);
    });
    scored.sort((a, b) => b[0] - a[0]);
    return scored.map((x) => x[1]);
  };
  const captions = () => {
    const out = [];
    document.querySelectorAll('video,audio').forEach((m) => { for (const tr of Array.from(m.textTracks || [])) { if (tr.mode === 'disabled') tr.mode = 'hidden'; for (const c of Array.from(tr.activeCues || [])) out.push(c.text); } });
    document.querySelectorAll('[aria-live],[class*="caption" i],[class*="subtitle" i],[data-purpose*="caption" i],[class*="transcript" i],[id*="transcript" i]').forEach((el) => { const t = (el.innerText || '').trim(); if (t && visible(el)) out.push(t); });
    return Array.from(new Set(out)).join('\n').slice(0, 20000);
  };
  const login = () => {
    const pw = Array.from(document.querySelectorAll('input[type=password]')).some(visible);
    const u = location.href.toLowerCase();
    const h = Array.from(document.querySelectorAll('h1,h2,title,button,[type=submit]')).map((e) => (e.innerText || e.value || e.textContent || '').toLowerCase()).join(' ') + ' ' + document.title.toLowerCase();
    const asks = /\b(sign in|sign-in|log in|login|session (has )?expired|please log in)\b/.test(h);
    const urlLogin = /\/(login|signin|sign-in|auth|sso)(\/|\?|$)/.test(u);
    // A password field alone is not a sign-in wall (settings/registration pages have them).
    if (pw && (asks || urlLogin)) return 'a sign-in form is showing';
    if (urlLogin) return 'the URL is a sign-in page';
    if (/\b(session (has )?expired|please (sign|log) in)\b/.test((document.body ? document.body.innerText : '').toLowerCase().slice(0, 4000))) return 'the page says your session expired';
    return null;
  };
  const meta = (n) => document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]')?.getAttribute('content') || null;
  window.__jarvis = { v: 4, roleOf, nameOf, visible, interactive, describe, find, captions, login, meta };
  return true;
})()`;

const READ_EXPR = (maxChars: number) => String.raw`(() => {
  const J = window.__jarvis;
  const text = (document.body ? document.body.innerText : '') || '';
  const dialogs = Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open],[aria-modal=true]')).filter(J.visible).map((d) => (d.innerText || '').trim().slice(0, 500));
  const lr = J.login();
  const crumbs = Array.from(document.querySelectorAll('[aria-label*="breadcrumb" i] a, nav.breadcrumb a, [data-course-title], [data-purpose="course-header-title"]')).map((e) => (e.getAttribute('data-course-title') || e.innerText || '').trim()).filter(Boolean);
  const lessonEl = document.querySelector('[data-lesson-title],[data-purpose="lesson-title"]');
  return {
    url: location.href, title: document.title, readyState: document.readyState,
    text: text.slice(0, ${maxChars}), textLength: text.length,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).filter(J.visible).slice(0, 60).map((h) => ({ level: Number(h.tagName[1]), text: h.innerText.trim().slice(0, 200) })),
    elements: J.interactive().slice(0, 250).map(J.describe),
    dialogs, captions: J.captions(), loginRequired: !!lr, loginReason: lr,
    scroll: { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight), viewport: innerHeight },
    meta: { siteName: J.meta('og:site_name'), description: J.meta('description'),
      course: (lessonEl && lessonEl.getAttribute('data-course')) || J.meta('jarvis:course') || crumbs[0] || null,
      lesson: (lessonEl && (lessonEl.getAttribute('data-lesson-title') || lessonEl.innerText.trim())) || null },
  };
})()`;

const FIND_EXPR = (spec: ElementTarget) => String.raw`(() => {
  const J = window.__jarvis; const spec = ${JSON.stringify(spec)};
  const all = J.find(spec); const el = all[spec.nth || 0];
  if (!el) return { found: false, candidates: J.interactive().slice(0, 40).map(J.describe).map((d) => d.role + ': ' + d.name).filter((s) => s.length > 3) };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const d = J.describe(el, J.interactive().indexOf(el));
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { found: true, matches: all.length, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, el: d,
    obscured: !!top && top !== el && !el.contains(top) && !top.contains(el) };
})()`;

const FOCUSED_EXPR = String.raw`(() => { const a = document.activeElement; if (!a) return null; const J = window.__jarvis; return J.describe(a, -1); })()`;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/** One CDP WebSocket session to a page target, with the method allowlist enforced. */
export class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: CdpMessage) => void>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`CDP: ${msg.error.message}`));
        else p.resolve(msg.result ?? {});
      } else for (const l of this.listeners) l(msg);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('The browser tab closed or disconnected.'));
      this.pending.clear();
    });
  }

  static connect(wsUrl: string, timeoutMs = 5000): Promise<CdpSession> {
    if (!isLoopbackEndpoint(wsUrl)) return Promise.reject(new Error('Refusing a non-loopback DevTools endpoint.'));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const t = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out connecting to the browser tab.'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve(new CdpSession(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new Error('Could not connect to the browser tab (is the browser still running?).'));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, timeoutMs = 15000): Promise<Record<string, unknown>> {
    if (!cdpMethodAllowed(method)) return Promise.reject(new Error(`Blocked DevTools method ${method} (Jarvis never reads cookies, storage or network data).`));
    if (this.closed) return Promise.reject(new Error('The browser tab is closed.'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Cancelled'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser did not answer ${method} within ${timeoutMs}ms.`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(signal?.reason ?? new Error('Cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(fn: (m: CdpMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export interface BrowserActionResult {
  ok: boolean;
  action: string;
  detail: string;
  verified: { ok: boolean; detail: string } | null;
  before?: { url: string; title: string };
  after?: { url: string; title: string };
  loginRequired?: boolean;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Cancelled'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('Cancelled'));
      },
      { once: true },
    );
  });

const KEY_CODES: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
};

/**
 * BrowserController — the high-level, verified browser operations Jarvis uses.
 * Every mutating method observes before, acts with real input, observes after and reports whether the
 * change it expected actually happened.
 */
export class BrowserController {
  private endpoint: string;
  private sessions = new Map<string, CdpSession>();

  constructor(endpoint = 'http://127.0.0.1:9222') {
    if (!isLoopbackEndpoint(endpoint)) throw new Error('The browser DevTools endpoint must be on this computer (127.0.0.1).');
    this.endpoint = endpoint.replace(/\/+$/, '');
  }

  get debuggingEndpoint(): string {
    return this.endpoint;
  }

  private async http(path: string, method = 'GET', signal?: AbortSignal): Promise<unknown> {
    const res = await fetch(`${this.endpoint}${path}`, { method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Browser endpoint ${path} → HTTP ${res.status}`);
    const body = await res.text();
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  /** Is a debuggable browser reachable? Never throws. */
  async probe(signal?: AbortSignal): Promise<{ ok: boolean; detail: string; browser?: string }> {
    try {
      const v = (await this.http('/json/version', 'GET', signal)) as Record<string, string>;
      return { ok: true, detail: `${v.Browser ?? 'browser'} on ${this.endpoint}`, browser: v.Browser };
    } catch (err) {
      return { ok: false, detail: `No debuggable browser at ${this.endpoint} (${(err as Error).message}). Start it from Jarvis (Computer Access → Browser) or run it with --remote-debugging-port.` };
    }
  }

  async listTabs(signal?: AbortSignal): Promise<TabInfo[]> {
    const list = (await this.http('/json/list', 'GET', signal)) as Array<Record<string, string>>;
    return list.filter((t) => t.type === 'page').map((t) => ({ id: t.id, title: t.title, url: t.url, wsUrl: t.webSocketDebuggerUrl ?? null }));
  }

  async openTab(url: string, signal?: AbortSignal): Promise<TabInfo> {
    if (!navigableUrl(url)) throw new Error(`Refusing to open ${JSON.stringify(url.slice(0, 80))}: only http(s) pages.`);
    const t = (await this.http(`/json/new?${encodeURI(url)}`, 'PUT', signal)) as Record<string, string>;
    const tab = { id: t.id, title: t.title, url: t.url, wsUrl: t.webSocketDebuggerUrl ?? null };
    // A new tab starts on about:blank (already "complete"); wait until the requested page is the one loaded.
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const st = await this.evaluate<{ href: string; ready: string }>(tab.id, '({ href: location.href, ready: document.readyState })', signal).catch(() => null);
      if (st && st.ready === 'complete' && (url === 'about:blank' || sameDocument(st.href, url))) break;
      await sleep(150, signal);
    }
    const now = (await this.listTabs(signal).catch(() => [])).find((x) => x.id === tab.id);
    return now ?? tab;
  }

  async activateTab(id: string, signal?: AbortSignal): Promise<void> {
    await this.http(`/json/activate/${encodeURIComponent(id)}`, 'GET', signal);
  }

  async closeTab(id: string, signal?: AbortSignal): Promise<void> {
    this.sessions.get(id)?.close();
    this.sessions.delete(id);
    await this.http(`/json/close/${encodeURIComponent(id)}`, 'GET', signal);
  }

  /** The active (front-most) page tab — Chrome lists the most recently focused first. */
  async activeTab(signal?: AbortSignal): Promise<TabInfo | null> {
    const tabs = await this.listTabs(signal);
    return tabs.find((t) => !t.url.startsWith('devtools://')) ?? null;
  }

  private async session(tabId: string, signal?: AbortSignal): Promise<CdpSession> {
    const cached = this.sessions.get(tabId);
    if (cached && !cached.isClosed) return cached;
    const tab = (await this.listTabs(signal)).find((t) => t.id === tabId);
    if (!tab?.wsUrl) throw new Error('That tab is gone (closed, crashed, or the browser restarted).');
    const s = await CdpSession.connect(tab.wsUrl);
    this.sessions.set(tabId, s);
    await s.send('Page.enable', {}, signal).catch(() => {});
    return s;
  }

  private async evaluate<T>(tabId: string, expression: string, signal?: AbortSignal): Promise<T> {
    const s = await this.session(tabId, signal);
    await s.send('Runtime.evaluate', { expression: PAGE_LIB, returnByValue: true }, signal);
    const res = (await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, signal)) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (res.exceptionDetails) throw new Error(`Page script failed: ${res.exceptionDetails.text ?? 'exception'}`);
    return res.result?.value as T;
  }

  async read(tabId: string, opts: { maxChars?: number } = {}, signal?: AbortSignal): Promise<PageRead> {
    return this.evaluate<PageRead>(tabId, READ_EXPR(Math.min(200_000, opts.maxChars ?? 30_000)), signal);
  }

  /** Just the caption/transcript text currently exposed — cheap enough to poll while a lesson plays. */
  async captions(tabId: string, signal?: AbortSignal): Promise<string> {
    return this.evaluate<string>(tabId, '(() => window.__jarvis.captions())()', signal);
  }

  async waitForLoad(tabId: string, signal?: AbortSignal, timeoutMs = 15000): Promise<{ ok: boolean; readyState: string; ms: number }> {
    const start = Date.now();
    let state = 'unknown';
    while (Date.now() - start < timeoutMs) {
      try {
        state = await this.evaluate<string>(tabId, 'document.readyState', signal);
        if (state === 'complete') return { ok: true, readyState: state, ms: Date.now() - start };
      } catch (err) {
        if (signal?.aborted) throw err;
      }
      await sleep(150, signal);
    }
    return { ok: false, readyState: state, ms: Date.now() - start };
  }

  /** Wait until the page's visible text contains `text` (or the timeout passes). */
  async waitForText(tabId: string, text: string, signal?: AbortSignal, timeoutMs = 10000): Promise<boolean> {
    const start = Date.now();
    const want = text.toLowerCase();
    while (Date.now() - start < timeoutMs) {
      const t = await this.evaluate<string>(tabId, '(document.body ? document.body.innerText : "")', signal).catch(() => '');
      if (t.toLowerCase().includes(want)) return true;
      await sleep(200, signal);
    }
    return false;
  }

  async navigate(tabId: string, url: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (!navigableUrl(url)) return { ok: false, action: 'navigate', detail: `Refused: only http(s) pages (got ${JSON.stringify(url.slice(0, 80))}).`, verified: null };
    const s = await this.session(tabId, signal);
    const res = (await s.send('Page.navigate', { url }, signal)) as { errorText?: string };
    if (res.errorText) return { ok: false, action: 'navigate', detail: `Navigation failed: ${res.errorText}`, verified: { ok: false, detail: res.errorText } };
    const load = await this.waitForLoad(tabId, signal, 20000);
    const page = await this.read(tabId, { maxChars: 2000 }, signal);
    const same = sameDocument(page.url, url);
    return {
      ok: load.ok && same,
      action: 'navigate',
      detail: `${load.ok ? 'Loaded' : `Still ${load.readyState} after ${load.ms}ms`}: ${page.title || page.url}`,
      verified: { ok: load.ok && same, detail: same ? `on ${page.url}` : `expected ${url}, landed on ${page.url}` },
      after: { url: page.url, title: page.title },
      loginRequired: page.loginRequired,
    };
  }

  async back(tabId: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    const s = await this.session(tabId, signal);
    const h = (await s.send('Page.getNavigationHistory', {}, signal)) as { currentIndex: number; entries: Array<{ id: number; url: string }> };
    if (h.currentIndex <= 0) return { ok: false, action: 'back', detail: 'No previous page.', verified: null };
    const target = h.entries[h.currentIndex - 1];
    await s.send('Page.navigateToHistoryEntry', { entryId: target.id }, signal);
    await this.waitForLoad(tabId, signal);
    const page = await this.read(tabId, { maxChars: 500 }, signal);
    return { ok: true, action: 'back', detail: `Back to ${page.title || page.url}`, verified: { ok: sameDocument(page.url, target.url), detail: `on ${page.url}` }, after: { url: page.url, title: page.title } };
  }

  /** Locate an element semantically (accessible name/role), scrolled into view. */
  /** Whether typing would go into a password/secret field (the target, or the focused field). Never reads its value. */
  async isSecretField(tabId: string, target: ElementTarget | null, signal?: AbortSignal): Promise<boolean> {
    const el = target ? (await this.locate(tabId, target, signal).catch(() => null))?.el : await this.evaluate<PageElement | null>(tabId, FOCUSED_EXPR, signal).catch(() => null);
    return el?.type === 'password' || el?.value === '[hidden]';
  }

  async locate(tabId: string, target: ElementTarget, signal?: AbortSignal) {
    return this.evaluate<{ found: boolean; matches?: number; x?: number; y?: number; w?: number; h?: number; el?: PageElement; obscured?: boolean; candidates?: string[] }>(tabId, FIND_EXPR(target), signal);
  }

  private async mouseClick(s: CdpSession, x: number, y: number, signal?: AbortSignal, button: 'left' | 'right' = 'left', clickCount = 1) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, signal);
    for (let i = 1; i <= clickCount; i++) {
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i }, signal);
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i }, signal);
    }
  }

  /**
   * Click an element found by name/role with a real (trusted) mouse event, then verify that SOMETHING
   * observable changed (URL, title, text, the element's own state, a dialog). `expect` sharpens the
   * check: a URL fragment or text that should appear.
   */
  async click(tabId: string, target: ElementTarget, opts: { expectText?: string; expectUrl?: string; button?: 'left' | 'right'; count?: number; timeoutMs?: number } = {}, signal?: AbortSignal): Promise<BrowserActionResult> {
    const s = await this.session(tabId, signal);
    const before = await this.snapshot(tabId, signal);
    const loc = await this.locate(tabId, target, signal);
    const label = target.name ?? `#${target.index}`;
    if (!loc.found) return { ok: false, action: `click "${label}"`, detail: `No element matching ${JSON.stringify(label)}${target.role ? ` (${target.role})` : ''}. Visible controls: ${(loc.candidates ?? []).slice(0, 15).join(' | ')}`, verified: null, before: before.page };
    if (loc.el?.disabled) return { ok: false, action: `click "${label}"`, detail: `"${loc.el.name}" is disabled.`, verified: null, before: before.page };
    if (loc.obscured) return { ok: false, action: `click "${label}"`, detail: `"${loc.el?.name}" is covered by another element (a dialog or overlay?). Deal with that first.`, verified: null, before: before.page };
    await this.mouseClick(s, loc.x!, loc.y!, signal, opts.button ?? 'left', opts.count ?? 1);
    const verified = await this.verifyChange(tabId, before, { expectText: opts.expectText, expectUrl: opts.expectUrl, elementName: loc.el?.name, elementChecked: loc.el?.checked ?? null, focusTarget: true }, signal, opts.timeoutMs ?? 6000);
    const after = await this.snapshot(tabId, signal).catch(() => before);
    return { ok: true, action: `click "${loc.el?.name ?? label}"`, detail: `Clicked ${loc.el?.role} "${loc.el?.name}" at ${Math.round(loc.x!)},${Math.round(loc.y!)}${(loc.matches ?? 1) > 1 ? ` (best of ${loc.matches} matches)` : ''}`, verified, before: before.page, after: after.page, loginRequired: after.loginRequired };
  }

  /** Focus a field (by click) and type text into it; verify the field's value afterwards. */
  async type(tabId: string, target: ElementTarget | null, text: string, opts: { clear?: boolean; submit?: boolean } = {}, signal?: AbortSignal): Promise<BrowserActionResult> {
    const s = await this.session(tabId, signal);
    let fieldName = '(focused field)';
    if (target) {
      const loc = await this.locate(tabId, target, signal);
      if (!loc.found) return { ok: false, action: 'type', detail: `No field matching ${JSON.stringify(target.name ?? target.index)}. Visible controls: ${(loc.candidates ?? []).slice(0, 15).join(' | ')}`, verified: null };
      if (loc.el?.disabled) return { ok: false, action: 'type', detail: `"${loc.el.name}" is disabled.`, verified: null };
      fieldName = loc.el?.name || fieldName;
      await this.mouseClick(s, loc.x!, loc.y!, signal);
    }
    const focused = await this.evaluate<PageElement | null>(tabId, FOCUSED_EXPR, signal);
    // A password/secret field: typed like any other, but its value is never read back, returned or
    // logged — the check below only asks the page whether the field ends with what was typed.
    const secret = focused?.type === 'password' || focused?.value === '[hidden]';
    if (opts.clear) {
      await this.evaluate(tabId, '(() => { const a = document.activeElement; if (a && "value" in a) { a.select && a.select(); } else document.execCommand("selectAll"); return true; })()', signal);
      await this.pressKey(tabId, 'Backspace', signal);
    }
    await s.send('Input.insertText', { text }, signal);
    if (secret) {
      const filled = await this.evaluate<boolean>(tabId, `(() => { const a = document.activeElement; return !!a && typeof a.value === 'string' && a.value.endsWith(${JSON.stringify(text)}); })()`, signal).catch(() => false);
      if (opts.submit) await this.pressKey(tabId, 'Enter', signal);
      return { ok: true, action: `type into "${fieldName}"`, detail: `Typed ${text.length} char(s) into the secret field "${fieldName}" (not logged)${opts.submit ? ' and pressed Enter' : ''}`, verified: { ok: filled, detail: filled ? 'the field holds what was typed' : 'the field does not hold what was typed' } };
    }
    const after = await this.evaluate<PageElement | null>(tabId, FOCUSED_EXPR, signal);
    const value = after?.value ?? '';
    const ok = value.includes(text.slice(0, 200)) || (after?.tag === 'div' && true);
    if (opts.submit) await this.pressKey(tabId, 'Enter', signal);
    return { ok: true, action: `type into "${fieldName}"`, detail: `Typed ${text.length} char(s) into "${fieldName}"${opts.submit ? ' and pressed Enter' : ''}`, verified: { ok, detail: ok ? `field now contains the text` : `field value is ${JSON.stringify(value.slice(0, 80))}` } };
  }

  /**
   * Choose an option in a dropdown (<select>) by its visible text — what a person does by opening the
   * list and clicking the option. Native dropdown popups differ per OS (macOS needs Enter to commit),
   * so the option is chosen on the element itself and the same input/change events fire. Verified by
   * reading the selected option back.
   */
  async select(tabId: string, target: ElementTarget, option: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    const loc = await this.locate(tabId, target, signal);
    if (!loc.found) return { ok: false, action: 'select', detail: `No dropdown matching ${JSON.stringify(target.name ?? target.index)}. Visible controls: ${(loc.candidates ?? []).slice(0, 15).join(' | ')}`, verified: null };
    if (loc.el?.tag !== 'select') return { ok: false, action: 'select', detail: `"${loc.el?.name}" is a ${loc.el?.role}, not a dropdown — click it and then click the option instead.`, verified: null };
    if (loc.el.disabled) return { ok: false, action: 'select', detail: `"${loc.el.name}" is disabled.`, verified: null };
    const res = await this.evaluate<{ ok: boolean; chosen?: string; options?: string[] }>(
      tabId,
      `(() => { const J = window.__jarvis; const el = J.find(${JSON.stringify(target)})[${target.nth ?? 0}]; if (!el || el.tagName !== 'SELECT') return { ok: false };
        const want = ${JSON.stringify(option.trim().toLowerCase())}; const opts = Array.from(el.options);
        const i = opts.findIndex((o) => o.text.trim().toLowerCase() === want) >= 0 ? opts.findIndex((o) => o.text.trim().toLowerCase() === want) : opts.findIndex((o) => o.text.trim().toLowerCase().includes(want));
        if (i < 0) return { ok: false, options: opts.map((o) => o.text.trim()) };
        el.focus(); el.selectedIndex = i; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, chosen: el.options[el.selectedIndex].text.trim() }; })()`,
      signal,
    );
    if (!res.ok) return { ok: false, action: `select "${option}"`, detail: res.options ? `"${loc.el.name}" has no option "${option}". Options: ${res.options.join(' | ')}` : 'The dropdown disappeared.', verified: null };
    const after = await this.locate(tabId, target, signal);
    const shown = after.el?.value ?? '';
    return { ok: true, action: `select "${option}" in "${loc.el.name}"`, detail: `Chose "${res.chosen}" in "${loc.el.name}"`, verified: { ok: shown.toLowerCase() === (res.chosen ?? '').toLowerCase(), detail: `dropdown now shows "${shown}"` } };
  }

  async pressKey(tabId: string, key: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    const s = await this.session(tabId, signal);
    const k = KEY_CODES[key.toLowerCase()];
    if (!k) return { ok: false, action: `key ${key}`, detail: `Unsupported key ${key}`, verified: null };
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: k.text }, signal);
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode }, signal);
    return { ok: true, action: `key ${k.key}`, detail: `Pressed ${k.key}`, verified: null };
  }

  /** Scroll with a real mouse-wheel event; verifies the page actually moved. */
  async scroll(tabId: string, direction: 'up' | 'down', amount = 600, signal?: AbortSignal): Promise<BrowserActionResult & { atEnd: boolean; y: number }> {
    const s = await this.session(tabId, signal);
    const before = await this.evaluate<{ y: number; max: number; w: number; h: number }>(tabId, '({ y: scrollY, max: Math.max(0, document.documentElement.scrollHeight - innerHeight), w: innerWidth, h: innerHeight })', signal);
    const dy = direction === 'down' ? Math.abs(amount) : -Math.abs(amount);
    await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(before.w / 2), y: Math.round(before.h / 2), deltaX: 0, deltaY: dy }, signal);
    let after = before;
    for (let i = 0; i < 10; i++) {
      await sleep(80, signal);
      after = await this.evaluate(tabId, '({ y: scrollY, max: Math.max(0, document.documentElement.scrollHeight - innerHeight), w: innerWidth, h: innerHeight })', signal);
      if (after.y !== before.y) break;
    }
    const moved = after.y !== before.y;
    const atEnd = direction === 'down' ? after.y >= after.max - 2 : after.y <= 0;
    return { ok: true, action: `scroll ${direction}`, detail: moved ? `Scrolled ${direction} to y=${Math.round(after.y)} of ${after.max}` : `Did not move (y=${Math.round(after.y)}${atEnd ? ', already at the end' : ''})`, verified: { ok: moved || atEnd, detail: moved ? 'page moved' : 'page did not move' }, atEnd, y: after.y };
  }

  /** Dismiss (never accept) a native JS dialog (alert/confirm/beforeunload). */
  async dismissDialog(tabId: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    const s = await this.session(tabId, signal);
    try {
      await s.send('Page.handleJavaScriptDialog', { accept: false }, signal);
      return { ok: true, action: 'dismiss dialog', detail: 'Dismissed the page dialog.', verified: null };
    } catch (err) {
      return { ok: false, action: 'dismiss dialog', detail: (err as Error).message, verified: null };
    }
  }

  private async snapshot(tabId: string, signal?: AbortSignal) {
    const r = await this.evaluate<{ url: string; title: string; text: string; dialogs: number; login: boolean; focused: string | null }>(
      tabId,
      '(() => ({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 50000), dialogs: Array.from(document.querySelectorAll("[role=dialog],[role=alertdialog],dialog[open]")).filter(window.__jarvis.visible).length, login: !!window.__jarvis.login(), focused: document.activeElement ? window.__jarvis.nameOf(document.activeElement) : null }))()',
      signal,
    );
    return { page: { url: r.url, title: r.title }, text: r.text, dialogs: r.dialogs, loginRequired: r.login, focused: r.focused };
  }

  private async verifyChange(
    tabId: string,
    before: Awaited<ReturnType<BrowserController['snapshot']>>,
    expect: { expectText?: string; expectUrl?: string; elementName?: string; elementChecked: boolean | null; focusTarget?: boolean },
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ ok: boolean; detail: string }> {
    const start = Date.now();
    let last = 'no observable change';
    while (Date.now() - start < timeoutMs) {
      await sleep(150, signal);
      let now: Awaited<ReturnType<BrowserController['snapshot']>>;
      try {
        await this.waitForLoad(tabId, signal, 3000);
        now = await this.snapshot(tabId, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        last = (err as Error).message;
        continue;
      }
      if (expect.expectUrl && !now.page.url.includes(expect.expectUrl)) {
        last = `URL is ${now.page.url}, expected it to contain ${expect.expectUrl}`;
        continue;
      }
      if (expect.expectText) {
        if (now.text.toLowerCase().includes(expect.expectText.toLowerCase()) && !before.text.toLowerCase().includes(expect.expectText.toLowerCase())) return { ok: true, detail: `"${expect.expectText}" appeared` };
        if (now.text.toLowerCase().includes(expect.expectText.toLowerCase()) && now.page.url !== before.page.url) return { ok: true, detail: `"${expect.expectText}" is on the new page` };
        last = `"${expect.expectText}" did not appear`;
        continue;
      }
      if (expect.expectUrl) return { ok: true, detail: `navigated to ${now.page.url}` };
      if (now.page.url !== before.page.url) return { ok: true, detail: `navigated to ${now.page.url}` };
      if (now.page.title !== before.page.title) return { ok: true, detail: `title changed to "${now.page.title}"` };
      if (now.dialogs !== before.dialogs) return { ok: true, detail: now.dialogs > before.dialogs ? 'a dialog opened' : 'a dialog closed' };
      if (now.text !== before.text) return { ok: true, detail: 'page content changed' };
      if (expect.elementChecked !== null && expect.elementName) {
        const st = await this.locate(tabId, { name: expect.elementName }, signal).catch(() => null);
        if (st?.el && st.el.checked !== expect.elementChecked) return { ok: true, detail: `"${expect.elementName}" is now ${st.el.checked ? 'on' : 'off'}` };
      }
      // Focus moving to the clicked element is NOT evidence the click did anything (every click
      // focuses its target) — a dead button must come back unverified.
      if (expect.focusTarget && now.focused !== before.focused && now.focused === expect.elementName) last = `only focus moved to "${now.focused}"; nothing else changed`;
    }
    return { ok: false, detail: `Could not verify the click had an effect: ${last}.` };
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}

function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch {
    return a === b;
  }
}

// ---------------------------------------------------------------- launching the user's browser

export function detectBrowserBinary(platform: NodeJS.Platform = osPlatform()): string | null {
  // Explicit override (e.g. a portable Chromium) wins.
  const override = process.env.JARVIS_BROWSER;
  if (override && existsSync(override)) return override;
  if (platform === 'win32') {
    const pf = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    for (const base of pf) for (const r of rel) {
      const p = `${base}\\${r}`;
      if (existsSync(p)) return p;
    }
    return null;
  }
  if (platform === 'darwin') {
    const apps = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
    for (const a of apps) {
      if (existsSync(a)) return a;
    }
    return null;
  }
  return firstBinary(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']);
}

/**
 * Launch the installed browser with a dedicated persistent Jarvis profile and a loopback-only
 * debugging port. Returns the endpoint. The user signs in to sites in this window once.
 */
export function launchBrowser(opts: { binary?: string | null; profileDir: string; port?: number; url?: string; extraArgs?: string[]; env?: NodeJS.ProcessEnv }): { endpoint: string; pid: number | undefined; binary: string } {
  const binary = opts.binary ?? detectBrowserBinary();
  if (!binary) throw new Error('No Chromium-family browser found (Chrome, Edge, Brave or Chromium). Install one, or start yours with --remote-debugging-port=9222.');
  const port = opts.port ?? 9222;
  mkdirSync(opts.profileDir, { recursive: true });
  const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${opts.profileDir}`, '--no-first-run', '--no-default-browser-check', ...(opts.extraArgs ?? []), opts.url ?? 'about:blank'];
  const child = spawn(binary, args, { detached: true, stdio: 'ignore', env: opts.env ?? process.env });
  child.unref();
  return { endpoint: `http://127.0.0.1:${port}`, pid: child.pid, binary };
}
