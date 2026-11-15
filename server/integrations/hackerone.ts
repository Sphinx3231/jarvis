import { z } from 'zod';
import type { Database } from '../db/database.ts';
import type { EventBus } from '../core/events.ts';
import type { SecretStore } from '../core/secrets.ts';
import type { Settings, SettingsStore } from '../core/settings.ts';
import { errorMessage, newId, now } from '../core/util.ts';
import type { ActivityLog } from '../core/activity.ts';
import type { Skill } from '../skills/types.ts';

/**
 * The autonomous bug-bounty pipeline, read through HackerOne's Hacker API: your earnings, your
 * reports, and the programs you can hunt. Jarvis only observes and analyses — it discovers programs
 * and tracks money and report status. It never tests, scans or attacks anything from here; actual
 * work on a target is still a task that goes through your approvals.
 *
 * The API token is stored encrypted and sent only to HackerOne over HTTPS Basic auth. Nothing about
 * the pipeline is shared with the model unless you ask.
 */

export const HACKERONE_SECRET = 'hackerone:token';
const DEFAULT_API = 'https://api.hackerone.com/v1/hackers';
/** A program first seen within this window (and not part of the first bulk import) counts as newly discovered. */
const NEW_WINDOW_MS = 14 * 86_400_000;

type H1Config = Settings['integrations']['hackerone'];

export interface ProgramRow {
  handle: string;
  name: string;
  currency: string | null;
  offersBounties: boolean;
  state: string | null;
  url: string;
  firstSeen: number;
  lastSeen: number;
  isNew: boolean;
}

export interface ReportRow {
  id: string;
  title: string;
  state: string;
  program: string | null;
  severity: string | null;
  bounty: number | null;
  currency: string | null;
  createdAt: number | null;
}

export type Severity = 'none' | 'low' | 'medium' | 'high' | 'critical';
export const SEVERITIES: Severity[] = ['none', 'low', 'medium', 'high', 'critical'];

export interface ScopeRow {
  program: string;
  identifier: string;
  assetType: string | null;
  eligible: boolean;
  maxSeverity: string | null;
  instruction: string | null;
}

export interface SubmissionRow {
  id: string;
  program: string;
  title: string;
  asset: string | null;
  severity: string | null;
  scopeOk: boolean;
  scopeReason: string | null;
  autonomous: boolean;
  submitted: boolean;
  reportId: string | null;
  reportUrl: string | null;
  error: string | null;
  createdAt: number;
}

export interface SubmitInput {
  program: string;
  title: string;
  vulnerabilityInformation: string;
  severity: Severity;
  /** The asset the finding is on (domain, URL, package id…). Checked against the program's eligible scope. */
  asset: string;
  impact?: string;
  weaknessId?: number;
  structuredScopeId?: string;
}

export interface SubmitResult {
  ok: boolean;
  /** True when the submission was recorded but deliberately NOT sent (out of scope / not authorized). */
  held: boolean;
  reason: string;
  reportId: string | null;
  url: string | null;
  matchedScope: string | null;
  auditId: string;
}

export interface ScopeDecision {
  ok: boolean;
  matched: string | null;
  reason: string;
}

export interface PipelineSummary {
  connected: boolean;
  missing: string | null;
  enabled: boolean;
  autoRun: boolean;
  /** True when Jarvis is set to keep the pipeline running on its own. */
  running: boolean;
  intervalMin: number;
  bountyOnly: boolean;
  username: string;
  tokenSet: boolean;
  lastCheck: { ok: boolean; detail: string; at: number } | null;
  earnings: {
    currency: string;
    total: number;
    count: number;
    last30d: number;
    averageBounty: number;
    monthly: Array<{ month: string; amount: number }>;
  };
  reports: {
    total: number;
    byState: Record<string, number>;
    resolved: number;
    recent: ReportRow[];
  };
  programs: {
    total: number;
    bountyPaying: number;
    newCount: number;
    discovered: ProgramRow[];
  };
}

interface JsonApiItem {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id?: string; attributes?: Record<string, unknown> } | null }>;
}

const toNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const toTime = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
/** First defined, non-empty value among dotted paths into a JSON:API item. */
function pick(item: JsonApiItem, ...paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = item;
    for (const key of path.split('.')) {
      if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[key];
      else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const upper = (v: string | null): string | null => (v ? v.toUpperCase() : v);

export class HackerOneService {
  private settings: SettingsStore;
  private secrets: SecretStore;
  private db: Database;
  private activity: ActivityLog;
  private bus: EventBus;
  /** Test seam: a fetch that reaches the mock API. */
  fetchImpl: typeof fetch;
  lastCheck: { ok: boolean; detail: string; at: number } | null = null;

  constructor(deps: { settings: SettingsStore; secrets: SecretStore; db: Database; activity: ActivityLog; bus: EventBus; fetchImpl?: typeof fetch }) {
    this.settings = deps.settings;
    this.secrets = deps.secrets;
    this.db = deps.db;
    this.activity = deps.activity;
    this.bus = deps.bus;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  config(): H1Config {
    return this.settings.get().integrations.hackerone;
  }

  private baseUrl(): string {
    return (process.env.JARVIS_HACKERONE_API || DEFAULT_API).replace(/\/+$/, '');
  }

  /** Why the pipeline cannot run, or null when it is ready. */
  missing(): string | null {
    const c = this.config();
    if (!c.enabled) return 'The bug-bounty pipeline is turned off (Integrations → HackerOne).';
    if (!c.username.trim()) return 'Your HackerOne username is not set.';
    if (!this.hasToken()) return 'Your HackerOne API token is not set.';
    return null;
  }

  hasToken(): boolean {
    return Boolean(this.secrets.get(HACKERONE_SECRET)?.trim());
  }

  private authHeader(): string {
    const token = this.secrets.get(HACKERONE_SECRET) ?? '';
    return `Basic ${Buffer.from(`${this.config().username}:${token}`).toString('base64')}`;
  }

  private async get(pathOrUrl: string, signal?: AbortSignal): Promise<{ data: JsonApiItem[]; next: string | null }> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl()}${pathOrUrl}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { authorization: this.authHeader(), accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new Error(`Cannot reach HackerOne: ${errorMessage(err)}`);
    }
    if (res.status === 401) throw new Error('HackerOne rejected your username or API token (401). Check them in Integrations.');
    if (res.status === 403) throw new Error('HackerOne denied access (403). Make sure your account has API access enabled.');
    if (res.status === 429) throw new Error('HackerOne rate limit reached (429). Try again shortly.');
    const text = await res.text();
    if (!res.ok) throw new Error(`HackerOne API error (HTTP ${res.status}): ${text.slice(0, 200)}`);
    let body: { data?: unknown; links?: { next?: unknown } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('HackerOne returned a response that was not JSON.');
    }
    const data = Array.isArray(body.data) ? (body.data as JsonApiItem[]) : body.data ? [body.data as JsonApiItem] : [];
    return { data, next: typeof body.links?.next === 'string' ? body.links.next : null };
  }

  /** Follow JSON:API pagination, bounded so a huge account can't run forever. */
  private async getAll(path: string, opts: { max: number; signal?: AbortSignal }): Promise<JsonApiItem[]> {
    const out: JsonApiItem[] = [];
    let next: string | null = `${path}${path.includes('?') ? '&' : '?'}page[size]=100`;
    let pages = 0;
    while (next && out.length < opts.max && pages < 50) {
      const page = await this.get(next, opts.signal);
      out.push(...page.data);
      next = page.next;
      pages++;
    }
    return out.slice(0, opts.max);
  }

  async test(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    const missing = this.missing();
    if (missing) {
      this.lastCheck = { ok: false, detail: missing, at: now() };
      return { ok: false, detail: missing };
    }
    try {
      await this.get('/me/reports?page[size]=1', signal);
      this.lastCheck = { ok: true, detail: `Connected to HackerOne as ${this.config().username}`, at: now() };
    } catch (err) {
      this.lastCheck = { ok: false, detail: errorMessage(err), at: now() };
    }
    return { ok: this.lastCheck.ok, detail: this.lastCheck.detail };
  }

  // ---------------------------------------------------------------- syncing

  private syncPrograms(items: JsonApiItem[]): number {
    const ts = now();
    let discovered = 0;
    const tx = this.db;
    for (const it of items) {
      const handle = str(pick(it, 'attributes.handle', 'id'));
      if (!handle) continue;
      const name = str(pick(it, 'attributes.name')) ?? handle;
      const currency = str(pick(it, 'attributes.currency'));
      const offers = pick(it, 'attributes.offers_bounties') === true ? 1 : 0;
      const state = str(pick(it, 'attributes.submission_state', 'attributes.state'));
      const url = `https://hackerone.com/${handle}`;
      const existed = tx.get<{ handle: string }>('SELECT handle FROM h1_programs WHERE handle = ?', handle);
      if (!existed) discovered++;
      tx.run(
        `INSERT INTO h1_programs (handle, name, currency, offers_bounties, state, url, first_seen, last_seen, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET name = excluded.name, currency = excluded.currency, offers_bounties = excluded.offers_bounties, state = excluded.state, url = excluded.url, last_seen = excluded.last_seen`,
        handle,
        name,
        currency,
        offers,
        state,
        url,
        ts,
        ts,
        JSON.stringify(it.attributes ?? {}),
      );
    }
    return discovered;
  }

  private syncReports(items: JsonApiItem[]): number {
    const ts = now();
    for (const it of items) {
      const id = str(it.id);
      if (!id) continue;
      this.db.run(
        `INSERT INTO h1_reports (id, title, state, program, severity, bounty, currency, created_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, state = excluded.state, program = excluded.program, severity = excluded.severity, bounty = excluded.bounty, currency = excluded.currency, synced_at = excluded.synced_at`,
        id,
        str(pick(it, 'attributes.title')) ?? '(untitled)',
        str(pick(it, 'attributes.state')) ?? 'unknown',
        str(pick(it, 'relationships.program.data.attributes.handle', 'attributes.program')),
        str(pick(it, 'relationships.severity.data.attributes.rating', 'attributes.severity_rating')),
        toNum(pick(it, 'attributes.bounty_amount', 'relationships.bounties.data.0.attributes.amount')),
        str(pick(it, 'attributes.currency')),
        toTime(pick(it, 'attributes.created_at', 'attributes.submitted_at')),
        ts,
      );
    }
    return items.length;
  }

  private syncEarnings(items: JsonApiItem[]): number {
    const ts = now();
    for (const it of items) {
      const id = str(it.id);
      const amount = toNum(pick(it, 'attributes.amount', 'attributes.bounty_amount'));
      if (!id || amount === null) continue;
      this.db.run(
        `INSERT INTO h1_earnings (id, amount, currency, program, report_id, awarded_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, program = excluded.program, awarded_at = excluded.awarded_at, synced_at = excluded.synced_at`,
        id,
        amount,
        str(pick(it, 'attributes.currency')),
        str(pick(it, 'relationships.program.data.attributes.handle', 'attributes.program')),
        str(pick(it, 'relationships.report.data.id', 'attributes.report_id')),
        toTime(pick(it, 'attributes.awarded_at', 'attributes.created_at', 'attributes.bounty_awarded_at')),
        ts,
      );
    }
    return items.length;
  }

  /** Pull everything once and record what changed. One source failing does not stop the others. */
  async sync(signal?: AbortSignal): Promise<{ ok: boolean; detail: string; discovered: number }> {
    const missing = this.missing();
    if (missing) {
      this.lastCheck = { ok: false, detail: missing, at: now() };
      return { ok: false, detail: missing, discovered: 0 };
    }
    const notes: string[] = [];
    let discovered = 0;
    let ok = true;
    const run = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        ok = false;
        notes.push(`${label} failed: ${errorMessage(err)}`);
      }
    };
    await run('programs', async () => {
      discovered = this.syncPrograms(await this.getAll('/programs', { max: 1000, signal }));
      notes.push(`${discovered} new program(s)`);
    });
    await run('reports', async () => {
      const n = this.syncReports(await this.getAll('/me/reports', { max: 1000, signal }));
      notes.push(`${n} report(s)`);
    });
    await run('earnings', async () => {
      const n = this.syncEarnings(await this.getAll('/payments/earnings', { max: 2000, signal }));
      notes.push(`${n} earning(s)`);
    });
    this.lastCheck = { ok, detail: notes.join(', '), at: now() };
    if (discovered) this.activity.log('success', 'pipeline', `Discovered ${discovered} new HackerOne program(s)`);
    this.bus.emit('pipeline.updated', {});
    return { ok, detail: this.lastCheck.detail, discovered };
  }

  // ---------------------------------------------------------------- reading

  private mapProgram(r: Record<string, unknown>, baseline: number): ProgramRow {
    const firstSeen = Number(r.first_seen);
    return {
      handle: String(r.handle),
      name: String(r.name),
      currency: upper((r.currency as string | null) ?? null),
      offersBounties: Number(r.offers_bounties) === 1,
      state: (r.state as string | null) ?? null,
      url: String(r.url),
      firstSeen,
      lastSeen: Number(r.last_seen),
      isNew: firstSeen > baseline && now() - firstSeen < NEW_WINDOW_MS,
    };
  }

  /** The earliest time any program was seen: everything from the first bulk import shares it, so it is the baseline. */
  private programBaseline(): number {
    return Number(this.db.get<{ m: number }>('SELECT MIN(first_seen) AS m FROM h1_programs')?.m ?? now());
  }

  programs(opts: { query?: string; bountyOnly?: boolean; newOnly?: boolean; limit?: number } = {}): ProgramRow[] {
    const baseline = this.programBaseline();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.query) {
      where.push('(handle LIKE ? OR name LIKE ?)');
      params.push(`%${opts.query}%`, `%${opts.query}%`);
    }
    if (opts.bountyOnly) where.push('offers_bounties = 1');
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM h1_programs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY first_seen DESC, name ASC LIMIT ?`,
      ...params,
      Math.min(opts.limit ?? 100, 500),
    );
    let out = rows.map((r) => this.mapProgram(r, baseline));
    if (opts.newOnly) out = out.filter((p) => p.isNew);
    return out;
  }

  reports(opts: { state?: string; limit?: number } = {}): ReportRow[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM h1_reports ${opts.state ? 'WHERE state = ?' : ''} ORDER BY created_at DESC NULLS LAST, synced_at DESC LIMIT ?`,
      ...(opts.state ? [opts.state] : []),
      Math.min(opts.limit ?? 50, 200),
    );
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      state: String(r.state),
      program: (r.program as string | null) ?? null,
      severity: (r.severity as string | null) ?? null,
      bounty: r.bounty === null ? null : Number(r.bounty),
      currency: upper((r.currency as string | null) ?? null),
      createdAt: r.created_at === null ? null : Number(r.created_at),
    }));
  }

  summary(): PipelineSummary {
    const c = this.config();
    const earnRows = this.db.all<{ amount: number; currency: string | null; awarded_at: number | null }>('SELECT amount, currency, awarded_at FROM h1_earnings');
    const currency = upper(earnRows.find((e) => e.currency)?.currency ?? null) ?? 'USD';
    const total = earnRows.reduce((s, e) => s + e.amount, 0);
    const monthMap = new Map<string, number>();
    const cutoff30 = now() - 30 * 86_400_000;
    let last30 = 0;
    for (const e of earnRows) {
      if (e.awarded_at && e.awarded_at >= cutoff30) last30 += e.amount;
      const month = e.awarded_at ? new Date(e.awarded_at).toISOString().slice(0, 7) : 'unknown';
      monthMap.set(month, (monthMap.get(month) ?? 0) + e.amount);
    }
    const monthly = [...monthMap.entries()]
      .filter(([m]) => m !== 'unknown')
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }));

    const stateRows = this.db.all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM h1_reports GROUP BY state');
    const byState: Record<string, number> = {};
    for (const r of stateRows) byState[r.state] = r.n;
    const reportsTotal = stateRows.reduce((s, r) => s + r.n, 0);

    const programsTotal = Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM h1_programs')?.n ?? 0);
    const bountyPaying = Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM h1_programs WHERE offers_bounties = 1')?.n ?? 0);
    const discovered = this.programs({ newOnly: true, bountyOnly: c.bountyOnly, limit: 50 });

    return {
      connected: this.missing() === null,
      missing: this.missing(),
      enabled: c.enabled,
      autoRun: c.autoRun,
      running: c.enabled && c.autoRun && this.missing() === null,
      intervalMin: c.intervalMin,
      bountyOnly: c.bountyOnly,
      username: c.username,
      tokenSet: this.hasToken(),
      lastCheck: this.lastCheck,
      earnings: {
        currency,
        total: Math.round(total * 100) / 100,
        count: earnRows.length,
        last30d: Math.round(last30 * 100) / 100,
        averageBounty: earnRows.length ? Math.round((total / earnRows.length) * 100) / 100 : 0,
        monthly,
      },
      reports: { total: reportsTotal, byState, resolved: byState.resolved ?? 0, recent: this.reports({ limit: 10 }) },
      programs: { total: programsTotal, bountyPaying, newCount: discovered.length, discovered },
    };
  }

  // ---------------------------------------------------------------- structured scopes (what is in scope)

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<JsonApiItem> {
    const url = `${this.baseUrl()}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: this.authHeader(), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`Cannot reach HackerOne: ${errorMessage(err)}`);
    }
    const text = await res.text();
    if (res.status === 401) throw new Error('HackerOne rejected your username or API token (401).');
    if (res.status === 403) throw new Error('HackerOne denied access (403). Your account may lack permission to submit to this program.');
    if (res.status === 429) throw new Error('HackerOne rate limit reached (429). Try again shortly.');
    if (!res.ok) throw new Error(`HackerOne API error (HTTP ${res.status}): ${text.slice(0, 300)}`);
    let parsed: { data?: JsonApiItem } | JsonApiItem;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('HackerOne returned a response that was not JSON.');
    }
    return (parsed as { data?: JsonApiItem }).data ?? (parsed as JsonApiItem);
  }

  /** Fetch and store a program's structured scopes. */
  async syncScopes(handle: string, signal?: AbortSignal): Promise<number> {
    const h = handle.trim().toLowerCase();
    const items = await this.getAll(`/programs/${encodeURIComponent(h)}/structured_scopes`, { max: 1000, signal });
    const ts = now();
    let n = 0;
    for (const it of items) {
      const identifier = str(pick(it, 'attributes.asset_identifier', 'attributes.identifier'));
      if (!identifier) continue;
      this.db.run(
        `INSERT INTO h1_scopes (program, identifier, asset_type, eligible, max_severity, instruction, raw, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(program, identifier) DO UPDATE SET asset_type = excluded.asset_type, eligible = excluded.eligible, max_severity = excluded.max_severity, instruction = excluded.instruction, raw = excluded.raw, synced_at = excluded.synced_at`,
        h,
        identifier,
        str(pick(it, 'attributes.asset_type')),
        pick(it, 'attributes.eligible_for_submission') === true ? 1 : 0,
        str(pick(it, 'attributes.max_severity')),
        str(pick(it, 'attributes.instruction'))?.slice(0, 2000) ?? null,
        JSON.stringify(it.attributes ?? {}),
        ts,
      );
      n++;
    }
    this.bus.emit('pipeline.updated', {});
    return n;
  }

  /** Scopes known for a program (optionally refreshing when we have none or they are stale). */
  async ensureScopes(handle: string, signal?: AbortSignal): Promise<ScopeRow[]> {
    const h = handle.trim().toLowerCase();
    const fresh = this.db.get<{ n: number; newest: number }>('SELECT COUNT(*) AS n, MAX(synced_at) AS newest FROM h1_scopes WHERE program = ?', h);
    const stale = !fresh || fresh.n === 0 || now() - Number(fresh.newest ?? 0) > 6 * 3_600_000;
    if (stale) await this.syncScopes(h, signal).catch(() => {});
    return this.scopes(h);
  }

  scopes(handle: string): ScopeRow[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM h1_scopes WHERE program = ? ORDER BY eligible DESC, identifier ASC', handle.trim().toLowerCase())
      .map((r) => ({
        program: String(r.program),
        identifier: String(r.identifier),
        assetType: (r.asset_type as string | null) ?? null,
        eligible: Number(r.eligible) === 1,
        maxSeverity: (r.max_severity as string | null) ?? null,
        instruction: (r.instruction as string | null) ?? null,
      }));
  }

  private static hostOf(asset: string): string | null {
    const a = asset.trim();
    if (!a) return null;
    try {
      return new URL(a.includes('://') ? a : `https://${a}`).hostname.toLowerCase();
    } catch {
      return a.toLowerCase();
    }
  }

  /** Does `asset` match an in-scope identifier? Exact, host, and wildcard (*.example.com) matching. */
  private static matchScope(identifier: string, asset: string): boolean {
    const idL = identifier.trim().toLowerCase();
    const assetL = asset.trim().toLowerCase();
    if (!idL || !assetL) return false;
    if (idL === assetL) return true;
    const aHost = HackerOneService.hostOf(asset);
    const iHost = HackerOneService.hostOf(identifier);
    const wildcard = idL.startsWith('*.') ? idL.slice(2) : iHost && iHost.startsWith('*.') ? iHost.slice(2) : null;
    if (wildcard) return Boolean(aHost) && (aHost === wildcard || aHost!.endsWith(`.${wildcard}`));
    if (iHost && aHost) return iHost === aHost;
    return false;
  }

  /**
   * The in-scope gate. Fails CLOSED: if we have no eligible scope for the program, nothing is in
   * scope. This is the hard boundary that keeps autonomous submission inside a program's rules.
   */
  inScope(handle: string, asset: string): ScopeDecision {
    const h = handle.trim().toLowerCase();
    const eligible = this.scopes(h).filter((s) => s.eligible);
    if (!eligible.length) return { ok: false, matched: null, reason: `No eligible in-scope assets are known for "${h}". Sync the program's scopes before submitting.` };
    for (const s of eligible) {
      if (HackerOneService.matchScope(s.identifier, asset)) return { ok: true, matched: s.identifier, reason: `"${asset}" matches in-scope asset "${s.identifier}".` };
    }
    return { ok: false, matched: null, reason: `"${asset}" is not in "${h}"'s eligible scope (${eligible.length} in-scope asset(s)).` };
  }

  private recordSubmission(row: Omit<SubmissionRow, 'createdAt'>): void {
    this.db.run(
      `INSERT INTO h1_submissions (id, program, title, asset, severity, scope_ok, scope_reason, autonomous, submitted, report_id, report_url, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.program,
      row.title,
      row.asset,
      row.severity,
      row.scopeOk ? 1 : 0,
      row.scopeReason,
      row.autonomous ? 1 : 0,
      row.submitted ? 1 : 0,
      row.reportId,
      row.reportUrl,
      row.error,
      now(),
    );
    this.bus.emit('pipeline.updated', {});
  }

  submissions(limit = 50): SubmissionRow[] {
    return this.db.all<Record<string, unknown>>('SELECT * FROM h1_submissions ORDER BY created_at DESC LIMIT ?', Math.min(limit, 200)).map((r) => ({
      id: String(r.id),
      program: String(r.program),
      title: String(r.title),
      asset: (r.asset as string | null) ?? null,
      severity: (r.severity as string | null) ?? null,
      scopeOk: Number(r.scope_ok) === 1,
      scopeReason: (r.scope_reason as string | null) ?? null,
      autonomous: Number(r.autonomous) === 1,
      submitted: Number(r.submitted) === 1,
      reportId: (r.report_id as string | null) ?? null,
      reportUrl: (r.report_url as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      createdAt: Number(r.created_at),
    }));
  }

  /**
   * Submit a report to a program. Two hard gates, both fail closed:
   *   1. autonomous submission requires Full access + Offensive mode + Auto-submit all on;
   *   2. the asset must be in the program's eligible scope.
   * A blocked attempt is RECORDED (for the audit trail) but never sent. Nothing here is a model
   * guardrail — this is the authorization layer that keeps the traffic legitimate.
   */
  async submitReport(input: SubmitInput, opts: { autonomous?: boolean; signal?: AbortSignal } = {}): Promise<SubmitResult> {
    const missing = this.missing();
    if (missing) throw new Error(missing);
    const handle = input.program.trim().toLowerCase();
    const auditId = newId('sub');
    const base = { id: auditId, program: handle, title: input.title.slice(0, 300), asset: input.asset, severity: input.severity, autonomous: Boolean(opts.autonomous), reportId: null, reportUrl: null } as const;

    // Authorized target: must be a program Jarvis discovered in the pipeline.
    if (!this.db.get<{ handle: string }>('SELECT handle FROM h1_programs WHERE handle = ?', handle)) {
      this.recordSubmission({ ...base, scopeOk: false, scopeReason: 'unknown program', submitted: false, error: `"${handle}" is not a program in your pipeline.` });
      return { ok: false, held: true, reason: `"${handle}" is not a program in your pipeline (sync it first).`, reportId: null, url: null, matchedScope: null, auditId };
    }

    // Gate 1 — autonomous authorization.
    if (opts.autonomous) {
      const cfg = this.settings.get();
      if (!(cfg.permissions.fullAccess && cfg.agents.offensive && cfg.agents.autoSubmit)) {
        const reason = 'Autonomous submission needs Full access + Offensive mode + Auto-submit all ON.';
        this.recordSubmission({ ...base, scopeOk: false, scopeReason: reason, submitted: false, error: `held: ${reason}` });
        this.activity.log('warning', 'pipeline', `Held an autonomous report for ${handle}: ${reason}`);
        return { ok: false, held: true, reason, reportId: null, url: null, matchedScope: null, auditId };
      }
    }

    // Gate 2 — in scope (always, fail closed).
    await this.ensureScopes(handle, opts.signal).catch(() => {});
    const scope = this.inScope(handle, input.asset);
    if (!scope.ok) {
      this.recordSubmission({ ...base, scopeOk: false, scopeReason: scope.reason, submitted: false, error: `held: out of scope` });
      this.activity.log('warning', 'pipeline', `Held a report for ${handle} — out of scope: ${scope.reason}`);
      return { ok: false, held: true, reason: scope.reason, reportId: null, url: null, matchedScope: null, auditId };
    }

    // Submit.
    try {
      const attributes: Record<string, unknown> = {
        team_handle: handle,
        title: input.title.slice(0, 300),
        vulnerability_information: input.vulnerabilityInformation,
        severity_rating: input.severity,
      };
      if (input.impact) attributes.impact = input.impact;
      if (input.structuredScopeId) attributes.structured_scope_id = input.structuredScopeId;
      if (typeof input.weaknessId === 'number') attributes.weakness_id = input.weaknessId;
      const created = await this.post('/reports', { data: { type: 'report', attributes } }, opts.signal);
      const reportId = str(created.id);
      const url = reportId ? `https://hackerone.com/reports/${reportId}` : null;
      this.recordSubmission({ ...base, scopeOk: true, scopeReason: scope.reason, submitted: true, reportId, reportUrl: url, error: null });
      this.activity.log('success', 'pipeline', `Submitted a report to ${handle}${opts.autonomous ? ' (autonomous)' : ''}: "${input.title.slice(0, 80)}"${reportId ? ` → #${reportId}` : ''}`);
      return { ok: true, held: false, reason: `Submitted to ${handle} (in scope: ${scope.matched}).`, reportId, url, matchedScope: scope.matched, auditId };
    } catch (err) {
      const msg = errorMessage(err);
      this.recordSubmission({ ...base, scopeOk: true, scopeReason: scope.reason, submitted: false, error: msg });
      throw new Error(msg);
    }
  }
}

