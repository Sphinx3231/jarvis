import type { Database } from '../db/database.ts';
import type { EventBus } from '../core/events.ts';
import { newId, now, parseJson, sha256, UserError } from '../core/util.ts';

export const MEMORY_KINDS = ['preference', 'project', 'decision', 'procedure', 'fact', 'task_history', 'tool_doc'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  id: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  source: string;
  sourceRef: string | null;
  sources: string[];
  confidence: number;
  verified: boolean;
  mergedCount: number;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  updatedAt: number;
  hasEmbedding: boolean;
}

export interface NewMemory {
  kind: MemoryKind;
  content: string;
  tags?: string[];
  /** Who/what produced it: "user", "user (chat)", "jarvis (inferred)", "task:<id>", "system". */
  source: string;
  sourceRef?: string | null;
  confidence?: number;
  /** Only memories stated or confirmed by the user (or recorded by the system itself) are verified. */
  verified?: boolean;
}

export interface ScoredMemory extends Memory {
  score: number;
  matchedBy: 'keyword' | 'semantic' | 'both';
}

const NEAR_DUPLICATE_THRESHOLD = 0.85;

export function normalizeContent(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(text: string): Set<string> {
  const s = ` ${normalizeContent(text)} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}

export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Turn free text into a safe FTS5 query: quoted tokens OR'ed together. */
export function ftsQuery(text: string): string | null {
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 24);
  const unique = [...new Set(tokens)];
  return unique.length ? unique.map((t) => `"${t}"`).join(' OR ') : null;
}

function toVector(blob: unknown): Float32Array | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength % 4 !== 0) return null;
  return new Float32Array(blob.slice().buffer);
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class MemoryStore {
  private db: Database;
  private bus: EventBus;

  constructor(db: Database, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  private map(r: Record<string, unknown>): Memory {
    return {
      id: String(r.id),
      kind: r.kind as MemoryKind,
      content: String(r.content),
      tags: parseJson<string[]>(r.tags as string, []),
      source: String(r.source),
      sourceRef: (r.source_ref as string | null) ?? null,
      sources: parseJson<string[]>(r.sources as string, []),
      confidence: Number(r.confidence),
      verified: Number(r.verified) === 1,
      mergedCount: Number(r.merged_count),
      accessCount: Number(r.access_count),
      lastAccessedAt: r.last_accessed_at === null ? null : Number(r.last_accessed_at),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      hasEmbedding: r.has_embedding !== undefined ? Number(r.has_embedding) === 1 : r.embedding !== null && r.embedding !== undefined,
    };
  }

  private static cols(alias = ''): string {
    const p = alias ? `${alias}.` : '';
    return ['id', 'kind', 'content', 'tags', 'source', 'source_ref', 'sources', 'confidence', 'verified', 'merged_count', 'access_count', 'last_accessed_at', 'created_at', 'updated_at']
      .map((c) => p + c)
      .concat(`(${p}embedding IS NOT NULL) AS has_embedding`)
      .join(', ');
  }
  private static readonly COLS = MemoryStore.cols();

  get(id: string): Memory | undefined {
    const row = this.db.get<Record<string, unknown>>(`SELECT ${MemoryStore.COLS} FROM memories WHERE id = ?`, id);
    return row ? this.map(row) : undefined;
  }

  /**
   * Store a memory, merging it into an existing one when it is an exact or near duplicate.
   * Merging never upgrades an unverified claim's content; it only records the extra source
   * and, if the new evidence is verified, marks the memory verified.
   */
  add(input: NewMemory): { memory: Memory; merged: boolean } {
    const content = input.content.trim();
    if (!content) throw new UserError('Memory content cannot be empty');
    if (content.length > 4000) throw new UserError('Memory content is too long (max 4000 characters)');
    if (!MEMORY_KINDS.includes(input.kind)) throw new UserError(`Unknown memory kind "${input.kind}"`);
    const hash = sha256(normalizeContent(content));
    const verified = input.verified ?? false;
    const confidence = Math.min(1, Math.max(0, input.confidence ?? (verified ? 1 : 0.6)));

    const duplicate = this.findDuplicate(input.kind, content, hash);
    if (duplicate) {
      const sources = [...new Set([...duplicate.sources, input.source])].slice(-20);
      this.db.run(
        `UPDATE memories SET sources = ?, merged_count = merged_count + 1, confidence = MAX(confidence, ?),
           verified = MAX(verified, ?), updated_at = ? WHERE id = ?`,
        JSON.stringify(sources),
        confidence,
        verified ? 1 : 0,
        now(),
        duplicate.id,
      );
      const memory = this.get(duplicate.id)!;
      this.bus.emit('memory.changed', { id: memory.id, action: 'merged' });
      return { memory, merged: true };
    }

    const id = newId('mem');
    const ts = now();
    this.db.run(
      `INSERT INTO memories (id, kind, content, tags, source, source_ref, sources, confidence, verified, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      content,
      JSON.stringify((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12)),
      input.source,
      input.sourceRef ?? null,
      JSON.stringify([input.source]),
      confidence,
      verified ? 1 : 0,
      hash,
      ts,
      ts,
    );
    const memory = this.get(id)!;
    this.bus.emit('memory.changed', { id, action: 'created' });
    return { memory, merged: false };
  }

  private findDuplicate(kind: MemoryKind, content: string, hash: string): Memory | undefined {
    const exact = this.db.get<Record<string, unknown>>(`SELECT ${MemoryStore.COLS} FROM memories WHERE content_hash = ? AND kind = ?`, hash, kind);
    if (exact) return this.map(exact);
    for (const candidate of this.keywordSearch(content, { kind, limit: 8 })) {
      if (similarity(candidate.content, content) >= NEAR_DUPLICATE_THRESHOLD) return candidate;
    }
    return undefined;
  }

  /** User correction. Editing content counts as the user confirming it. */
  update(id: string, patch: { content?: string; kind?: MemoryKind; tags?: string[]; verified?: boolean; confidence?: number }): Memory {
    const existing = this.get(id);
    if (!existing) throw new UserError('Memory not found', 404);
    const content = patch.content?.trim() ?? existing.content;
    if (!content) throw new UserError('Memory content cannot be empty');
    const kind = patch.kind ?? existing.kind;
    if (!MEMORY_KINDS.includes(kind)) throw new UserError(`Unknown memory kind "${kind}"`);
    const contentChanged = content !== existing.content;
    const verified = patch.verified ?? (contentChanged ? true : existing.verified);
    const confidence = patch.confidence ?? (verified ? 1 : existing.confidence);
    const sources = contentChanged ? [...new Set([...existing.sources, 'user (edited)'])].slice(-20) : existing.sources;
    this.db.run(
      `UPDATE memories SET content = ?, kind = ?, tags = ?, verified = ?, confidence = ?, sources = ?, content_hash = ?,
         embedding = CASE WHEN ? THEN NULL ELSE embedding END, embedding_model = CASE WHEN ? THEN NULL ELSE embedding_model END,
         updated_at = ? WHERE id = ?`,
      content,
      kind,
      JSON.stringify(patch.tags ?? existing.tags),
      verified ? 1 : 0,
      Math.min(1, Math.max(0, confidence)),
      JSON.stringify(sources),
      sha256(normalizeContent(content)),
      contentChanged ? 1 : 0,
      contentChanged ? 1 : 0,
      now(),
      id,
    );
    this.bus.emit('memory.changed', { id, action: 'updated' });
    return this.get(id)!;
  }

  delete(id: string): boolean {
    const { changes } = this.db.run('DELETE FROM memories WHERE id = ?', id);
    if (changes) this.bus.emit('memory.changed', { id, action: 'deleted' });
    return changes > 0;
  }

  list(opts: { kind?: MemoryKind; verified?: boolean; limit?: number; offset?: number } = {}): Memory[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.verified !== undefined) {
      where.push('verified = ?');
      params.push(opts.verified ? 1 : 0);
    }
    const sql = `SELECT ${MemoryStore.COLS} FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    return this.db.all<Record<string, unknown>>(sql, ...params, opts.limit ?? 100, opts.offset ?? 0).map((r) => this.map(r));
  }

  keywordSearch(query: string, opts: { kind?: MemoryKind; limit?: number; excludeKinds?: MemoryKind[] } = {}): ScoredMemory[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const params: (string | number)[] = [q];
    let filter = '';
    if (opts.kind) {
      filter += ' AND m.kind = ?';
      params.push(opts.kind);
    }
    for (const k of opts.excludeKinds ?? []) {
      filter += ' AND m.kind != ?';
      params.push(k);
    }
    params.push(opts.limit ?? 20);
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT ${MemoryStore.cols('m')}, bm25(memories_fts) AS rank
       FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ? ${filter} ORDER BY rank LIMIT ?`,
      ...params,
    );
    // bm25 is negative (more negative = better). Convert to a 0..1 score.
    return rows.map((r) => ({ ...this.map(r), score: 1 / (1 + Math.exp(Number(r.rank) + 2)), matchedBy: 'keyword' as const }));
  }

  semanticSearch(vector: number[], opts: { limit?: number; excludeKinds?: MemoryKind[]; model?: string } = {}): ScoredMemory[] {
    const q = new Float32Array(vector);
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT ${MemoryStore.COLS}, embedding FROM memories WHERE embedding IS NOT NULL ${opts.model ? 'AND embedding_model = ?' : ''}`,
      ...(opts.model ? [opts.model] : []),
    );
    const scored: ScoredMemory[] = [];
    for (const r of rows) {
      const kind = r.kind as MemoryKind;
      if (opts.excludeKinds?.includes(kind)) continue;
      const v = toVector(r.embedding);
      if (!v) continue;
      const score = cosine(q, v);
      if (score > 0.3) scored.push({ ...this.map(r), score, matchedBy: 'semantic' });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 20);
  }

  /**
   * Hybrid retrieval used when Jarvis starts a request or task: keyword (BM25) plus optional
   * semantic similarity, weighted by confidence and verification. Marks the results as accessed.
   */
  retrieve(query: string, opts: { limit?: number; queryVector?: number[] | null; embeddingModel?: string; includeToolDocs?: boolean } = {}): ScoredMemory[] {
    const limit = opts.limit ?? 6;
    if (limit <= 0) return [];
    const exclude: MemoryKind[] = opts.includeToolDocs ? [] : ['tool_doc'];
    const merged = new Map<string, ScoredMemory>();
    for (const m of this.keywordSearch(query, { limit: 20, excludeKinds: exclude })) merged.set(m.id, m);
    if (opts.queryVector) {
      for (const m of this.semanticSearch(opts.queryVector, { limit: 20, excludeKinds: exclude, model: opts.embeddingModel })) {
        const prev = merged.get(m.id);
        merged.set(m.id, prev ? { ...prev, score: Math.max(prev.score, m.score) + 0.15, matchedBy: 'both' } : m);
      }
    }
    const ranked = [...merged.values()]
      .map((m) => ({ ...m, score: m.score * (0.6 + 0.4 * m.confidence) * (m.verified ? 1 : 0.85) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (ranked.length) {
      const ts = now();
      this.db.transaction(() => {
        for (const m of ranked) this.db.run('UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?', ts, m.id);
      });
    }
    return ranked;
  }

  /** Keep one tool_doc memory per skill so Jarvis can recall tool documentation. */
  syncToolDocs(docs: Array<{ name: string; content: string }>): void {
    const existing = new Map(
      this.db.all<{ id: string; source_ref: string; content: string }>("SELECT id, source_ref, content FROM memories WHERE kind = 'tool_doc'").map((r) => [r.source_ref, r]),
    );
    const ts = now();
    this.db.transaction(() => {
      for (const doc of docs) {
        const ref = `skill:${doc.name}`;
        const row = existing.get(ref);
        if (row) {
          if (row.content !== doc.content) {
            this.db.run('UPDATE memories SET content = ?, content_hash = ?, embedding = NULL, updated_at = ? WHERE id = ?', doc.content, sha256(normalizeContent(doc.content)), ts, row.id);
          }
          existing.delete(ref);
        } else {
          this.db.run(
            `INSERT INTO memories (id, kind, content, tags, source, source_ref, sources, confidence, verified, content_hash, created_at, updated_at)
             VALUES (?, 'tool_doc', ?, ?, 'system', ?, '["system"]', 1, 1, ?, ?, ?)`,
            newId('mem'),
            doc.content,
            JSON.stringify(['tool', doc.name.split('.')[0]]),
            ref,
            sha256(normalizeContent(doc.content)),
            ts,
            ts,
          );
        }
      }
      for (const stale of existing.values()) this.db.run('DELETE FROM memories WHERE id = ?', stale.id);
    });
  }

  /** Merge near-duplicates that slipped in (e.g. after user edits). Returns the number merged. */
  dedupe(maxPerKind = 400): number {
    let merged = 0;
    for (const kind of MEMORY_KINDS) {
      if (kind === 'tool_doc') continue;
      const items = this.list({ kind, limit: maxPerKind }).sort((a, b) => Number(b.verified) - Number(a.verified) || a.createdAt - b.createdAt);
      const removed = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        const keep = items[i];
        if (removed.has(keep.id)) continue;
        for (let j = i + 1; j < items.length; j++) {
          const other = items[j];
          if (removed.has(other.id)) continue;
          if (similarity(keep.content, other.content) < NEAR_DUPLICATE_THRESHOLD) continue;
          const sources = [...new Set([...keep.sources, ...other.sources])].slice(-20);
          this.db.transaction(() => {
            this.db.run(
              'UPDATE memories SET sources = ?, merged_count = merged_count + ?, confidence = MAX(confidence, ?), verified = MAX(verified, ?), updated_at = ? WHERE id = ?',
              JSON.stringify(sources),
              other.mergedCount,
              other.confidence,
              other.verified ? 1 : 0,
              now(),
              keep.id,
            );
            this.db.run('DELETE FROM memories WHERE id = ?', other.id);
          });
          keep.sources = sources;
          removed.add(other.id);
          merged++;
        }
      }
    }
    if (merged) this.bus.emit('memory.changed', { action: 'deduplicated', merged });
    return merged;
  }

  missingEmbeddings(limit: number, model: string): Array<{ id: string; content: string }> {
    return this.db.all<{ id: string; content: string }>(
      'SELECT id, content FROM memories WHERE embedding IS NULL OR embedding_model IS NOT ? ORDER BY updated_at DESC LIMIT ?',
      model,
      limit,
    );
  }

  setEmbedding(id: string, vector: number[], model: string): void {
    this.db.run('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?', new Uint8Array(new Float32Array(vector).buffer), model, id);
  }

  stats(): { total: number; unverified: number; byKind: Record<string, number>; embedded: number } {
    const byKind: Record<string, number> = {};
    for (const r of this.db.all<{ kind: string; n: number }>('SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind')) byKind[r.kind] = Number(r.n);
    const totals = this.db.get<{ total: number; unverified: number; embedded: number }>(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN verified = 0 THEN 1 ELSE 0 END) AS unverified, SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded FROM memories',
    )!;
    return { total: Number(totals.total), unverified: Number(totals.unverified ?? 0), embedded: Number(totals.embedded ?? 0), byKind };
  }
}
