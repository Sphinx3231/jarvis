import { createHash, randomUUID } from 'node:crypto';
import type { ActivityLog } from '../core/activity.ts';
import { UserError } from '../core/util.ts';
import type { Database } from '../db/database.ts';
import type { PageRead } from './browser.ts';
import type { IngestResult, LearningPipeline } from './learning.ts';
import { slug } from './learning.ts';
import type { ComputerAccessManager } from './manager.ts';

/**
 * "Watch this and learn from it" — the controlled observation loop.
 *
 *   inspect the screen → identify the app/content → establish a session → read accessible content →
 *   detect changes / lesson transitions → extract → store (attributed, deduplicated) → continue until
 *   the user stops it, the course ends, or the content becomes unavailable.
 *
 * Sources, in order of preference (the brief: semantic before pixels):
 *   - browser: the page's own text, headings, captions/transcripts via the DevTools connection —
 *     exact, cheap, works off-screen; lazy content is revealed by scrolling.
 *   - screen: OCR of the screen, for any other application.
 *
 * Sampling is change-driven: every tick hashes what is visible; unchanged samples cost nothing and
 * store nothing. Only NEW lines are ingested, so a page re-read or a caption repeated is not duplicated.
 * Progress (course, last lesson, URL) is persisted, so "continue where you left off" works after a
 * restart. Honest coverage: every gap (no captions on a video, a sign-in wall, a dialog, a closed tab)
 * is recorded on the session and reported — a course is never "fully learned" if it wasn't.
 */

export type WatchSource = 'browser' | 'screen';

export interface WatchOptions {
  course?: string;
  source?: WatchSource;
  tabId?: string;
  intervalSec?: number;
  /** Scroll through the page to reveal content that only appears after scrolling (needs interact). */
  autoScroll?: boolean;
  /** Click this control (e.g. "Next lesson") when a lesson is finished, to move on (needs interact). */
  nextLabel?: string;
  /** Stop after this many lessons (default 1 unless nextLabel is set, then 20). */
  maxLessons?: number;
  maxMinutes?: number;
  task?: string;
}

export interface WatchSession {
  id: string;
  course: string;
  courseSlug: string;
  source: WatchSource;
  status: 'watching' | 'completed' | 'stopped' | 'blocked' | 'interrupted' | 'error';
  lastLesson: string | null;
  lastLessonNumber: number | null;
  lastUrl: string | null;
  lessonsSeen: number;
  notesStored: number;
  samples: number;
  gaps: string[];
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
}

