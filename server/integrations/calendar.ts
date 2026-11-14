import { createHash, randomUUID } from 'node:crypto';
import ical, { type VEvent } from 'node-ical';
import { createDAVClient, type DAVCalendar } from 'tsdav';
import { z } from 'zod';
import type { SecretStore } from '../core/secrets.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage, newId, UserError } from '../core/util.ts';
import type { Skill } from '../skills/types.ts';

/**
 * Calendars over open standards: CalDAV accounts (iCloud, Fastmail, Nextcloud, many hosts) for
 * reading and creating events, plus read-only ICS feed subscriptions (Google, Outlook and most
 * calendar apps can publish one). Credentials and feed URLs are stored encrypted.
 */

export const CALDAV_SECRET = 'calendar:caldav:password';
export const feedSecret = (id: string) => `calendar:feed:${id}`;

export interface CalendarEvent {
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
  calendar: string;
  uid: string;
}

type DavClient = Awaited<ReturnType<typeof createDAVClient>>;

const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Fold long lines per RFC 5545 (75 octets). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export function buildEvent(e: { uid: string; title: string; start: Date; end: Date; location?: string; description?: string }): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jarvis//Personal Assistant//EN',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(e.start)}`,
    `DTEND:${icsDate(e.end)}`,
    `SUMMARY:${icsEscape(e.title)}`,
    ...(e.location ? [`LOCATION:${icsEscape(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${icsEscape(e.description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ]
    .map(fold)
    .join('\r\n');
}

/** Parse ICS text into event instances within [from, to], expanding recurring events. */
export function eventsFromIcs(text: string, calendar: string, from: Date, to: Date): CalendarEvent[] {
  const parsed = ical.sync.parseICS(text);
  const out: CalendarEvent[] = [];
  for (const item of Object.values(parsed)) {
    if (!item || (item as { type?: string }).type !== 'VEVENT') continue;
    const ev = item as VEvent;
    if ((ev as unknown as { recurrenceid?: unknown }).recurrenceid) continue; // overrides are applied by expansion
    const instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    for (const inst of instances) {
      out.push({
        title: String((inst.summary as unknown as { val?: string })?.val ?? inst.summary ?? '(untitled)'),
        start: new Date(inst.start).toISOString(),
        end: inst.end ? new Date(inst.end).toISOString() : null,
        allDay: Boolean(inst.isFullDay),
        location: ev.location ? String((ev.location as unknown as { val?: string }).val ?? ev.location) : null,
        description: ev.description ? String((ev.description as unknown as { val?: string }).val ?? ev.description).slice(0, 2000) : null,
        calendar,
        uid: ev.uid,
      });
    }
  }
  return out;
}

export class CalendarService {
  private settings: SettingsStore;
  private secrets: SecretStore;
  lastCheck: { ok: boolean; detail: string; at: number } | null = null;

  constructor(settings: SettingsStore, secrets: SecretStore) {
    this.settings = settings;
    this.secrets = secrets;
  }

  private caldavConfig() {
    return this.settings.get().integrations.calendar.caldav;
  }

  caldavMissing(): string | null {
    const c = this.caldavConfig();
    if (!c.enabled) return 'CalDAV calendar is turned off (Integrations → Calendar)';
    if (!c.serverUrl || !c.username) return 'CalDAV account is not fully configured';
    if (!this.secrets.has(CALDAV_SECRET)) return 'CalDAV password is not set';
    return null;
  }

  readMissing(): string | null {
    if (!this.caldavMissing()) return null;
    return this.settings.get().integrations.calendar.feeds.length ? null : 'No calendar connected (add a CalDAV account or an ICS feed in Integrations)';
  }

  private async client(): Promise<DavClient> {
    const c = this.caldavConfig();
    return createDAVClient({
      serverUrl: c.serverUrl,
      credentials: { username: c.username, password: this.secrets.get(CALDAV_SECRET) ?? '' },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
  }

  private async calendars(client: DavClient): Promise<DAVCalendar[]> {
    const all = await client.fetchCalendars();
    // Only calendars that hold events (skip task lists / reminders).
    return all.filter((c) => !c.components || c.components.includes('VEVENT'));
  }

  private name(c: DAVCalendar): string {
    return typeof c.displayName === 'string' && c.displayName ? c.displayName : (c.url.split('/').filter(Boolean).pop() ?? 'Calendar');
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    const notes: string[] = [];
    let ok = true;
    if (!this.caldavMissing()) {
      try {
        const cals = await this.calendars(await this.client());
        notes.push(`CalDAV: ${cals.length} calendar(s)${cals.length ? ` (${cals.map((c) => this.name(c)).join(', ')})` : ''}`);
      } catch (err) {
        ok = false;
        notes.push(`CalDAV: ${errorMessage(err)}`);
      }
    }
    for (const feed of this.settings.get().integrations.calendar.feeds) {
      try {
        await this.fetchFeed(feed.id);
        notes.push(`${feed.name}: reachable`);
      } catch (err) {
        ok = false;
        notes.push(`${feed.name}: ${errorMessage(err)}`);
      }
    }
    if (!notes.length) {
      ok = false;
      notes.push('No calendar configured');
    }
    this.lastCheck = { ok, detail: notes.join(' · '), at: Date.now() };
    return { ok, detail: this.lastCheck.detail };
  }

  private async fetchFeed(id: string, signal?: AbortSignal): Promise<string> {
    const raw = this.secrets.get(feedSecret(id));
    if (!raw) throw new Error('Feed URL missing');
    const url = raw.replace(/^webcal:\/\//i, 'https://');
    const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(30_000), headers: { accept: 'text/calendar, */*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Not an iCalendar feed');
    return text;
  }

  async events(opts: { from: Date; to: Date; query?: string }, signal?: AbortSignal): Promise<{ events: CalendarEvent[]; sources: string[]; errors: string[] }> {
    const events: CalendarEvent[] = [];
    const sources: string[] = [];
    const errors: string[] = [];
    if (!this.caldavMissing()) {
      try {
        const client = await this.client();
        for (const cal of await this.calendars(client)) {
          const objects = await client.fetchCalendarObjects({ calendar: cal, timeRange: { start: opts.from.toISOString(), end: opts.to.toISOString() } });
          for (const obj of objects) if (typeof obj.data === 'string') events.push(...eventsFromIcs(obj.data, this.name(cal), opts.from, opts.to));
          sources.push(this.name(cal));
        }
      } catch (err) {
        errors.push(`CalDAV: ${errorMessage(err)}`);
      }
    }
    for (const feed of this.settings.get().integrations.calendar.feeds) {
      try {
        events.push(...eventsFromIcs(await this.fetchFeed(feed.id, signal), feed.name, opts.from, opts.to));
        sources.push(feed.name);
      } catch (err) {
        errors.push(`${feed.name}: ${errorMessage(err)}`);
      }
    }
    const q = opts.query?.toLowerCase();
    const filtered = events
      .filter((e) => new Date(e.end ?? e.start) >= opts.from && new Date(e.start) <= opts.to)
      .filter((e) => !q || `${e.title} ${e.location ?? ''} ${e.description ?? ''}`.toLowerCase().includes(q));
    filtered.sort((a, b) => a.start.localeCompare(b.start));
    if (!sources.length && errors.length) throw new Error(errors.join('; '));
    return { events: filtered.slice(0, 200), sources, errors };
  }

  async createEvent(e: { uid: string; title: string; start: Date; end: Date; location?: string; description?: string; calendar?: string }): Promise<{ uid: string; url: string; calendar: string }> {
    const client = await this.client();
    const cals = await this.calendars(client);
    if (!cals.length) throw new Error('This CalDAV account has no event calendars');
    const cal = (e.calendar && cals.find((c) => this.name(c).toLowerCase() === e.calendar!.toLowerCase())) || cals[0];
    if (e.calendar && this.name(cal).toLowerCase() !== e.calendar.toLowerCase()) throw new Error(`No calendar named "${e.calendar}" (have: ${cals.map((c) => this.name(c)).join(', ')})`);
    const filename = `${e.uid}.ics`;
    const res = await client.createCalendarObject({ calendar: cal, filename, iCalString: buildEvent(e) });
    // 412 means an event with this deterministic id already exists: a safe repeat, not a duplicate.
    if (!res.ok && res.status !== 412) throw new Error(`Server refused the event (HTTP ${res.status})`);
    return { uid: e.uid, url: new URL(filename, cal.url.endsWith('/') ? cal.url : `${cal.url}/`).toString(), calendar: this.name(cal) };
  }

  async eventExists(url: string, uid: string): Promise<boolean> {
    const client = await this.client();
    for (const cal of await this.calendars(client)) {
      const objs = await client.fetchCalendarObjects({ calendar: cal, objectUrls: [url] }).catch(() => []);
      if (objs.some((o) => typeof o.data === 'string' && o.data.includes(`UID:${uid}`))) return true;
    }
    return false;
  }

  addFeed(name: string, url: string): { id: string; name: string } {
    if (!/^(https?|webcal):\/\//i.test(url)) throw new UserError('Feed URL must start with https://, http:// or webcal://');
    const id = newId('feed').replace(/_/g, '-').toLowerCase().slice(0, 40);
    this.secrets.set(feedSecret(id), url);
    const feeds = this.settings.get().integrations.calendar.feeds;
    this.settings.update({ integrations: { calendar: { feeds: [...feeds, { id, name }] } } });
    return { id, name };
  }

  removeFeed(id: string): void {
    const feeds = this.settings.get().integrations.calendar.feeds;
    if (!feeds.some((f) => f.id === id)) throw new UserError('Feed not found', 404);
    this.secrets.delete(feedSecret(id));
    this.settings.update({ integrations: { calendar: { feeds: feeds.filter((f) => f.id !== id) } } });
  }
}

// ---------------------------------------------------------------- skills

const parseWhen = (value: string, field: string): Date => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid date-time`);
  return d;
};

