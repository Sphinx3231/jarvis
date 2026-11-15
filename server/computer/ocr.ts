import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasBinary, run } from './exec.ts';
import { OCR_PROBE_PNG_BASE64, OCR_PROBE_TEXT } from './probe-image.ts';
import type { OcrResult, OcrWord } from './types.ts';

/**
 * OCR by spawning the system `tesseract` binary (standard on Kali; `apt install tesseract-ocr`, a
 * Homebrew/winget package elsewhere). No bundled WASM, no network, no display. OCR runs BEFORE any
 * vision-model call so screen text is extracted cheaply; the text it returns is untrusted data.
 */

export function ocrAvailable(): boolean {
  return hasBinary('tesseract');
}

export interface OcrOptions {
  signal: AbortSignal;
  lang?: string;
  /** Also parse word-level boxes/confidence (tesseract tsv). Slightly slower. */
  words?: boolean;
}

/** OCR a PNG/JPEG file. Throws when tesseract isn't installed or fails — honestly. */
export async function ocrImage(imagePath: string, opts: OcrOptions): Promise<OcrResult> {
  if (!ocrAvailable()) throw new Error('OCR needs the tesseract binary (install tesseract-ocr).');
  const lang = /^[a-z]{2,8}(\+[a-z]{2,8})*$/i.test(opts.lang ?? '') ? (opts.lang as string) : 'eng';
  const base = ['-l', lang, '--psm', '3'];
  const text = (await run('tesseract', [imagePath, 'stdout', ...base], opts.signal, 20000)).stdout.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  let words: OcrWord[] = [];
  let meanConfidence: number | null = null;
  if (opts.words) {
    try {
      const tsv = (await run('tesseract', [imagePath, 'stdout', ...base, 'tsv'], opts.signal, 20000)).stdout;
      ({ words, meanConfidence } = parseTsv(tsv));
    } catch {
      /* word boxes are best-effort */
    }
  }
  return { text, words, engine: 'tesseract', meanConfidence };
}

/** tesseract TSV: level page block par line word left top width height conf text. */
function parseTsv(tsv: string): { words: OcrWord[]; meanConfidence: number | null } {
  const words: OcrWord[] = [];
  let confSum = 0;
  let confN = 0;
  for (const line of tsv.split('\n')) {
    const c = line.split('\t');
    if (c.length < 12 || c[0] === 'level') continue;
    const conf = Number(c[10]);
    const text = c[11]?.trim();
    if (!text || !Number.isFinite(conf) || conf < 0) continue;
    words.push({ text, confidence: conf, box: { x: Number(c[6]), y: Number(c[7]), w: Number(c[8]), h: Number(c[9]) } });
    confSum += conf;
    confN++;
  }
  return { words, meanConfidence: confN ? Math.round((confSum / confN) * 10) / 10 : null };
}

/**
 * Runtime self-verification: OCR a tiny embedded image whose text we know. Returns true only when
 * tesseract actually reads it back correctly on THIS machine — the evidence the capability report
 * needs before it may call OCR "available".
 */
export async function verifyOcr(signal: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  if (!ocrAvailable()) return { ok: false, detail: 'tesseract not installed' };
  const file = join(tmpdir(), `jarvis-ocr-probe-${Date.now()}.png`);
  try {
    await writeFile(file, Buffer.from(OCR_PROBE_PNG_BASE64, 'base64'));
    const res = await ocrImage(file, { signal });
    const ok = res.text.toUpperCase().includes(OCR_PROBE_TEXT);
    return { ok, detail: ok ? `read "${OCR_PROBE_TEXT}" from the probe image` : `probe OCR returned ${JSON.stringify(res.text.slice(0, 40))}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  } finally {
    await unlink(file).catch(() => {});
  }
}
