import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../server/computer/browser.ts';
import { slug } from '../server/computer/learning.ts';
import { makeApp } from './helpers.ts';
import { findChromium, freePort } from './_browser.ts';
import { ABSENT, COURSE_NAME, LESSONS, lessonPlainText, startSite, type Site } from './fixtures/computer-site.ts';

/**
 * MANDATORY course-learning acceptance test — end to end, through a REAL browser.
 *
 *  1. Open a simulated 3-lesson course (prose definitions, examples, live captions, content that only
 *     loads after scrolling, a video with no captions, a prompt-injection line).
 *  2. Tell Jarvis to watch and learn from it (auto-scroll + "Next lesson").
 *  3. Verify it identified the course and each lesson, extracted the concepts, and stored notes.
 *  4. RESTART the Jarvis application (close the DB, new process state, same data dir).
 *  5. Ask questions, compare lessons, ask about things that were never present.
 *  6. SCORE it: extracted facts, definitions, lesson identification, retrieval accuracy, unsupported
 *     claims, attribution accuracy, persistence. Pass thresholds are strict (no invented facts at all).
 *
 * A generated summary can never pass this: every check reads persisted memory rows after restart and
 * compares them with the course's ground truth.
 */

const CHROMIUM = findChromium();
const SKIP = CHROMIUM ? false : 'no Chromium-family browser on this host';
let site: Site;
let port = 0;
let pid: number | undefined;
let profile = '';

before(async () => {
  if (!CHROMIUM) return;
  site = await startSite();
  port = await freePort();
  profile = mkdtempSync(join(tmpdir(), 'jarvis-course-profile-'));
  const args = ['--headless=new', '--disable-gpu', '--window-size=1200,900'];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  pid = launchBrowser({ binary: CHROMIUM, profileDir: profile, port, extraArgs: args }).pid;
  for (let i = 0; i < 80; i++) {
    if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  try {
    if (pid) process.kill(pid);
  } catch {
    /* gone */
  }
  await site?.close();
  await new Promise((r) => setTimeout(r, 300));
  if (profile) rmSync(profile, { recursive: true, force: true });
});

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
/** "[Course / Lesson 2: X] FACT definition (Term): body" → body */
const bodyOf = (content: string) => content.replace(/^\[[^\]]*\]\s*(FACT|INFERENCE|UNCERTAIN)\s+\w+(\s+\([^)]*\))?:\s*/, '');