interface Running {
  session: WatchSession;
  controller: AbortController;
  done: Promise<WatchSession>;
  seenLines: Map<string, Set<string>>;
  lessonsVisited: Set<string>;
  lastHash: string | null;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

const hash = (s: string) => createHash('sha1').update(s).digest('hex');

/** "Lesson 3: Genetics" / "3. Genetics" / "/lesson/3" → 3 */
export function lessonNumberFrom(...candidates: Array<string | null | undefined>): number | null {
  for (const c of candidates) {
    if (!c) continue;
    const m = c.match(/\blesson[\s\-_#:]*(\d{1,4})\b/i) ?? c.match(/^\s*(\d{1,3})[.:)]\s+\S/) ?? c.match(/\/(?:lesson|lecture|chapter|module)s?[/\-_](\d{1,4})\b/i);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Strip "Lesson 3:" style prefixes so the lesson title is the topic. */
function cleanLessonTitle(t: string): string {
  return t.replace(/^\s*(?:lesson|lecture|chapter|module)\s*\d+\s*[:.\-–—]\s*/i, '').replace(/^\s*\d{1,3}[.:)]\s+/, '').trim() || t.trim();
}

export class LearningWatcher {
  private computer: ComputerAccessManager;
  private learning: LearningPipeline;
  private db: Database | null;
  private activity: ActivityLog | null;
  private running = new Map<string, Running>();

  constructor(opts: { computer: ComputerAccessManager; learning: LearningPipeline; db?: Database | null; activity?: ActivityLog | null }) {
    this.computer = opts.computer;
    this.learning = opts.learning;
    this.db = opts.db ?? null;
    this.activity = opts.activity ?? null;
  }

  // ------------------------------------------------------------------ persistence

  private save(s: WatchSession): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO learning_sessions (id, course, course_slug, source, status, last_lesson, last_lesson_number, last_url, lessons_seen, notes_stored, samples, gaps, started_at, updated_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET course=excluded.course, course_slug=excluded.course_slug, status=excluded.status, last_lesson=excluded.last_lesson, last_lesson_number=excluded.last_lesson_number,
         last_url=excluded.last_url, lessons_seen=excluded.lessons_seen, notes_stored=excluded.notes_stored, samples=excluded.samples, gaps=excluded.gaps, updated_at=excluded.updated_at, ended_at=excluded.ended_at`,
      s.id,
      s.course,
      s.courseSlug,
      s.source,
      s.status,
      s.lastLesson,
      s.lastLessonNumber,
      s.lastUrl,
      s.lessonsSeen,
      s.notesStored,
      s.samples,
      JSON.stringify(s.gaps.slice(-50)),
      s.startedAt,
      s.updatedAt,
      s.endedAt,
    );
  }

  private fromRow(r: Record<string, unknown>): WatchSession {
    return {
      id: String(r.id),
      course: String(r.course),
      courseSlug: String(r.course_slug),
      source: r.source as WatchSource,
      status: r.status as WatchSession['status'],
      lastLesson: (r.last_lesson as string | null) ?? null,
      lastLessonNumber: r.last_lesson_number === null || r.last_lesson_number === undefined ? null : Number(r.last_lesson_number),
      lastUrl: (r.last_url as string | null) ?? null,
      lessonsSeen: Number(r.lessons_seen),
      notesStored: Number(r.notes_stored),
      samples: Number(r.samples),
      gaps: JSON.parse(String(r.gaps ?? '[]')),
      startedAt: Number(r.started_at),
      updatedAt: Number(r.updated_at),
      endedAt: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at),
    };
  }

  /** Past and current sessions (newest first). Survives restarts. */
  sessions(limit = 20): WatchSession[] {
    const live = [...this.running.values()].map((r) => r.session);
    if (!this.db) return live;
    const stored = this.db.all<Record<string, unknown>>('SELECT * FROM learning_sessions ORDER BY updated_at DESC LIMIT ?', limit).map((r) => this.fromRow(r));
    const liveIds = new Set(live.map((s) => s.id));
    return [...live, ...stored.filter((s) => !liveIds.has(s.id))].slice(0, limit);
  }

  /** Where to continue a course: the most recent session's last lesson and URL. */
  lastProgress(course: string): WatchSession | null {
    const cs = slug(course);
    if (this.db) {
      const r = this.db.get<Record<string, unknown>>('SELECT * FROM learning_sessions WHERE course_slug = ? ORDER BY updated_at DESC LIMIT 1', cs);
      if (r) return this.fromRow(r);
    }
    return [...this.running.values()].map((x) => x.session).find((s) => s.courseSlug === cs) ?? null;
  }

  active(): WatchSession[] {
    return [...this.running.values()].map((r) => r.session);
  }

  // ------------------------------------------------------------------ control

  /** Start watching. Returns immediately; the loop runs in the background until stopped/finished. */
  async start(opts: WatchOptions = {}): Promise<WatchSession> {
    const gate = this.computer.permits(opts.autoScroll || opts.nextLabel ? 'interact' : 'observe');
    if (!gate.ok) throw new UserError(gate.reason);
    if (this.running.size >= 2) throw new UserError('Already watching two things — stop one first.');
    let source: WatchSource = opts.source ?? 'browser';
    if (source === 'browser' && !(await this.computer.browser().probe()).ok) {
      if (opts.source === 'browser') throw new UserError((await this.computer.browser().probe()).detail);
      source = 'screen';
    }
    // Identify the content before committing to a session.
    let course = opts.course?.trim() || '';
    let tabId = opts.tabId;
    if (source === 'browser') {
      const r = await this.computer.browserOp({ op: 'read', tabId, maxChars: 4000 }, undefined, { task: opts.task ?? 'learning' });
      if (r.op !== 'read' || !('page' in r)) throw new UserError('Could not read the browser tab.');
      tabId = r.tabId;
      course ||= r.page.meta.course ?? r.page.meta.siteName ?? r.page.title ?? 'Untitled course';
    } else {
      const o = await this.computer.observe({ activeWindow: true });
      course ||= o.activeWindow?.title ?? 'Screen content';
    }
    const now = Date.now();
    const session: WatchSession = { id: randomUUID(), course, courseSlug: slug(course), source, status: 'watching', lastLesson: null, lastLessonNumber: null, lastUrl: null, lessonsSeen: 0, notesStored: 0, samples: 0, gaps: [], startedAt: now, updatedAt: now, endedAt: null };
    const controller = new AbortController();
    const run: Running = { session, controller, seenLines: new Map(), lessonsVisited: new Set(), lastHash: null, done: Promise.resolve(session) };
    this.running.set(session.id, run);
    this.save(session);
    this.computer.actions.setLearning({ id: session.id, course, lesson: null });
    this.computer.actions.setState('LEARNING', { task: opts.task ?? `Learning from ${course}`, detail: `watching ${source === 'browser' ? 'the browser tab' : 'the screen'}` });
    this.activity?.log('info', 'system', `Computer Access: started learning from "${course}" (${source}).`);
    run.done = this.loop(run, { ...opts, tabId, source }).catch((err) => {
      session.status = 'error';
      session.gaps.push(`Stopped by an error: ${(err as Error).message}`);
      return session;
    }).finally(() => {
      session.endedAt = Date.now();
      session.updatedAt = Date.now();
      if (session.status === 'watching') session.status = 'stopped';
      this.save(session);
      this.running.delete(session.id);
      if (!this.running.size) {
        this.computer.actions.setLearning(null);
        if (this.computer.actions.state() === 'LEARNING') this.computer.actions.setState('IDLE', { detail: `Learning session ${session.status}: ${session.notesStored} note(s) from ${session.lessonsSeen} lesson(s)` });
      }
      this.computer.actions.record({ kind: 'learn.session', target: session.course, detail: `${session.status}: ${session.lessonsSeen} lesson(s), ${session.notesStored} note(s), ${session.samples} sample(s)${session.gaps.length ? `; gaps: ${session.gaps.slice(-3).join(' | ')}` : ''}`, outcome: session.status === 'error' ? 'failed' : 'ok', verified: null, critical: null, task: null, durationMs: Date.now() - session.startedAt });
      this.activity?.log('info', 'system', `Computer Access: learning session for "${session.course}" ${session.status} — ${session.notesStored} note(s) stored from ${session.lessonsSeen} lesson(s).`);
      return session;
    });
    return session;
  }

  async stop(id?: string): Promise<WatchSession[]> {
    const targets = id ? [this.running.get(id)].filter((x): x is Running => Boolean(x)) : [...this.running.values()];
    for (const r of targets) {
      r.session.status = 'stopped';
      r.controller.abort(new Error('Stopped by you'));
    }
    return Promise.all(targets.map((r) => r.done));
  }

  /** Wait for a session to end (tests / "learn this lesson then tell me"). */
  async wait(id: string): Promise<WatchSession | null> {
    const r = this.running.get(id);
    return r ? r.done : this.sessions(200).find((s) => s.id === id) ?? null;
  }

  // ------------------------------------------------------------------ the loop

  private async loop(run: Running, opts: WatchOptions & { source: WatchSource }): Promise<WatchSession> {
    const s = run.session;
    const intervalMs = Math.max(500, (opts.intervalSec ?? this.computer.watchIntervalSec()) * 1000);
    const maxLessons = opts.maxLessons ?? (opts.nextLabel ? 20 : 1);
    const deadline = Date.now() + (opts.maxMinutes ?? 120) * 60_000;
    let stableTicks = 0;
    for (;;) {
      const signal = AbortSignal.any([run.controller.signal, this.computer.signal]);
      if (signal.aborted || !this.computer.enabled()) {
        if (s.status === 'watching') s.status = 'stopped';
        return s;
      }
      if (Date.now() > deadline) {
        s.status = 'completed';
        s.gaps.push(`Stopped after the ${opts.maxMinutes ?? 120}-minute limit.`);
        return s;
      }
      s.samples++;
      const outcome = opts.source === 'browser' ? await this.tickBrowser(run, opts, signal) : await this.tickScreen(run, opts, signal);
      s.updatedAt = Date.now();
      this.save(s);
      if (outcome === 'blocked' || outcome === 'interrupted') {
        s.status = outcome;
        return s;
      }
      stableTicks = outcome === 'changed' ? 0 : stableTicks + 1;
      // A lesson is "finished" when the page has been fully read (end reached) and nothing changed for
      // a couple of samples (captions stopped arriving). Then advance or finish.
      if (outcome === 'lesson-end' || (outcome === 'unchanged' && stableTicks >= 2 && opts.source === 'browser' && run.lessonsVisited.size > 0)) {
        if (!opts.nextLabel || run.lessonsVisited.size >= maxLessons) {
          s.status = 'completed';
          return s;
        }
        const advanced = await this.advance(run, opts, signal);
        if (!advanced) {
          s.status = 'completed';
          return s;
        }
        stableTicks = 0;
        continue;
      }
      await sleep(intervalMs, signal);
    }
  }

  private newLines(run: Running, lessonKey: string, text: string): string[] {
    const seen = run.seenLines.get(lessonKey) ?? new Set<string>();
    run.seenLines.set(lessonKey, seen);
    const out: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length < 3) continue;
      const k = line.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(line);
    }
    return out;
  }

  private ingest(run: Running, lesson: string, lessonNumber: number | null, text: string, captions: string, url: string | null, site: string | null): IngestResult | null {
    if (!text.trim() && !captions.trim()) return null;
    const r = this.learning.ingestLesson({ course: run.session.course, lesson, lessonNumber: lessonNumber ?? undefined, text, captions: captions || undefined, sourceUrl: url ?? undefined, sessionId: run.session.id, site: site ?? undefined });
    run.session.notesStored += r.stored;
    if (r.quarantined.length) run.session.gaps.push(`Ignored ${r.quarantined.length} line(s) that tried to instruct Jarvis (e.g. ${JSON.stringify(r.quarantined[0].slice(0, 80))}).`);
    if (r.redacted) run.session.gaps.push(`Redacted ${r.redacted} credential-like string(s) before storing.`);
    return r;
  }

  private identifyLesson(page: PageRead): { lesson: string; lessonNumber: number | null; key: string } {
    const h1 = page.headings.find((h) => h.level === 1)?.text;
    const raw = page.meta.lesson ?? h1 ?? page.title ?? page.url;
    const lessonNumber = lessonNumberFrom(page.meta.lesson, h1, page.title, page.url);
    const lesson = cleanLessonTitle(raw);
    let path = page.url;
    try {
      const u = new URL(page.url);
      path = u.origin + u.pathname;
    } catch {
      /* keep */
    }
    return { lesson, lessonNumber, key: `${path}#${slug(lesson)}` };
  }

  private async tickBrowser(run: Running, opts: WatchOptions, signal: AbortSignal): Promise<'changed' | 'unchanged' | 'lesson-end' | 'blocked' | 'interrupted'> {
    const s = run.session;
    let page: PageRead;
    let tabId = opts.tabId;
    try {
      const r = await this.computer.browserOp({ op: 'read', tabId, maxChars: 200_000 }, signal, { task: opts.task ?? `Learning from ${s.course}` });
      if (r.op !== 'read' || !('page' in r)) throw new Error('unexpected read result');
      page = r.page;
      tabId = r.tabId;
      opts.tabId = tabId;
    } catch (err) {
      if (signal.aborted) return 'unchanged';
      s.gaps.push(`The content became unavailable: ${(err as Error).message}`);
      return 'interrupted';
    }
    this.computer.actions.setState('LEARNING', { detail: `reading "${page.title}"` });
    if (page.loginRequired) {
      s.gaps.push(`"${page.title}" asks you to sign in (${page.loginReason}) — paused; sign in and continue.`);
      return 'blocked';
    }
    const { lesson, lessonNumber, key } = this.identifyLesson(page);
    const newLesson = !run.lessonsVisited.has(key);
    if (newLesson) {
      run.lessonsVisited.add(key);
      s.lessonsSeen = run.lessonsVisited.size;
      s.lastLesson = lesson;
      s.lastLessonNumber = lessonNumber;
      s.lastUrl = page.url;
      this.computer.actions.setLearning({ id: s.id, course: s.course, lesson });
    }
    // Exclude dialog text (an interruption, not lesson content).
    let text = page.text;
    for (const d of page.dialogs) text = text.replace(d, '');
    if (page.dialogs.length) s.gaps.push(`A dialog interrupted "${lesson}": ${JSON.stringify(page.dialogs[0].slice(0, 80))} (its text was not learned).`);
    let reachedEnd = page.scroll.max <= 0;
    // Reveal content that only appears after scrolling.
    if (opts.autoScroll && this.computer.permits('interact').ok && page.scroll.max > 0) {
      for (let i = 0; i < 30 && !signal.aborted; i++) {
        const sr = await this.computer.browserOp({ op: 'scroll', direction: 'down', amount: Math.max(300, Math.round(page.scroll.viewport * 0.8)), tabId }, signal, { task: opts.task }).catch(() => null);
        if (!sr || !('result' in sr)) break;
        const res = sr.result as { atEnd?: boolean };
        await sleep(150, signal);
        if (res.atEnd) {
          reachedEnd = true;
          break;
        }
      }
      const again = await this.computer.browserOp({ op: 'read', tabId, maxChars: 200_000 }, signal, { task: opts.task }).catch(() => null);
      if (again && 'page' in again) {
        text = again.page.text;
        for (const d of again.page.dialogs) text = text.replace(d, '');
        page = { ...again.page, captions: [page.captions, again.page.captions].filter(Boolean).join('\n') };
      }
    } else if (!opts.autoScroll && page.scroll.max > 0 && newLesson) {
      s.gaps.push(`"${lesson}" is longer than the screen; only text already in the page was read (enable auto-scroll to reveal lazy-loaded content).`);
    }
    const digest = hash(`${key}\n${text}\n${page.captions}`);
    if (digest === run.lastHash && !newLesson) return reachedEnd && opts.nextLabel ? 'lesson-end' : 'unchanged';
    run.lastHash = digest;
    const fresh = this.newLines(run, key, text);
    const freshCaptions = this.newLines(run, `${key}#captions`, page.captions);
    const videoWithoutCaptions = /\b(video|watch)\b/i.test(text) && !page.captions.trim() && page.elements.every((e) => !/transcript/i.test(e.name));
    if (newLesson && videoWithoutCaptions && /\bvideo\b/i.test(text)) s.gaps.push(`"${lesson}" mentions a video but no captions/transcript are accessible — spoken content was not learned.`);
    const r = this.ingest(run, lesson, lessonNumber, fresh.join('\n'), freshCaptions.join('\n'), page.url, page.meta.siteName);
    if (newLesson && r && r.extracted === 0) s.gaps.push(`"${lesson}": text was read but no definitions/examples/concepts could be extracted reliably.`);
    return reachedEnd && opts.nextLabel && !newLesson ? 'lesson-end' : 'changed';
  }

  private async tickScreen(run: Running, opts: WatchOptions, signal: AbortSignal): Promise<'changed' | 'unchanged' | 'blocked' | 'interrupted'> {
    const s = run.session;
    const o = await this.computer.observe({ ocr: true, activeWindow: true }, signal).catch((err) => {
      s.gaps.push(`Could not observe the screen: ${(err as Error).message}`);
      return null;
    });
    if (!o) return 'interrupted';
    if (!o.ocr) {
      s.gaps.push(`Screen text unavailable: ${o.notes.join('; ') || 'no OCR'}`);
      return 'interrupted';
    }
    const title = o.activeWindow?.title ?? s.course;
    const lessonNumber = lessonNumberFrom(title);
    const lesson = cleanLessonTitle(title);
    const key = `screen#${slug(lesson)}`;
    if (!run.lessonsVisited.has(key)) {
      run.lessonsVisited.add(key);
      s.lessonsSeen = run.lessonsVisited.size;
      s.lastLesson = lesson;
      s.lastLessonNumber = lessonNumber;
      this.computer.actions.setLearning({ id: s.id, course: s.course, lesson });
    }
    const digest = hash(`${key}\n${o.ocr.text}`);
    if (digest === run.lastHash) return 'unchanged';
    run.lastHash = digest;
    const fresh = this.newLines(run, key, o.ocr.text);
    if (o.ocr.meanConfidence !== null && o.ocr.meanConfidence < 60) s.gaps.push(`Low OCR confidence (${o.ocr.meanConfidence}%) on "${lesson}" — some text may be misread; notes are marked as read from the screen.`);
    this.ingest(run, lesson, lessonNumber, fresh.join('\n'), '', null, o.activeWindow?.app ?? null);
    return 'changed';
  }

  /** Move to the next lesson by clicking its control; verify a new lesson loaded. */
  private async advance(run: Running, opts: WatchOptions, signal: AbortSignal): Promise<boolean> {
    if (!opts.nextLabel || !this.computer.permits('interact').ok) return false;
    const before = run.session.lastUrl;
    try {
      const r = await this.computer.browserOp({ op: 'click', target: { name: opts.nextLabel }, tabId: opts.tabId }, signal, { task: opts.task ?? `Learning from ${run.session.course}` });
      const res = 'result' in r ? r.result : null;
      if (!res?.ok) {
        run.session.gaps.push(`No "${opts.nextLabel}" control found after "${run.session.lastLesson}" — treating the course as finished.`);
        return false;
      }
      if (res.verified && !res.verified.ok) {
        run.session.gaps.push(`Clicked "${opts.nextLabel}" but the next lesson could not be verified (${res.verified.detail}).`);
        return false;
      }
      run.lastHash = null;
      void before;
      return true;
    } catch (err) {
      run.session.gaps.push(`Could not move to the next lesson: ${(err as Error).message}`);
      return false;
    }
  }
}
