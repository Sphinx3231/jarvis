import type { MemoryStore, ScoredMemory } from '../memory/store.ts';
import { quarantineInstructions, redactSecrets } from './guard.ts';

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
  /** The observation session this came from (watch mode). */
  sessionId?: string;
  /** Where it was seen: site/app name (e.g. "Udemy", "Chrome"). */
  site?: string;
  /** Position in the media when known (e.g. "04:12"). */
  mediaTime?: string;
}

export interface IngestResult {
  course: string;
  courseSlug: string;
  lesson: string;
  lessonSlug: string;
  extracted: number;
  stored: number;
  /** Notes that were already known (same content) and merged instead of duplicated. */
  merged: number;
  notes: LearningNote[];
  /** Lines that tried to instruct Jarvis (prompt injection) — dropped, never stored as knowledge. */
  quarantined: string[];
  /** Credential-shaped strings redacted before anything was stored. */
  redacted: number;
}

export interface RecalledNote {
  content: string;
  course: string | null;
  lesson: string | null;
  status: KnowledgeStatus | null;
  source: string;
  score: number;
  lessonNumber?: number | null;
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

const DEFINITION_SENTENCE = /^((?:an?\s+|the\s+)?[A-Z][\w'’\- ]{1,48}?)\s+(?:is|are)\s+(?:defined as|called|known as|an?|the|one of|how|what|when|where|a type of|a kind of|a process|a set)\b.{8,}$|^((?:an?\s+|the\s+)?[A-Z][\w'’\- ]{1,48}?)\s+(?:refers? to|means|describes|stands for)\s+.{6,}$/;
const EXAMPLE_SENTENCE = /^(?:for example|for instance|e\.g\.|as an example|consider)\b/i;

function splitSentences(line: string): string[] {
  return (line.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [line]).map((x) => x.trim()).filter((x) => x.length >= 12 && x.length <= 600);
}

/** A plausible term: 1–5 words, not a pronoun/sentence opener. */
function isTermLike(t: string | undefined): boolean {
  if (!t) return false;
  const words = t.trim().split(/\s+/);
  if (words.length > 5) return false;
  return !/^(it|this|that|these|those|there|here|he|she|they|we|you|i|what|which|who|today|now|next|our|my|your)$/i.test(words[0]);
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
      } else if ((m = line.match(/^(?:important|note|remember|tip|key point|in summary)\s*[:\-]\s*(.+)$/i))) {
        push({ kind: 'takeaway', term: null, content: m[1].trim(), status: 'fact' });
      } else {
        // Ordinary prose (real courses rarely label things). Only VERBATIM sentences of a recognisable
        // shape are kept — a definition sentence, an example sentence — nothing is paraphrased.
        for (const sentence of splitSentences(line)) {
          const def = sentence.match(DEFINITION_SENTENCE);
          if (def && isTermLike(def[1] ?? def[2])) {
            const term = (def[1] ?? def[2]).replace(/^(?:an?|the)\s+/i, '').trim();
            terms.push(term);
            push({ kind: 'definition', term, content: sentence, status: 'fact' });
            continue;
          }
          if (EXAMPLE_SENTENCE.test(sentence)) {
            push({ kind: 'example', term: null, content: sentence.replace(EXAMPLE_SENTENCE, '').replace(/^[,:\s]+/, '').replace(/^\w/, (c) => c.toUpperCase()), status: 'fact' });
          }
        }
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
    // Screen/page content is untrusted: drop instruction-like lines, redact anything credential-shaped.
    const q1 = quarantineInstructions(input.text);
    const q2 = quarantineInstructions(input.captions ?? '');
    const r1 = redactSecrets(q1.clean);
    const r2 = redactSecrets(q2.clean);
    const notes = this.extract(r1.text, r2.text || undefined);
    const observedAt = input.observedAt ?? Date.now();
    const when = new Date(observedAt).toISOString();
    let stored = 0;
    let merged = 0;
    for (const n of notes) {
      const label = `[${input.course} / ${input.lessonNumber ? `Lesson ${input.lessonNumber}: ` : ''}${input.lesson}] ${n.status.toUpperCase()} ${n.kind}${n.term ? ` (${n.term})` : ''}: ${n.content}`;
      const res = this.memory.add({
        kind: 'fact',
        content: label.slice(0, 4000),
        source: `learn:${courseSlug}/${lessonSlug}`,
        sourceRef: `${input.sourceUrl ?? `${courseSlug}/${lessonSlug}`} @ ${when}${input.mediaTime ? ` t=${input.mediaTime}` : ''}${input.site ? ` via ${input.site}` : ''}${input.sessionId ? ` session=${input.sessionId}` : ''}`.slice(0, 1000),
        tags: ['learn', `course:${courseSlug}`, `lesson:${lessonSlug}`, n.kind, n.status, ...(input.lessonNumber ? [`lessonno:${input.lessonNumber}`] : []), ...(input.sessionId ? [`session:${input.sessionId.slice(0, 40)}`] : [])],
        verified: false,
        confidence: confidenceFor(n.status),
      });
      if (res.merged) merged++;
      else stored++;
    }
    return { course: input.course, courseSlug, lesson: input.lesson, lessonSlug, extracted: notes.length, stored, merged, notes, quarantined: [...q1.quarantined, ...q2.quarantined].map((q) => q.line), redacted: r1.redacted + r2.redacted };
  }