// ---------------------------------------------------------------- skills

export function hackeroneSkills(h1: HackerOneService): Skill[] {
  const available = () => (h1.missing() ? { available: false, reason: h1.missing() ?? undefined } : { available: true });
  const money = (n: number, c: string | null) => `${c ?? 'USD'} ${n.toLocaleString()}`;

  const ProgramsInput = z.object({
    query: z.string().max(100).optional().describe('Match program handle or name'),
    bountyOnly: z.boolean().optional().describe('Only programs that pay bounties'),
    newOnly: z.boolean().optional().describe('Only programs discovered recently'),
    limit: z.number().int().min(1).max(100).optional(),
  });
  const programs: Skill<z.infer<typeof ProgramsInput>, { programs: ProgramRow[] }> = {
    name: 'hackerone.programs',
    title: 'Search bug-bounty programs',
    description: 'Search the HackerOne programs Jarvis has discovered, including newly found ones and which pay bounties.',
    category: 'pipeline',
    scope: 'hackerone.read',
    risk: 'read',
    idempotent: true,
    inlineSafe: true,
    untrustedOutput: true,
    input: ProgramsInput,
    outputDescription: 'Matching programs with handle, name, bounty flag and when each was first seen.',
    timeoutMs: 15_000,
    dependsOn: 'HackerOne',
    availability: available,
    summarize: (i) => `Search bug-bounty programs${i.query ? ` for "${i.query}"` : ''}${i.newOnly ? ' (new)' : ''}${i.bountyOnly ? ' (paying)' : ''}`,
    execute: async (i) => ({ programs: h1.programs(i) }),
    async verify(_i, out) {
      return { ok: Array.isArray(out.programs), detail: `${out.programs.length} program(s)` };
    },
    describe: (o) =>
      o.programs.length
        ? o.programs.map((p) => `${p.isNew ? '★ ' : ''}${p.name} (${p.handle})${p.offersBounties ? ' — pays bounties' : ''} — ${p.url}`).join('\n')
        : 'No matching programs.',
  };

  const EarningsInput = z.object({});
  const earnings: Skill<z.infer<typeof EarningsInput>, PipelineSummary['earnings']> = {
    name: 'hackerone.earnings',
    title: 'Bug-bounty earnings',
    description: 'How much you have earned from HackerOne bounties: total, last 30 days, average and by month.',
    category: 'pipeline',
    scope: 'hackerone.read',
    risk: 'read',
    idempotent: true,
    inlineSafe: true,
    untrustedOutput: false,
    input: EarningsInput,
    outputDescription: 'Total, last-30-day, average and monthly bounty earnings.',
    timeoutMs: 10_000,
    dependsOn: 'HackerOne',
    availability: available,
    summarize: () => 'Summarise your bug-bounty earnings',
    execute: async () => h1.summary().earnings,
    async verify(_i, out) {
      return { ok: typeof out.total === 'number', detail: `${money(out.total, out.currency)} across ${out.count} bounty(ies)` };
    },
    describe: (o) =>
      `Total earned: ${money(o.total, o.currency)} from ${o.count} bounties (avg ${money(o.averageBounty, o.currency)}). Last 30 days: ${money(o.last30d, o.currency)}.`,
  };

  const ReportsInput = z.object({
    state: z.string().max(40).optional().describe('e.g. new, triaged, resolved, duplicate'),
    limit: z.number().int().min(1).max(100).optional(),
  });
  const reports: Skill<z.infer<typeof ReportsInput>, { reports: ReportRow[]; byState: Record<string, number> }> = {
    name: 'hackerone.reports',
    title: 'Bug-bounty reports',
    description: 'Your HackerOne reports and their states (new, triaged, resolved, duplicate…).',
    category: 'pipeline',
    scope: 'hackerone.read',
    risk: 'read',
    idempotent: true,
    inlineSafe: true,
    untrustedOutput: true,
    input: ReportsInput,
    outputDescription: 'Matching reports with title, state, program and bounty.',
    timeoutMs: 10_000,
    dependsOn: 'HackerOne',
    availability: available,
    summarize: (i) => `List your bug-bounty reports${i.state ? ` (${i.state})` : ''}`,
    execute: async (i) => ({ reports: h1.reports(i), byState: h1.summary().reports.byState }),
    async verify(_i, out) {
      return { ok: Array.isArray(out.reports), detail: `${out.reports.length} report(s)` };
    },
    describe: (o) =>
      [
        `By state: ${Object.entries(o.byState).map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}`,
        ...o.reports.map((r) => `[${r.state}] ${r.title}${r.program ? ` — ${r.program}` : ''}${r.bounty ? ` — ${r.currency ?? 'USD'} ${r.bounty}` : ''}`),
      ].join('\n'),
  };

  const ScopesInput = z.object({
    program: z.string().min(1).max(120).describe('Program handle'),
    refresh: z.boolean().optional().describe('Force a fresh fetch from HackerOne'),
  });
  const scopes: Skill<z.infer<typeof ScopesInput>, { program: string; scopes: ScopeRow[] }> = {
    name: 'hackerone.scopes',
    title: 'Program scope',
    description: "List a program's in-scope and out-of-scope assets — what you may test and report against. Used to check a finding is in scope before submitting.",
    category: 'pipeline',
    scope: 'hackerone.read',
    risk: 'read',
    idempotent: true,
    inlineSafe: true,
    untrustedOutput: true,
    input: ScopesInput,
    outputDescription: "The program's structured scopes, eligible (in-scope) first.",
    timeoutMs: 20_000,
    dependsOn: 'HackerOne',
    availability: available,
    summarize: (i) => `Show the scope of ${i.program}`,
    execute: async (i) => ({ program: i.program, scopes: i.refresh ? (await h1.syncScopes(i.program), h1.scopes(i.program)) : await h1.ensureScopes(i.program) }),
    async verify(_i, o) {
      return { ok: Array.isArray(o.scopes), detail: `${o.scopes.filter((s) => s.eligible).length} in scope, ${o.scopes.length} total` };
    },
    describe: (o) => (o.scopes.length ? o.scopes.map((s) => `${s.eligible ? '✓ in scope ' : '✗ out of scope'} ${s.identifier}${s.assetType ? ` [${s.assetType}]` : ''}${s.maxSeverity ? ` (max ${s.maxSeverity})` : ''}`).join('\n') : `No scopes known for ${o.program} yet.`),
  };

  const SubmitInputSchema = z.object({
    program: z.string().min(1).max(120).describe('Program handle (must be a program in your pipeline)'),
    title: z.string().min(3).max(300),
    vulnerabilityInformation: z.string().min(10).max(50_000).describe('Full writeup: summary, steps to reproduce, proof of concept, impact and remediation'),
    severity: z.enum(['none', 'low', 'medium', 'high', 'critical']),
    asset: z.string().min(1).max(500).describe('The affected asset (domain, URL or package id). Checked against the program scope before anything is sent.'),
    impact: z.string().max(5000).optional(),
    weaknessId: z.number().int().optional(),
    structuredScopeId: z.string().max(60).optional(),
  });
  const submit: Skill<z.infer<typeof SubmitInputSchema>, SubmitResult> = {
    name: 'hackerone.submit_report',
    title: 'Submit a bug-bounty report',
    description:
      "Submit a vulnerability report to a HackerOne program. The affected asset is checked against the program's eligible scope first, and an out-of-scope report is never sent. Consequential: it always needs your approval (or Full access).",
    category: 'pipeline',
    scope: 'hackerone.submit',
    risk: 'consequential',
    idempotent: false,
    inlineSafe: false,
    untrustedOutput: false,
    input: SubmitInputSchema,
    outputDescription: 'Whether the report was submitted (with its id/URL) or held, and why.',
    timeoutMs: 60_000,
    dependsOn: 'HackerOne',
    availability: available,
    summarize: (i) => `Submit report "${i.title}" to ${i.program} — asset ${i.asset}, ${i.severity}`,
    lockKey: (i) => `hackerone.submit:${i.program.toLowerCase()}`,
    execute: async (i, ctx) => h1.submitReport(i, { signal: ctx.signal }),
    async verify(_i, o) {
      return { ok: o.ok, detail: o.ok ? `Submitted${o.reportId ? ` #${o.reportId}` : ''} (in scope: ${o.matchedScope})` : `${o.held ? 'Held (not sent)' : 'Failed'}: ${o.reason}` };
    },
    describe: (o) => (o.ok ? `Submitted: ${o.reason}${o.url ? ` ${o.url}` : ''}` : `${o.held ? 'HELD — not sent' : 'Failed'}: ${o.reason}`),
  };

  return [programs, earnings, reports, scopes, submit];
}