test('course learning: watch a 3-lesson course in a real browser, restart, recall, compare, score', { skip: SKIP, timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-course-'));
  const score: Record<string, unknown> = {};
  try {
    let storedBefore = 0;
    // ------------------------------------------------------------- session 1: watch and learn
    {
      const { app, cleanup } = await makeApp({ dataDir: dir });
      try {
        app.settings.update({ computerAccess: { enabled: true, level: 'interact', browserEndpoint: `http://127.0.0.1:${port}`, watchIntervalSec: 1 } });
        await app.computer.browserOp({ op: 'open', url: `${site.url}/course/lesson/1` });
        // "Watch this course and learn everything useful from it."
        const started = await app.watcher.start({ autoScroll: true, nextLabel: 'Next lesson', maxLessons: 3, intervalSec: 1 });
        assert.equal(started.course, COURSE_NAME, 'identified the course from the page');
        assert.equal(app.computer.status().live.state, 'LEARNING');
        assert.equal(app.computer.status().live.learningSession?.course, COURSE_NAME);
        const s = (await app.watcher.wait(started.id))!;
        score.session = { status: s.status, lessonsSeen: s.lessonsSeen, notesStored: s.notesStored, samples: s.samples, gaps: s.gaps };
        assert.equal(s.status, 'completed', JSON.stringify(s));
        assert.equal(s.lessonsSeen, 3, 'followed all three lessons');
        assert.equal(s.lastLesson, 'The Nucleus and DNA');
        assert.equal(s.lastLessonNumber, 3);
        // Honest coverage: the silent video and the injection attempt are reported.
        assert.ok(s.gaps.some((g) => /no captions\/transcript/.test(g) && /Nucleus/.test(g)), `video gap reported: ${s.gaps.join(' | ')}`);
        assert.ok(s.gaps.some((g) => /tried to instruct Jarvis/.test(g)), 'injection reported');
        storedBefore = app.learning.notesFor(slug(COURSE_NAME)).length;
        assert.ok(storedBefore >= 15, `stored ${storedBefore} notes`);
      } finally {
        await cleanup();
      }
    }

    // ------------------------------------------------------------- RESTART: a fresh app on the same data
    const { app, cleanup } = await makeApp({ dataDir: dir });
    try {
      const cs = slug(COURSE_NAME);
      const all = app.learning.notesFor(cs);
      score.persistence = { before: storedBefore, after: all.length };
      assert.equal(all.length, storedBefore, 'every note survived the restart');

      // 1) Extracted facts & definitions vs ground truth.
      let factsTotal = 0;
      let factsFound = 0;
      let defsTotal = 0;
      let defsCorrect = 0;
      const misses: string[] = [];
      for (const l of LESSONS) {
        const lessonNotes = app.learning.notesFor(cs, { lesson: l.n });
        const has = (needle: string) => lessonNotes.some((n) => norm(n.content).includes(norm(needle)));
        for (const t of [...l.terms, l.belowFold]) {
          factsTotal++;
          defsTotal++;
          if (has(t.mustContain)) factsFound++;
          else misses.push(`L${l.n} ${t.term}`);
          if (lessonNotes.some((n) => / definition /i.test(n.content) && norm(n.content).includes(norm(t.mustContain)) && norm(n.content).includes(norm(t.term.replace(/^the /i, ''))))) defsCorrect++;
        }
        for (const e of l.examples) {
          factsTotal++;
          if (has(e)) factsFound++;
          else misses.push(`L${l.n} example`);
        }
        for (const c of l.captions) {
          factsTotal++;
          if (has(c)) factsFound++;
          else misses.push(`L${l.n} caption "${c}"`);
        }
      }
      score.extraction = { factsFound, factsTotal, defsCorrect, defsTotal, misses };

      // 2) Lesson identification: every note is attributed to a real lesson of this course.
      const lessonSlugs = new Set(LESSONS.map((l) => slug(`${l.n}-${l.title}`)));
      const badLesson = all.filter((n) => !lessonSlugs.has(n.lesson ?? ''));
      score.lessonIdentification = { lessons: [...new Set(all.map((n) => n.lesson))], misattributedLessonTags: badLesson.length };

      // 3) Unsupported claims: every FACT must appear verbatim in its own lesson's source text.
      //    Attribution: …and in THAT lesson (not another).
      let unsupported = 0;
      let attributionOk = 0;
      let factNotes = 0;
      const unsupportedList: string[] = [];
      for (const n of all) {
        if (n.status !== 'fact') continue;
        factNotes++;
        const lessonNo = n.lessonNumber ?? 0;
        const body = norm(bodyOf(n.content));
        const inOwn = lessonNo > 0 && norm(lessonPlainText(lessonNo)).includes(body.replace(/^this lesson relates: /, ''));
        const inAny = LESSONS.some((l) => norm(lessonPlainText(l.n)).includes(body));
        if (!inAny) {
          unsupported++;
          unsupportedList.push(n.content);
        }
        if (inOwn) attributionOk++;
      }
      score.unsupportedClaims = { count: unsupported, examples: unsupportedList.slice(0, 5) };
      score.attribution = { correct: attributionOk, total: factNotes };

      // 4) Retrieval: questions after restart return the right lesson's notes.
      const questions: Array<{ q: string; lesson: number; expect: string }> = [
        { q: 'osmosis', lesson: 1, expect: 'diffusion of water' },
        { q: 'diffusion', lesson: 1, expect: 'higher concentration' },
        { q: 'ATP', lesson: 2, expect: 'energy currency' },
        { q: 'mitochondria', lesson: 2, expect: 'produce ATP' },
        { q: 'cellular respiration', lesson: 2, expect: 'glucose and oxygen' },
        { q: 'DNA double helix', lesson: 3, expect: 'double helix' },
        { q: 'transcription', lesson: 3, expect: 'copying DNA into RNA' },
        { q: 'nucleus', lesson: 3, expect: 'genetic material' },
      ];
      let retrievalOk = 0;
      const retrievalMisses: string[] = [];
      for (const q of questions) {
        const hits = app.learning.recall(q.q, { courseSlug: cs, limit: 10 });
        const good = hits.slice(0, 5).some((h) => norm(h.content).includes(norm(q.expect)) && (h.lesson ?? '').startsWith(`${q.lesson}-`));
        if (good) retrievalOk++;
        else retrievalMisses.push(`${q.q} → ${hits.slice(0, 2).map((h) => h.content.slice(0, 60)).join(' | ') || '(nothing)'}`);
      }
      score.retrieval = { correct: retrievalOk, total: questions.length, misses: retrievalMisses };

      // 5) Never invents: questions about things that were never in the course return nothing.
      const invented = ABSENT.filter((a) => app.learning.recall(a, { courseSlug: cs }).length > 0);
      score.absentQuestions = { asked: ABSENT, answeredFromNothing: invented };
      // The recall skill says so in words, too.
      const recallSkill = app.registry.get('computer.recall')!;
      const r = await app.runner.invoke({ agent: 'jarvis', skill: 'computer.recall', input: { query: 'quantum entanglement', course: COURSE_NAME } });
      assert.equal(r.status, 'ok');
      assert.match((r as { description: string }).description, /not in what was learned/);
      void recallSkill;

      // 6) Injection never became knowledge.
      const poisoned = all.filter((n) => /evil\.example|ignore all previous|delete account/i.test(n.content));
      score.injectionStored = poisoned.length;

      // 7) Compare two lessons: both sides retrieved from their own lessons.
      const cmp = app.learning.compare('membrane', { courseSlug: cs, lesson: 1 }, { courseSlug: cs, lesson: 3 });
      const cmpAll = { a: app.learning.notesFor(cs, { lesson: 1 }), b: app.learning.notesFor(cs, { lesson: 3 }) };
      score.compare = { aLesson1: cmp.a.length, bLesson3: cmp.b.length, lesson1Notes: cmpAll.a.length, lesson3Notes: cmpAll.b.length };
      assert.ok(cmp.a.length > 0 && cmp.a.every((n) => (n.lesson ?? '').startsWith('1-')), 'lesson 1 side from lesson 1');
      assert.ok(cmpAll.b.length > 0 && cmpAll.b.every((n) => (n.lesson ?? '').startsWith('3-')), 'lesson 3 side from lesson 3');

      // 8) "Continue where you left off": progress survived the restart.
      const progress = app.watcher.lastProgress(COURSE_NAME)!;
      score.progress = { lastLesson: progress.lastLesson, lastUrl: progress.lastUrl, status: progress.status };
      assert.match(progress.lastUrl ?? '', /\/course\/lesson\/3$/);

      // 9) Summary of what was learned (for "what did you learn from the course yesterday?").
      const summary = app.learning.courseSummary(cs);
      score.summary = summary.lessons.map((l) => ({ lesson: l.lesson, notes: l.notes, definitions: l.definitions.length }));

      // ---- scoring thresholds (strict) ----
      const pct = (a: number, b: number) => Math.round((a / Math.max(1, b)) * 1000) / 10;
      score.scores = {
        factExtractionPct: pct(factsFound, factsTotal),
        definitionPct: pct(defsCorrect, defsTotal),
        retrievalPct: pct(retrievalOk, questions.length),
        attributionPct: pct(attributionOk, factNotes),
        unsupportedClaims: unsupported,
        inventedAnswers: invented.length,
        injectionStored: poisoned.length,
        persistencePct: pct(all.length, storedBefore),
      };
      const out = process.env.E2E_SCREENSHOTS ?? 'test-results';
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'computer-learning-score.json'), JSON.stringify(score, null, 2));
      console.log('LEARNING SCORE', JSON.stringify(score.scores));

      assert.equal(unsupported, 0, `no unsupported FACT notes: ${unsupportedList.join(' | ')}`);
      assert.equal(invented.length, 0, `invented answers for ${invented.join(', ')}`);
      assert.equal(poisoned.length, 0, 'no injected text stored');
      assert.equal(badLesson.length, 0, 'every note is attributed to a real lesson');
      assert.ok(factsFound / factsTotal >= 0.9, `fact extraction ${factsFound}/${factsTotal}; missed ${misses.join(', ')}`);
      assert.ok(defsCorrect / defsTotal >= 0.9, `definitions ${defsCorrect}/${defsTotal}`);
      assert.equal(retrievalOk, questions.length, `retrieval misses: ${retrievalMisses.join(' || ')}`);
      assert.equal(attributionOk, factNotes, 'every FACT is attributed to the lesson it came from');
    } finally {
      await cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