export function calendarSkills(calendar: CalendarService): Skill[] {
  const EventsInput = z.object({
    from: z.string().max(40).optional().describe('ISO 8601 start (default: now)'),
    to: z.string().max(40).optional().describe('ISO 8601 end (default: from + days)'),
    days: z.number().int().min(1).max(366).optional().describe('Window length when "to" is omitted (default 7)'),
    query: z.string().max(200).optional().describe('Only events whose title, place or notes contain this'),
  });
  const list: Skill<z.infer<typeof EventsInput>, Awaited<ReturnType<CalendarService['events']>>> = {
    name: 'calendar.events',
    title: 'List calendar events',
    description: 'List events from your connected calendars (CalDAV and ICS feeds) in a time window, with recurring events expanded.',
    category: 'calendar',
    scope: 'calendar.read',
    risk: 'read',
    idempotent: true,
    inlineSafe: true,
    untrustedOutput: true,
    input: EventsInput,
    outputDescription: 'Events with title, start, end, all-day flag, location and calendar name.',
    timeoutMs: 60_000,
    dependsOn: 'Calendar',
    availability: () => {
      const missing = calendar.readMissing();
      return missing ? { available: false, reason: missing } : { available: true };
    },
    summarize: (i) => `List calendar events${i.query ? ` matching "${i.query}"` : ''} (${i.from ?? 'now'}, ${i.days ?? 7} days)`,
    execute(i, ctx) {
      const from = i.from ? parseWhen(i.from, 'from') : new Date();
      const to = i.to ? parseWhen(i.to, 'to') : new Date(from.getTime() + (i.days ?? 7) * 86_400_000);
      return calendar.events({ from, to, query: i.query }, ctx.signal);
    },
    async verify(_i, out) {
      return out.sources.length ? { ok: true, detail: `${out.events.length} event(s) from ${out.sources.join(', ')}${out.errors.length ? ` (${out.errors.length} source(s) failed)` : ''}` } : { ok: false, detail: 'No calendar could be read' };
    },
    describe: (o) =>
      (o.events.length
        ? o.events.map((e) => `${e.allDay ? `${e.start.slice(0, 10)} (all day)` : `${e.start.slice(0, 16).replace('T', ' ')}–${e.end?.slice(11, 16) ?? ''} UTC`} ${e.title}${e.location ? ` @ ${e.location}` : ''} [${e.calendar}]`).join('\n')
        : 'No events in that window.') + (o.errors.length ? `\nUnavailable: ${o.errors.join('; ')}` : ''),
  };

  const CreateInput = z.object({
    title: z.string().min(1).max(200),
    start: z.string().max(40).describe('ISO 8601 date-time with timezone offset, e.g. 2026-11-20T15:00:00+01:00'),
    end: z.string().max(40).optional(),
    durationMinutes: z.number().int().min(1).max(10_080).optional().describe('Used when "end" is omitted (default 60)'),
    location: z.string().max(300).optional(),
    description: z.string().max(5000).optional(),
    calendar: z.string().max(100).optional().describe('Calendar name (default: the first one)'),
  });
  type CreateOut = Awaited<ReturnType<CalendarService['createEvent']>> & { start: string; end: string; title: string };
  const create: Skill<z.infer<typeof CreateInput>, CreateOut> = {
    name: 'calendar.create_event',
    title: 'Add calendar event',
    description: 'Create an event in your CalDAV calendar. Asks for approval by default.',
    category: 'calendar',
    scope: 'calendar.write',
    risk: 'write',
    // The event id is derived from the task step and input, so repeating the step re-writes the
    // same event instead of creating a duplicate.
    idempotent: true,
    inlineSafe: false,
    untrustedOutput: false,
    input: CreateInput,
    outputDescription: 'The created event, its calendar and URL.',
    timeoutMs: 60_000,
    dependsOn: 'Calendar (CalDAV)',
    availability: () => {
      const missing = calendar.caldavMissing();
      return missing ? { available: false, reason: missing } : { available: true };
    },
    summarize: (i) => `Add “${i.title}” on ${i.start}${i.location ? ` at ${i.location}` : ''}${i.calendar ? ` to ${i.calendar}` : ''}`,
    async execute(i, ctx) {
      const start = parseWhen(i.start, 'start');
      const end = i.end ? parseWhen(i.end, 'end') : new Date(start.getTime() + (i.durationMinutes ?? 60) * 60_000);
      if (end <= start) throw new Error('The event must end after it starts');
      const seed = ctx.taskId ? `${ctx.taskId}:${ctx.stepIndex}:${JSON.stringify(i)}` : randomUUID();
      const uid = `jarvis-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}@jarvis.local`;
      const res = await calendar.createEvent({ uid, title: i.title, start, end, location: i.location, description: i.description, calendar: i.calendar });
      return { ...res, title: i.title, start: start.toISOString(), end: end.toISOString() };
    },
    async verify(_i, out) {
      return (await calendar.eventExists(out.url, out.uid)) ? { ok: true, detail: `Event found in “${out.calendar}”` } : { ok: false, detail: 'The event could not be found on the server after creating it' };
    },
    describe: (o) => `Added “${o.title}” (${o.start} – ${o.end}) to ${o.calendar}`,
  };
  return [list, create];
}
