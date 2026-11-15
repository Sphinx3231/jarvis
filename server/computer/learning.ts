import type { MemoryStore, ScoredMemory } from '../memory/store.ts';

/**
 * The learning pipeline: "watch this and learn from it".
 *
 * It turns accessible lesson content (OCR'd screen text, captions, or supplied text) into discrete,
 * attributed knowledge items and stores each as a persistent memory. Two honesty guarantees matter:
 *
 *  1. Every item is tagged with where it came from (course, lesson, time) and an epistemic status —
 *     FACT (directly present in the source), INFERENCE (derived), or UNCERTAIN.
 *  2. Recall only ever returns items that were actually stored. The pipeline cannot invent an answer,
 *     so "I didn't find that in the material" is a structural outcome, not a behaviour we hope for.
 *
 * Extraction is deterministic (it parses the lesson's own structure), so what is stored is genuinely
 * from the source rather than a model's paraphrase.
 */

export type KnowledgeStatus = 'fact' | 'inference' | 'uncertain';

export type NoteKind = 'definition' | 'concept' | 'example' | 'caption' | 'takeaway' | 'question';

export interface LearningNote {
  kind: NoteKind;
  term: string | null;
  content: string;
  status: KnowledgeStatus;
}

export interface LessonIngest {
  course: string;
  lesson: string;
  lessonNumber?: number;
  /** The lesson body as accessible text (OCR, transcript or supplied). */
  text: string;
  /** Captions/transcript, kept distinct so they are attributed as captions. */
  captions?: string;
  sourceUrl?: string;
  observedAt?: number;
}

export interface IngestResult {
  course: string;
  courseSlug: string;
  lesson: string;
  lessonSlug: string;
  extracted: number;
  stored: number;
  notes: LearningNote[];
}

export interface RecalledNote {
  content: string;
  course: string | null;
  lesson: string | null;
  status: KnowledgeStatus | null;
  source: string;
  score: number;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}

const confidenceFor = (status: KnowledgeStatus): number => (status === 'fact' ? 0.9 : status === 'inference' ? 0.6 : 0.3);

/** Pull a status tag back out of a stored memory's tags. */
function statusOf(tags: string[]): KnowledgeStatus | null {
  if (tags.includes('fact')) return 'fact';
  if (tags.includes('inference')) return 'inference';
  if (tags.includes('uncertain')) return 'uncertain';
  return null;
}
function tagValue(tags: string[], prefix: string): string | null {
  const t = tags.find((x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length) : null;
}

export class LearningPipeline {
  private memory: MemoryStore;

  constructor(memory: MemoryStore) {
    this.memory = memory;
  }

  /**
   * Deterministically extract knowledge items from lesson text. Recognises explicit markers that
   * accessible lesson material commonly carries — "Definition:", "Term — meaning", "Example:",
   * "Key concept:", "Caption:"/transcript lines, "Q:"/"?" — and never emits anything not in the text.
   */
  extract(text: string, captions?: string): LearningNote[] {
    const notes: LearningNote[] = [];
    const seen = new Set<string>();
    const push = (n: LearningNote) => {
      const key = `${n.kind}|${(n.term ?? '').toLowerCase()}|${n.content.toLowerCase()}`;
      if (n.content.trim().length < 3 || seen.has(key)) return;
      seen.add(key);
      notes.push(n);
    };
    const terms: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^(?:definition|def)\s*[:\-]\s*(.+)$/i))) {
        push({ kind: 'definition', term: null, content: m[1].trim(), status: 'fact' });
      } else if ((m = line.match(/^(?:key\s+)?(?:term|concept)\s*[:\-]\s*(.+?)\s*(?:[—–-]|:)\s*(.+)$/i))) {
        terms.push(m[1].trim());
        push({ kind: 'definition', term: m[1].trim(), content: `${m[1].trim()}: ${m[2].trim()}`, status: 'fact' });
      } else if ((m = line.match(/^(?:example|e\.g\.)\s*[:\-]\s*(.+)$/i))) {
        push({ kind: 'example', term: null, content: m[1].trim(), status: 'fact' });
      } else if ((m = line.match(/^(?:key concept|concept|takeaway|summary)\s*[:\-]\s*(.+)$/i))) {
        push({ kind: 'takeaway', term: null, content: m[1].trim(), status: 'fact' });
      } else if ((m = line.match(/^(?:q|question)\s*[:\-]\s*(.+)$/i)) || line.endsWith('?')) {
        push({ kind: 'question', term: null, content: (m ? m[1] : line).trim(), status: 'uncertain' });
      } else if ((m = line.match(/^(?:caption|transcript)\s*[:\-]\s*(.+)$/i))) {
        push({ kind: 'caption', term: null, content: m[1].trim(), status: 'fact' });
      }
    }
    for (const raw of (captions ?? '').split(/\r?\n/)) {
      const line = raw.trim().replace(/^(?:caption|transcript)\s*[:\-]\s*/i, '');
      if (line.length >= 3) push({ kind: 'caption', term: null, content: line, status: 'fact' });
    }
    // One INFERENCE note per lesson when several terms co-occur — explicitly marked as derived.
    if (terms.length >= 2) push({ kind: 'concept', term: null, content: `This lesson relates: ${terms.join(', ')}.`, status: 'inference' });
    return notes;
  }

  /** Extract a lesson's notes and store each as a persistent, attributed memory. */
  ingestLesson(input: LessonIngest): IngestResult {
    const courseSlug = slug(input.course);
    const lessonSlug = slug(`${input.lessonNumber ? `${input.lessonNumber}-` : ''}${input.lesson}`);
    const notes = this.extract(input.text, input.captions);
    const observedAt = input.observedAt ?? Date.now();
    let stored = 0;
    for (const n of notes) {
      const label = `[${input.course} / ${input.lesson}] ${n.kind}${n.term ? ` (${n.term})` : ''}: ${n.content}`;
      this.memory.add({
        kind: 'fact',
        content: label.slice(0, 4000),
        source: `learn:${courseSlug}/${lessonSlug}`,
        sourceRef: input.sourceUrl ?? `${courseSlug}/${lessonSlug}@${observedAt}`,
        tags: ['learn', `course:${courseSlug}`, `lesson:${lessonSlug}`, n.kind, n.status],
        verified: false,
        confidence: confidenceFor(n.status),
      });
      stored++;
    }
    return { course: input.course, courseSlug, lesson: input.lesson, lessonSlug, extracted: notes.length, stored, notes };
  }

  /** What was learned, straight from persistent memory. Returns only stored notes — never invented. */
  recall(query: string, opts: { courseSlug?: string; limit?: number } = {}): RecalledNote[] {
    const hits = this.memory.keywordSearch(query, { limit: opts.limit ?? 20 });
    return hits
      .filter((m) => m.tags.includes('learn') && (!opts.courseSlug || m.tags.includes(`course:${opts.courseSlug}`)))
      .map((m: ScoredMemory) => ({
        content: m.content,
        course: tagValue(m.tags, 'course:'),
        lesson: tagValue(m.tags, 'lesson:'),
        status: statusOf(m.tags),
        source: m.source,
        score: m.score,
      }));
  }

  /** Distinct courses Jarvis has learned from (from memory tags). */
  courses(): Array<{ courseSlug: string; notes: number }> {
    const counts = new Map<string, number>();
    for (const m of this.memory.list({ kind: 'fact', limit: 5000 })) {
      const c = tagValue(m.tags, 'course:');
      if (m.tags.includes('learn') && c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()].map(([courseSlug, notes]) => ({ courseSlug, notes }));
  }
}