  /** Every stored note of a course (optionally one lesson), in lesson order. Only stored notes. */
  notesFor(courseSlug: string, opts: { lesson?: string | number } = {}): RecalledNote[] {
    const want = typeof opts.lesson === 'number' ? `lessonno:${opts.lesson}` : opts.lesson ? `lesson:${slug(opts.lesson)}` : null;
    const rows = this.memory.list({ kind: 'fact', limit: 5000 }).filter((m) => m.tags.includes('learn') && m.tags.includes(`course:${courseSlug}`));
    return rows
      .filter((m) => !want || m.tags.includes(want) || (typeof opts.lesson === 'string' && (tagValue(m.tags, 'lesson:') ?? '').includes(slug(opts.lesson))))
      .map((m) => ({ content: m.content, course: tagValue(m.tags, 'course:'), lesson: tagValue(m.tags, 'lesson:'), status: statusOf(m.tags), source: m.sourceRef ?? m.source, score: 1, lessonNumber: Number(tagValue(m.tags, 'lessonno:')) || null }))
      .sort((a, b) => (a.lessonNumber ?? 0) - (b.lessonNumber ?? 0) || a.content.localeCompare(b.content));
  }

  /** Structured summary of what was learned from a course: lessons, counts by kind/status. */
  courseSummary(courseSlug: string): { courseSlug: string; lessons: Array<{ lesson: string; lessonNumber: number | null; notes: number; definitions: string[]; takeaways: string[]; questions: string[] }>; totals: Record<string, number> } {
    const notes = this.notesFor(courseSlug);
    const byLesson = new Map<string, { lesson: string; lessonNumber: number | null; notes: number; definitions: string[]; takeaways: string[]; questions: string[] }>();
    const totals: Record<string, number> = {};
    for (const n of notes) {
      const key = n.lesson ?? '?';
      const entry = byLesson.get(key) ?? { lesson: key, lessonNumber: (n as RecalledNote & { lessonNumber?: number | null }).lessonNumber ?? null, notes: 0, definitions: [], takeaways: [], questions: [] };
      entry.notes++;
      const body = n.content.replace(/^\[[^\]]*\]\s*/, '');
      if (/\bdefinition\b/.test(body.slice(0, 40))) entry.definitions.push(body);
      else if (/\btakeaway\b/.test(body.slice(0, 40))) entry.takeaways.push(body);
      else if (/\bquestion\b/.test(body.slice(0, 40))) entry.questions.push(body);
      byLesson.set(key, entry);
      totals[n.status ?? 'unknown'] = (totals[n.status ?? 'unknown'] ?? 0) + 1;
    }
    return { courseSlug, lessons: [...byLesson.values()].sort((a, b) => (a.lessonNumber ?? 0) - (b.lessonNumber ?? 0)), totals };
  }

  /** Compare what was learned about `query` across two courses/lessons — only stored notes. */
  compare(query: string, a: { courseSlug: string; lesson?: string | number }, b: { courseSlug: string; lesson?: string | number }): { query: string; a: RecalledNote[]; b: RecalledNote[]; shared: string[] } {
    const pick = (side: { courseSlug: string; lesson?: string | number }) => {
      const hits = this.recall(query, { courseSlug: side.courseSlug, limit: 50 });
      if (side.lesson === undefined) return hits;
      const want = typeof side.lesson === 'number' ? null : slug(side.lesson);
      const lessonSet = new Set(this.notesFor(side.courseSlug, { lesson: side.lesson }).map((n) => n.content));
      return hits.filter((h) => lessonSet.has(h.content) || (want !== null && (h.lesson ?? '').includes(want)));
    };
    const A = pick(a);
    const B = pick(b);
    const words = (notes: RecalledNote[]) => new Set(notes.flatMap((n) => n.content.toLowerCase().match(/[a-z]{5,}/g) ?? []));
    const wa = words(A);
    const shared = [...words(B)].filter((w) => wa.has(w)).slice(0, 30);
    return { query, a: A, b: B, shared };
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
