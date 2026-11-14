import { createHash, randomBytes } from 'node:crypto';

export const now = (): number => Date.now();

/** Short, sortable-ish unique id with a readable prefix (e.g. "tsk_lk2j3_ab12cd"). */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Stable JSON stringify (sorted keys) so equal objects hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|cookie|credential)/i;
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[bap]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,})\b/g;

/** Recursively redact values that look like credentials before logging or returning them. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth limit]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) && v !== null && v !== undefined && v !== '' ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

/** Run a promise with a timeout, aborting the provided controller when the timer fires. */
export async function withTimeout<T>(ms: number, controller: AbortController, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new TimeoutError(`Timed out after ${ms} ms`);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Error that is safe to show to the user verbatim and carries an HTTP status. */
export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}
