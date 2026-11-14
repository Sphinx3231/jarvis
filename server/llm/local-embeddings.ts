import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmbeddingProvider } from './types.ts';

/**
 * Built-in semantic search: the all-MiniLM-L6-v2 sentence-embedding model (384 dimensions)
 * running locally on the WebAssembly ONNX runtime — no native modules, no external service.
 * The model is downloaded once from Hugging Face, pinned to an exact revision and verified by
 * SHA-256. Text never leaves the computer.
 */

export const LOCAL_MODEL = {
  id: 'builtin/all-MiniLM-L6-v2',
  repo: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dims: 384,
  files: {
    model: { path: 'onnx/model_quantized.onnx', sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1', bytes: 22_972_370 },
    vocab: { path: 'vocab.txt', sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3', bytes: 231_508 },
  },
} as const;

const MAX_TOKENS = 256;

// ---------------------------------------------------------------- BERT WordPiece tokenizer

function isPunctuation(cp: number): boolean {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(String.fromCodePoint(cp));
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

export class WordPieceTokenizer {
  private vocab = new Map<string, number>();
  readonly cls: number;
  readonly sep: number;
  readonly unk: number;

  constructor(vocabText: string) {
    vocabText.split('\n').forEach((tok, i) => {
      const t = tok.replace(/\r$/, '');
      if (t && !this.vocab.has(t)) this.vocab.set(t, i);
    });
    this.cls = this.vocab.get('[CLS]')!;
    this.sep = this.vocab.get('[SEP]')!;
    this.unk = this.vocab.get('[UNK]')!;
  }

  /** Lowercase, strip accents, split on whitespace/punctuation/CJK (BERT "basic" tokenizer). */
  basic(text: string): string[] {
    const cleaned = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Mn}/gu, '')
      .replace(/[\u0000�]|\p{Cc}/gu, (c) => (/\s/.test(c) ? ' ' : ''));
    const out: string[] = [];
    let cur = '';
    for (const ch of cleaned) {
      const cp = ch.codePointAt(0)!;
      if (/\s/.test(ch)) {
        if (cur) out.push(cur);
        cur = '';
      } else if (isPunctuation(cp) || isCjk(cp)) {
        if (cur) out.push(cur);
        out.push(ch);
        cur = '';
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  wordPiece(word: string): number[] {
    if (word.length > 100) return [this.unk];
    const ids: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found: number | undefined;
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + word.slice(start, end);
        found = this.vocab.get(piece);
        if (found !== undefined) break;
        end--;
      }
      if (found === undefined) return [this.unk];
      ids.push(found);
      start = end;
    }
    return ids;
  }

  encode(text: string): number[] {
    const ids: number[] = [];
    for (const w of this.basic(text)) {
      ids.push(...this.wordPiece(w));
      if (ids.length >= MAX_TOKENS - 2) break;
    }
    return [this.cls, ...ids.slice(0, MAX_TOKENS - 2), this.sep];
  }
}

// ---------------------------------------------------------------- model files

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

export type LocalModelState = 'not_downloaded' | 'downloading' | 'ready' | 'error';

export async function downloadLocalModel(dir: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const file of Object.values(LOCAL_MODEL.files)) {
    const target = join(dir, file.path.split('/').pop()!);
    if (existsSync(target) && sha256(readFileSync(target)) === file.sha256) continue;
    const url = `https://huggingface.co/${LOCAL_MODEL.repo}/resolve/${LOCAL_MODEL.revision}/${file.path}`;
    const res = await fetchImpl(url, { signal: signal ?? AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status} for ${file.path}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== file.sha256) throw new Error(`Model file ${file.path} failed its integrity check`);
    const tmp = `${target}.part`;
    writeFileSync(tmp, buf);
    renameSync(tmp, target);
  }
}

export function localModelPresent(dir: string): boolean {
  return Object.values(LOCAL_MODEL.files).every((f) => existsSync(join(dir, f.path.split('/').pop()!)));
}

export function removeLocalModel(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- embedder

type Ort = typeof import('onnxruntime-web');
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;

export class LocalEmbeddings implements EmbeddingProvider {
  readonly model = LOCAL_MODEL.id;
  private dir: string;
  private loading: Promise<{ ort: Ort; session: Session; tokenizer: WordPieceTokenizer }> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  private load() {
    this.loading ??= (async () => {
      if (!localModelPresent(this.dir)) throw new Error('The built-in embedding model has not been downloaded yet');
      const ort = (await import('onnxruntime-web')) as Ort;
      ort.env.wasm.numThreads = 1; // deterministic and light; no worker threads
      const tokenizer = new WordPieceTokenizer(readFileSync(join(this.dir, 'vocab.txt'), 'utf8'));
      const session = await ort.InferenceSession.create(readFileSync(join(this.dir, 'model_quantized.onnx')), { executionProviders: ['wasm'] });
      return { ort, session, tokenizer };
    })().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  /** Batches run one at a time so memory use stays flat. */
  embed(texts: string[]): Promise<number[][]> {
    const run = this.queue.then(() => this.embedNow(texts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async embedNow(texts: string[]): Promise<number[][]> {
    const { ort, session, tokenizer } = await this.load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => tokenizer.encode(t));
      const len = Math.max(...batch.map((b) => b.length));
      const ids = new BigInt64Array(batch.length * len);
      const mask = new BigInt64Array(batch.length * len);
      batch.forEach((seq, r) =>
        seq.forEach((id, c) => {
          ids[r * len + c] = BigInt(id);
          mask[r * len + c] = 1n;
        }),
      );
      const dims = [batch.length, len];
      const feeds: Record<string, InstanceType<Ort['Tensor']>> = {
        input_ids: new ort.Tensor('int64', ids, dims),
        attention_mask: new ort.Tensor('int64', mask, dims),
      };
      if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(batch.length * len), dims);
      const result = await session.run(feeds);
      const hidden = result[session.outputNames[0]];
      const data = hidden.data as Float32Array;
      const dim = hidden.dims[2];
      batch.forEach((seq, r) => {
        // Mean pooling over real tokens, then L2 normalisation.
        const v = new Float64Array(dim);
        for (let c = 0; c < seq.length; c++) for (let d = 0; d < dim; d++) v[d] += data[(r * len + c) * dim + d];
        let norm = 0;
        for (let d = 0; d < dim; d++) {
          v[d] /= seq.length;
          norm += v[d] * v[d];
        }
        norm = Math.sqrt(norm) || 1;
        out.push(Array.from(v, (x) => x / norm));
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------- lifecycle

/** Tracks the built-in model: download once (deduplicated), report state, hand out the embedder. */
export class LocalModelManager {
  readonly dir: string;
  state: LocalModelState;
  error: string | null = null;
  private inflight: Promise<void> | null = null;
  private embedder: LocalEmbeddings | null = null;
  private fetchImpl: typeof fetch;
  onChange: (state: LocalModelState) => void = () => {};

  constructor(dir: string, fetchImpl: typeof fetch = fetch) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.state = localModelPresent(dir) ? 'ready' : 'not_downloaded';
  }

  ensure(signal?: AbortSignal): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    this.inflight ??= (async () => {
      this.set('downloading');
      try {
        await downloadLocalModel(this.dir, signal, this.fetchImpl);
        this.error = null;
        this.set('ready');
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.set('error');
        throw err;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private set(state: LocalModelState): void {
    this.state = state;
    this.onChange(state);
  }

  get(): LocalEmbeddings | null {
    if (this.state !== 'ready') return null;
    this.embedder ??= new LocalEmbeddings(this.dir);
    return this.embedder;
  }

  remove(): void {
    this.embedder = null;
    removeLocalModel(this.dir);
    this.set('not_downloaded');
  }
}
