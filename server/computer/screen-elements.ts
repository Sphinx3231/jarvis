import type { OcrWord } from './types.ts';

/**
 * Screen understanding from OCR word boxes — the fallback "eyes" for applications that expose no
 * accessibility tree (or a browser without a DevTools connection). It groups words into lines and
 * finds a phrase (e.g. "Submit", "Next lesson") on screen, returning where to click.
 *
 * Coordinates are fragile, so this is only ever used to *find* a target by its visible text right
 * before acting, never cached between actions; the result is re-observed afterwards to verify.
 */

export interface ScreenTextMatch {
  text: string;
  /** Center point to click, in screen pixels. */
  x: number;
  y: number;
  box: { x: number; y: number; w: number; h: number };
  confidence: number;
  /** 4 = exact phrase, 3 = phrase prefix, 2 = contained, 1 = fuzzy (OCR noise tolerated). */
  score: number;
}

export interface ScreenLine {
  words: OcrWord[];
  text: string;
  box: { x: number; y: number; w: number; h: number };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Group OCR words into visual lines (same baseline band, left-to-right). */
export function groupLines(words: OcrWord[]): ScreenLine[] {
  const sorted = [...words].filter((w) => w.text.trim()).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const lines: OcrWord[][] = [];
  for (const w of sorted) {
    const mid = w.box.y + w.box.h / 2;
    const line = lines.find((l) => {
      const ref = l[0];
      const refMid = ref.box.y + ref.box.h / 2;
      return Math.abs(refMid - mid) <= Math.max(ref.box.h, w.box.h) * 0.6;
    });
    if (line) line.push(w);
    else lines.push([w]);
  }
  return lines.map((ws) => {
    ws.sort((a, b) => a.box.x - b.box.x);
    const x = Math.min(...ws.map((w) => w.box.x));
    const y = Math.min(...ws.map((w) => w.box.y));
    const r = Math.max(...ws.map((w) => w.box.x + w.box.w));
    const b = Math.max(...ws.map((w) => w.box.y + w.box.h));
    return { words: ws, text: ws.map((w) => w.text).join(' '), box: { x, y, w: r - x, h: b - y } };
  });
}

/** Levenshtein distance, small strings only (OCR tolerance). */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Find a phrase on screen. Matches runs of consecutive words on one line; exact matches beat partial
 * ones, and a little OCR noise (1 edit per ~5 chars) is tolerated for a "fuzzy" match.
 */
export function findTextOnScreen(words: OcrWord[], query: string, opts: { minConfidence?: number } = {}): ScreenTextMatch[] {
  const want = norm(query);
  if (!want) return [];
  const wantWords = want.split(' ');
  const minConf = opts.minConfidence ?? 30;
  const out: ScreenTextMatch[] = [];
  for (const line of groupLines(words.filter((w) => w.confidence >= minConf))) {
    const ws = line.words;
    for (let i = 0; i < ws.length; i++) {
      for (let len = 1; len <= Math.min(ws.length - i, wantWords.length + 2); len++) {
        const run = ws.slice(i, i + len);
        const text = norm(run.map((w) => w.text).join(' '));
        if (!text) continue;
        let score = 0;
        if (text === want) score = 4;
        else if (len >= wantWords.length && text.startsWith(want + ' ')) score = 3;
        else if (len === wantWords.length && text.includes(want)) score = 2;
        else if (len === wantWords.length && want.length >= 4 && distance(text, want) <= Math.max(1, Math.floor(want.length / 5))) score = 1;
        if (!score) continue;
        const x = Math.min(...run.map((w) => w.box.x));
        const y = Math.min(...run.map((w) => w.box.y));
        const r = Math.max(...run.map((w) => w.box.x + w.box.w));
        const b = Math.max(...run.map((w) => w.box.y + w.box.h));
        out.push({
          text: run.map((w) => w.text).join(' '),
          x: Math.round((x + r) / 2),
          y: Math.round((y + b) / 2),
          box: { x, y, w: r - x, h: b - y },
          confidence: Math.round(run.reduce((s, w) => s + w.confidence, 0) / run.length),
          score,
        });
      }
    }
  }
  // Best first: score, then confidence, then top-to-bottom.
  out.sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.y - b.y);
  // Drop overlapping duplicates (same spot found via different run lengths).
  const kept: ScreenTextMatch[] = [];
  for (const m of out) if (!kept.some((k) => Math.abs(k.x - m.x) < 6 && Math.abs(k.y - m.y) < 6)) kept.push(m);
  return kept;
}

/** Simple screen-layout summary from OCR lines: top bar, body, bottom — for "explain my screen". */
export function describeLayout(words: OcrWord[], screen: { width: number; height: number }): { top: string[]; middle: string[]; bottom: string[] } {
  const lines = groupLines(words);
  const top: string[] = [];
  const middle: string[] = [];
  const bottom: string[] = [];
  for (const l of lines) {
    const mid = l.box.y + l.box.h / 2;
    (mid < screen.height * 0.12 ? top : mid > screen.height * 0.88 ? bottom : middle).push(l.text);
  }
  return { top, middle, bottom };
}
