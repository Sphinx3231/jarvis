import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from './helpers.ts';

/**
 * MANDATORY learning acceptance test.
 *
 * A simulated multi-lesson course with accessible lesson text + captions. Jarvis must open/identify
 * the course, extract definitions/concepts/examples with source attribution, store them in persistent
 * memory, SURVIVE AN APPLICATION RESTART, answer questions, compare across lessons, and — crucially —
 * NOT invent information that was never present. Recall reads only stored memories, so a generated
 * summary can never stand in for real, persisted knowledge.
 */

const COURSE = 'Biology 101';
const LESSONS = [
  {
    lesson: 'Cells',
    lessonNumber: 1,
    text: [
      'Definition: A cell is the basic structural unit of all living organisms.',
      'Key term: Nucleus — the organelle that holds the cell’s DNA.',
      'Key term: Membrane — the boundary that controls what enters the cell.',
      'Example: A red blood cell carries oxygen around the body.',
      'Key concept: All living things are made of one or more cells.',
      'Q: What gives a cell its shape?',
    ].join('\n'),
    captions: 'Caption: Cells were first observed by Robert Hooke in 1665.',
  },
  {
    lesson: 'Energy',
    lessonNumber: 2,
    text: [
      'Definition: Photosynthesis is how plants convert light into chemical energy.',
      'Key term: Chlorophyll — the green pigment that absorbs light.',
      'Key term: Mitochondria — the organelle that releases energy from glucose.',
      'Example: A leaf in sunlight produces glucose and oxygen.',
      'Key concept: Energy flows from the sun to plants to animals.',
    ].join('\n'),
  },
  {
    lesson: 'Genetics',
    lessonNumber: 3,
    text: [
      'Definition: DNA is the molecule that carries genetic instructions.',
      'Key term: Gene — a section of DNA that codes for a trait.',
      'Key term: Nucleus — where the DNA is stored in the cell.',
      'Example: Eye colour is determined by genes inherited from parents.',
      'Key concept: Traits pass from parents to offspring through genes.',
    ].join('\n'),
  },
];

test('learning: observe a multi-lesson course, persist across restart, recall, compare, and do not invent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-learn-'));
  try {
    // --- Session 1: watch and learn the course -----------------------------------------------
    {
      const { app, cleanup } = await makeApp({ dataDir: dir });
      try {
        let totalStored = 0;
        for (const l of LESSONS) {
          const r = app.learning.ingestLesson({ course: COURSE, lesson: l.lesson, lessonNumber: l.lessonNumber, text: l.text, captions: l.captions });
          totalStored += r.stored;
          assert.ok(r.stored > 0, `lesson ${l.lesson} stored notes`);
        }
        assert.ok(totalStored >= 12, `stored ${totalStored} notes across the course`);

        // Identifies the course it learned.
        const courses = app.learning.courses();
        assert.ok(courses.some((c) => c.courseSlug === 'biology-101'));

        // Extraction produced the expected structured items for lesson 2, with FACT/INFERENCE status.
        const l2 = app.learning.ingestLesson({ course: COURSE, lesson: 'Energy (recheck)', lessonNumber: 2, text: LESSONS[1].text });
        const kinds = new Set(l2.notes.map((n) => n.kind));
        assert.ok(kinds.has('definition') && kinds.has('example') && kinds.has('concept'));
        assert.ok(l2.notes.some((n) => n.status === 'fact' && /Photosynthesis/i.test(n.content)), 'a FACT definition');
        assert.ok(l2.notes.some((n) => n.status === 'inference'), 'an INFERENCE note, marked as derived');

        // Source attribution is stored on every note.
        const recall = app.learning.recall('photosynthesis');
        assert.ok(recall.length > 0);
        assert.equal(recall[0].course, 'biology-101');
        assert.equal(recall[0].status, 'fact');
        assert.match(recall[0].source, /^learn:biology-101\//);
      } finally {
        await cleanup(); // closes the DB — the app is now "shut down"
      }
    }

    // --- Session 2: RESTART the app on the same data dir -------------------------------------
    {
      const { app, cleanup } = await makeApp({ dataDir: dir });
      try {
        // Knowledge survived the restart and answers questions.
        const photo = app.learning.recall('photosynthesis');
        assert.ok(photo.some((n) => /convert light into chemical energy/i.test(n.content)), 'recalls the photosynthesis definition after restart');

        const dna = app.learning.recall('genetic instructions');
        assert.ok(dna.some((n) => /DNA/i.test(n.content)), 'recalls the DNA definition after restart');

        // Compare a concept that appears in TWO lessons (Nucleus: lessons 1 and 3).
        const nucleus = app.learning.recall('nucleus');
        const lessons = new Set(nucleus.map((n) => n.lesson));
        assert.ok(nucleus.length >= 2 && lessons.size >= 2, `nucleus recalled from ${lessons.size} lesson(s): ${[...lessons].join(', ')}`);

        // Does NOT invent information that was never in the course.
        assert.deepEqual(app.learning.recall('quantum entanglement'), [], 'no invented facts for absent topics');
        assert.deepEqual(app.learning.recall('blockchain'), []);

        // The knowledge is ordinary memory, so Jarvis's normal recall finds it too.
        const viaMemory = app.memory.keywordSearch('chlorophyll');
        assert.ok(viaMemory.some((m) => m.tags.includes('learn') && /green pigment/i.test(m.content)));
      } finally {
        await cleanup();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('learning: the computer.learn skill is gated and stores from supplied text', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const find = () => app.registry.info().find((s) => s.name === 'computer.learn')!;
    assert.equal(find().available, false, 'gated behind Computer Access');
    assert.equal(find().untrustedOutput, true);

    app.settings.update({ computerAccess: { enabled: true, level: 'observe' }, permissions: { policies: { 'computer.observe': 'allow' } } });
    assert.equal(find().available, true);

    const res = await app.runner.invoke({ agent: 'researcher', skill: 'computer.learn', input: { course: 'Chemistry', lesson: 'Atoms', text: 'Definition: An atom is the smallest unit of matter.\nKey term: Electron — a negatively charged particle.' } });
    assert.equal(res.status, 'ok');
    assert.ok((res as { output: { stored: number } }).output.stored >= 2);
    assert.ok(app.learning.recall('electron').some((n) => /negatively charged/i.test(n.content)));
  } finally {
    await cleanup();
  }
});
