import type { ActivityLog } from '../core/activity.ts';
import type { EventBus } from '../core/events.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage, newId, now, parseJson, truncate } from '../core/util.ts';
import type { Database } from '../db/database.ts';
import type { ChatMessage, ConversationStore } from '../intelligence/conversations.ts';
import type { RoamiesEngine } from '../llm/engine.ts';
import { stripThinking } from '../llm/openjarvis.ts';
import { similarity, type Memory, type MemoryKind, type MemoryStore } from '../memory/store.ts';

/**
 * Conversation digests: Jarvis's own notes on every conversation.
 *
 * Once a conversation has been quiet for `memory.digestAfterSec`, Jarvis reads the part it hasn't
 * digested yet and writes itself a digest: a short summary, then every item worth keeping filed under
 * a category (rule, preference, plan, schedule, idea, decision, project, procedure, fact, open
 * request, question) and marked new or repeated. Items become memories (so they're searchable and
 * the standing ones reach every later turn) and the digest goes to the vault.
 *
 * Nothing depends on a process staying alive: messages are in SQLite the moment they're sent, and
 * `digested_until` only moves forward after a digest is stored. If Jarvis is stopped mid-digest, the
 * user starts talking again (that aborts a digest so the local model is free for them) or no model
 * is available, the conversation is digested later, or with the quick no-model digest.
 *
 * Standing rules ("from now on…", "never…") don't wait for the digest at all: they're captured the
 * moment the user says them (captureNow) and are in the context of the very next reply.
 */

export const DIGEST_CATEGORIES = ['rule', 'preference', 'plan', 'schedule', 'idea', 'decision', 'project', 'procedure', 'fact', 'request', 'question'] as const;
export type DigestCategory = (typeof DIGEST_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<DigestCategory, string> = {
  rule: 'Rules',
  preference: 'Preferences',
  plan: 'Plans',
  schedule: 'Schedules',
  idea: 'Ideas',
  decision: 'Decisions',
  project: 'Projects',
  procedure: 'Procedures',
  fact: 'Facts',
  request: 'Open requests',
  question: 'Questions',
};

/** Categories that become memories (requests and questions live in the digests only). */
const MEMORY_OF: Partial<Record<DigestCategory, MemoryKind>> = {
  rule: 'rule',
  preference: 'preference',
  plan: 'plan',
  schedule: 'schedule',
  idea: 'idea',
  decision: 'decision',
  project: 'project',
  procedure: 'procedure',
  fact: 'fact',
};

export interface DigestItem {
  category: DigestCategory;
  text: string;
  status: 'new' | 'repeated';
  memoryId: string | null;
}

export interface Digest {
  id: string;
  conversationId: string;
  conversationTitle: string;
  fromTs: number;
  toTs: number;
  messages: number;
  summary: string;
  items: DigestItem[];
  newCount: number;
  repeatedCount: number;
  /** model = Jarvis's model wrote it; quick = pattern-based, when no model was available. */
  method: 'model' | 'quick';
  createdAt: number;
}

// ---------------------------------------------------------------- quick (no-model) classification

const RULE_NOW = /\b(from now on|going forward|from here on( out)?|every (single )?time (you|i)|whenever you|you (must|should always|should never|need to always|have to always|always have to|will always|will never|are not allowed to|aren'?t allowed to|may never)|i want you to (always|never)|i need you to (always|never)|the rule is|new rule)\b|^(?:(?:please|and|also|ok(?:ay)?|so|but)[, ]+)?(?:always|never(?!\s+mind)|don'?t\s+ever|do\s+not\s+ever)\b/i;
const RULE_SOFT = /^(?:(?:please|and|also|ok(?:ay)?|so|but)[, ]+)?(?:make sure|remember to|stop \w+ing|do not|don'?t)\b/i;
const SCHEDULE = /\b(every (day|morning|evening|night|week|month|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+ (minutes|hours|days|weeks))|(at|by|around) \d{1,2}(:\d{2})?\s*(am|pm)\b|at \d{1,2}:\d{2}|tomorrow|tonight|next (week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?|daily|weekly|monthly|deadline|due (on|by)|appointment|meeting (at|on))\b/i;
const DECISION = /\b(i('ve| have) decided|we('ve| have) decided|decided to|let'?s go with|we('ll| will) (use|go with)|i('ll| will) go with|switch(ing)? (over )?to|instead of)\b/i;
const PLAN = /\b(i('m| am) (going|planning) to|we('re| are) (going|planning) to|planning to|the plan (is|was)|next step|roadmap|my goal|our goal|the goal is|once (we|i) (get|have)|then we('ll| will)|later we('ll| will)|eventually)\b/i;
const IDEA = /\b(idea|what if|maybe we (could|should)|how about|it would be (cool|nice|great|awesome)|we could (try|also))\b/i;
const PREFERENCE = /\b(i (really )?(prefer|like|love|hate|dislike|don'?t like|can'?t stand)|my favou?rite|i'?d rather)\b/i;
const FACT = /^(remember that|note that|fyi|for your information|just so you know)\b/i;
const REQUEST = /^(?:(?:please|ok(?:ay)?|so|and|also|now)[, ]+)?(can you|could you|would you|i need you to|i want you to|please|go ahead and|let'?s)\b/i;

/** The category of one sentence the user said, by its wording alone (no model). */
export function classifySentence(sentence: string): DigestCategory | null {
  const s = sentence.trim();
  if (s.length < 8) return null;
  // Most specific first: "what if we met every Monday" is an idea, "I plan to launch next month" a plan.
  if (RULE_NOW.test(s)) return 'rule';
  if (IDEA.test(s)) return 'idea';
  if (DECISION.test(s)) return 'decision';
  if (PLAN.test(s)) return 'plan';
  if (SCHEDULE.test(s)) return 'schedule';
  if (PREFERENCE.test(s)) return 'preference';
  if (FACT.test(s)) return 'fact';
  if (REQUEST.test(s)) return 'request';
  if (s.endsWith('?') && s.length >= 15) return 'question';
  if (RULE_SOFT.test(s)) return 'request';
  return null;
}

/** A standing instruction, clear enough to keep the moment it is said (before any digest). */
export function isStandingRule(sentence: string): boolean {
  const s = sentence.trim();
  return s.length >= 12 && s.split(/\s+/).length >= 3 && RULE_NOW.test(s);
}

export function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 8 && s.length <= 600);
}

// ---------------------------------------------------------------- the digester

const MAX_TRANSCRIPT_CHARS = 24_000;

export class ConversationDigester {
  private d: { db: Database; conversations: ConversationStore; memory: MemoryStore; llm: RoamiesEngine; settings: SettingsStore; activity: ActivityLog; bus: EventBus };
  private timers = new Map<string, NodeJS.Timeout>();
  private queue: Promise<unknown> = Promise.resolve();
  private inflight: AbortController | null = null;
  private stopped = false;
  /** Quick digests the model already failed to redo in this run (not retried until the next start). */
  private redoFailed = new Set<string>();

  constructor(deps: ConversationDigester['d']) {
    this.d = deps;
  }

  // ---------------------------------------------------------------- triggers

  /**
   * A message was added. The user talking again stops a model digest in progress (the local model is
   * theirs first; nothing is lost — that part is digested later), and the conversation is digested
   * once it has been quiet for digestAfterSec.
   */
  noteActivity(conversationId: string, role?: string): void {
    if (this.stopped) return;
    if (role === 'user') this.inflight?.abort();
    const after = this.d.settings.get().memory.digestAfterSec;
    clearTimeout(this.timers.get(conversationId));
    if (!after) return;
    const t = setTimeout(() => {
      this.timers.delete(conversationId);
      void this.enqueue(conversationId).catch(() => {});
    }, after * 1000);
    t.unref?.();
    this.timers.set(conversationId, t);
  }

  /** Digest one conversation now (serialised with any other digest). */
  enqueue(conversationId: string, opts: { quick?: boolean } = {}): Promise<Digest | null> {
    const run = this.queue.then(() => this.digest(conversationId, opts));
    this.queue = run.catch(() => null);
    return run;
  }

  /**
   * Catch up on everything not digested yet: conversations from before a restart, ones whose digest
   * was interrupted, and quick digests that can now be redone by the model. Bounded per call.
   */
  async catchUp(signal?: AbortSignal, opts: { max?: number; quietMs?: number } = {}): Promise<number> {
    const max = opts.max ?? 3;
    const quietMs = opts.quietMs ?? Math.max(30, this.d.settings.get().memory.digestAfterSec) * 1000;
    const pending = this.d.db.all<{ id: string }>(
      `SELECT c.id FROM conversations c
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.created_at > c.digested_until)
         AND c.updated_at < ?
       ORDER BY c.updated_at ASC LIMIT ?`,
      now() - quietMs,
      max,
    );
    let done = 0;
    for (const { id } of pending) {
      if (signal?.aborted || this.stopped) break;
      if (await this.enqueue(id)) done++;
    }
    if (done < max && !signal?.aborted && this.modelReady()) {
      const quick = this.d.db
        .all<{ id: string }>("SELECT id FROM conversation_digests WHERE method = 'quick' AND created_at > ? ORDER BY created_at ASC LIMIT 20", now() - 14 * 86_400_000)
        .find((q) => !this.redoFailed.has(q.id));
      if (quick) {
        if (await this.redo(quick.id)) done++;
        else this.redoFailed.add(quick.id);
      }
    }
    return done;
  }

  /** Before conversations are pruned: make sure each one is digested (quick if need be). */
  async digestBefore(cutoff: number): Promise<void> {
    const rows = this.d.db.all<{ id: string }>(
      'SELECT c.id FROM conversations c WHERE c.updated_at < ? AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.created_at > c.digested_until)',
      cutoff,
    );
    for (const { id } of rows) await this.enqueue(id, { quick: true });
  }

  start(): void {
    this.stopped = false;
  }

  /** Stop: pending timers cleared, a model digest in progress interrupted (its part is digested next start). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.inflight?.abort();
    await this.queue.catch(() => {});
  }

  // ---------------------------------------------------------------- immediate capture

  /**
   * Keep standing rules the moment the user says them. They are the user's own words, so they are
   * stored as stated by the user, and they are in the context of the reply to this very message.
   */
  captureNow(conversationId: string, text: string): Memory[] {
    const saved: Memory[] = [];
    for (const s of sentences(text)) {
      if (!isStandingRule(s)) continue;
      try {
        const { memory, merged } = this.d.memory.add({ kind: 'rule', content: s, source: 'user (chat)', sourceRef: `conversation:${conversationId}`, verified: true, confidence: 1, tags: ['rule'] });
        saved.push(memory);
        this.d.activity.log('info', 'memory', `${merged ? 'Rule repeated' : 'New rule'}: ${truncate(s, 100)}`);
      } catch {
        /* too long / empty: the digest still records it */
      }
    }
    return saved;
  }

  // ---------------------------------------------------------------- reading

  list(opts: { conversationId?: string; since?: number; limit?: number } = {}): Digest[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.conversationId) {
      where.push('conversation_id = ?');
      params.push(opts.conversationId);
    }
    if (opts.since) {
      where.push('created_at >= ?');
      params.push(opts.since);
    }
    return this.d.db
      .all<Record<string, unknown>>(`SELECT * FROM conversation_digests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY to_ts DESC LIMIT ?`, ...params, opts.limit ?? 50)
      .map((r) => this.map(r));
  }

  /** The newest digest per conversation (for "recent conversations" in Jarvis's context). */
  recent(limit = 4, excludeConversation?: string): Digest[] {
    return this.d.db
      .all<Record<string, unknown>>(
        `SELECT d.* FROM conversation_digests d
         WHERE d.to_ts = (SELECT MAX(to_ts) FROM conversation_digests x WHERE x.conversation_id = d.conversation_id) AND d.conversation_id != ?
         ORDER BY d.to_ts DESC LIMIT ?`,
        excludeConversation ?? '',
        limit,
      )
      .map((r) => this.map(r));
  }

  /** Requests the user made recently, newest first, de-duplicated. */
  openRequests(days = 7, limit = 8): Array<DigestItem & { conversationTitle: string; at: number }> {
    const out: Array<DigestItem & { conversationTitle: string; at: number }> = [];
    for (const d of this.list({ since: now() - days * 86_400_000, limit: 60 })) {
      for (const it of d.items) {
        if (it.category !== 'request' || out.some((o) => similarity(o.text, it.text) > 0.7)) continue;
        out.push({ ...it, conversationTitle: d.conversationTitle, at: d.toTs });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  stats(): { digests: number; pendingConversations: number; lastAt: number | null } {
    const n = this.d.db.get<{ n: number; last: number | null }>('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM conversation_digests');
    const pending = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations c WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.created_at > c.digested_until)');
    return { digests: Number(n?.n ?? 0), pendingConversations: Number(pending?.n ?? 0), lastAt: n?.last ?? null };
  }

  private map(r: Record<string, unknown>): Digest {
    return {
      id: String(r.id),
      conversationId: String(r.conversation_id),
      conversationTitle: String(r.conversation_title),
      fromTs: Number(r.from_ts),
      toTs: Number(r.to_ts),
      messages: Number(r.messages),
      summary: String(r.summary),
      items: parseJson<DigestItem[]>(r.items as string, []),
      newCount: Number(r.new_count),
      repeatedCount: Number(r.repeated_count),
      method: r.method === 'model' ? 'model' : 'quick',
      createdAt: Number(r.created_at),
    };
  }

  // ---------------------------------------------------------------- digesting

  private modelReady(): boolean {
    return this.d.llm.available();
  }

  private digestedUntil(conversationId: string): number {
    return Number(this.d.db.get<{ t: number }>('SELECT digested_until AS t FROM conversations WHERE id = ?', conversationId)?.t ?? 0);
  }

  /** Digest the undigested part of a conversation. Returns null when there was nothing to do or it was interrupted. */
  async digest(conversationId: string, opts: { quick?: boolean } = {}): Promise<Digest | null> {
    if (this.stopped && !opts.quick) return null;
    const conv = this.d.conversations.get(conversationId);
    if (!conv) return null;
    const from = this.digestedUntil(conversationId);
    const all = this.d.conversations.messages(conversationId, { after: from, limit: 2000 });
    if (!all.length) return null;
    // A long backlog is digested in parts, oldest first, so nothing is skipped.
    const part: ChatMessage[] = [];
    let chars = 0;
    for (const m of all) {
      const cost = Math.min(m.content.length, 2000) + 20;
      if (part.length && chars + cost > MAX_TRANSCRIPT_CHARS) break;
      part.push(m);
      chars += cost;
    }
    let digest: Omit<Digest, 'id' | 'createdAt'> | null = null;
    if (!opts.quick && this.modelReady()) {
      const ac = new AbortController();
      this.inflight = ac;
      try {
        digest = await this.modelDigest(conv.id, conv.title, part, ac.signal);
      } catch (err) {
        if (ac.signal.aborted) return null; // the user is talking: digest later
        this.d.activity.log('warning', 'memory', `Digest by the model failed (${errorMessage(err)}); kept a quick digest instead`);
      } finally {
        if (this.inflight === ac) this.inflight = null;
      }
    }
    digest ??= this.quickDigest(conv.id, conv.title, part);
    const stored = this.store(digest);
    if (part.length < all.length && !this.stopped) void this.enqueue(conversationId, opts).catch(() => {});
    return stored;
  }

  private store(d: Omit<Digest, 'id' | 'createdAt'>, replaceId?: string): Digest {
    const id = replaceId ?? newId('dig');
    const createdAt = now();
    this.d.db.transaction(() => {
      if (replaceId) this.d.db.run('DELETE FROM conversation_digests WHERE id = ?', replaceId);
      this.d.db.run(
        `INSERT INTO conversation_digests (id, conversation_id, conversation_title, from_ts, to_ts, messages, summary, items, new_count, repeated_count, method, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        d.conversationId,
        d.conversationTitle,
        d.fromTs,
        d.toTs,
        d.messages,
        d.summary,
        JSON.stringify(d.items),
        d.newCount,
        d.repeatedCount,
        d.method,
        createdAt,
      );
      this.d.db.run('UPDATE conversations SET digested_until = MAX(digested_until, ?) WHERE id = ?', d.toTs, d.conversationId);
    });
    const digest: Digest = { ...d, id, createdAt };
    const cats = [...new Set(d.items.map((i) => CATEGORY_LABEL[i.category].toLowerCase()))];
    this.d.activity.log(
      'info',
      'memory',
      `Digested "${truncate(d.conversationTitle, 50)}" (${d.messages} message${d.messages === 1 ? '' : 's'}): ${d.newCount} new, ${d.repeatedCount} repeated${cats.length ? ` — ${cats.join(', ')}` : ''}${d.method === 'quick' ? ' (quick digest, no model)' : ''}`,
    );
    this.d.bus.emit('memory.changed', { digest: id, action: 'digested' });
    return digest;
  }

  /** Redo a quick digest with the model, now that one is available. */
  private async redo(digestId: string): Promise<boolean> {
    const old = this.list({ limit: 1000 }).find((d) => d.id === digestId);
    if (!old) return false;
    const msgs = this.d.conversations.messages(old.conversationId, { after: old.fromTs, limit: 2000 }).filter((m) => m.createdAt <= old.toTs);
    if (!msgs.length) {
      this.d.db.run("UPDATE conversation_digests SET method = 'model' WHERE id = ?", digestId); // the messages are gone; keep it as is
      return false;
    }
    const ac = new AbortController();
    this.inflight = ac;
    try {
      const d = await this.modelDigest(old.conversationId, old.conversationTitle, msgs, ac.signal, old.fromTs);
      this.store({ ...d, toTs: old.toTs }, digestId);
      return true;
    } catch {
      return false;
    } finally {
      if (this.inflight === ac) this.inflight = null;
    }
  }

  /**
   * Store the items as memories and mark each new or repeated. Repeated = it was already known before
   * this part of the conversation (a rule kept the moment it was said, in this same part, is new).
   */
  private file(conversationId: string, partStart: number, raw: Array<{ category: DigestCategory; text: string; repeated?: boolean }>, source: 'user (chat)' | 'jarvis (digest)'): DigestItem[] {
    const items: DigestItem[] = [];
    const earlier = this.list({ since: now() - 30 * 86_400_000, limit: 80 }).flatMap((d) => d.items);
    for (const r of raw) {
      const text = r.text.replace(/\s+/g, ' ').trim().slice(0, 1000);
      if (text.length < 4 || items.some((i) => i.category === r.category && similarity(i.text, text) > 0.85)) continue;
      const kind = MEMORY_OF[r.category];
      if (kind) {
        try {
          const verbatim = source === 'user (chat)';
          const { memory, merged } = this.d.memory.add({
            kind,
            content: text,
            source,
            sourceRef: `conversation:${conversationId}`,
            // The user's own words are what they said; the model's paraphrase is Jarvis's understanding of it.
            verified: verbatim,
            confidence: verbatim ? 1 : 0.75,
            tags: ['digest', r.category],
          });
          // mergedCount counts mentions: 1 when kept the moment it was said, 2 once this digest adds it.
          const known = merged && (memory.createdAt < partStart || memory.mergedCount > 2);
          items.push({ category: r.category, text, status: known || r.repeated ? 'repeated' : 'new', memoryId: memory.id });
        } catch {
          items.push({ category: r.category, text, status: r.repeated ? 'repeated' : 'new', memoryId: null });
        }
      } else {
        const seen = r.repeated || earlier.some((e) => e.category === r.category && similarity(e.text, text) > 0.7);
        items.push({ category: r.category, text, status: seen ? 'repeated' : 'new', memoryId: null });
      }
    }
    return items;
  }

  private totals(items: DigestItem[]): { newCount: number; repeatedCount: number } {
    return { newCount: items.filter((i) => i.status === 'new').length, repeatedCount: items.filter((i) => i.status === 'repeated').length };
  }

  /** Without a model: the user's sentences filed by their wording, and a plain account of the exchange. */
  quickDigest(conversationId: string, title: string, msgs: ChatMessage[]): Omit<Digest, 'id' | 'createdAt'> {
    const userMsgs = msgs.filter((m) => m.role === 'user');
    const raw: Array<{ category: DigestCategory; text: string }> = [];
    for (const m of userMsgs) {
      for (const s of sentences(m.content)) {
        const category = classifySentence(s);
        if (category) raw.push({ category, text: s });
      }
    }
    const items = this.file(conversationId, msgs[0].createdAt - 1, raw, 'user (chat)');
    const clip = (t: string) => (t.length > 160 ? `${t.slice(0, 157).trimEnd()}…` : t);
    const topics = userMsgs.map((m) => clip(m.content.replace(/\s+/g, ' '))).slice(0, 6);
    const summary = `${userMsgs.length} message${userMsgs.length === 1 ? '' : 's'} from the user, ${msgs.length - userMsgs.length} from Jarvis. The user said: ${topics.map((t) => `“${t}”`).join('; ')}${userMsgs.length > topics.length ? ` (and ${userMsgs.length - topics.length} more)` : ''}.`;
    return { conversationId, conversationTitle: title, fromTs: msgs[0].createdAt - 1, toTs: msgs[msgs.length - 1].createdAt, messages: msgs.length, summary, items, ...this.totals(items), method: 'quick' };
  }

  private async modelDigest(conversationId: string, title: string, msgs: ChatMessage[], signal: AbortSignal, fromTs?: number): Promise<Omit<Digest, 'id' | 'createdAt'>> {
    const transcript = msgs.map((m) => `${m.role === 'user' ? 'User' : 'Jarvis'} (${new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ')}): ${truncate(m.content, 2000)}`).join('\n');
    const known = new Map<string, Memory>();
    for (const m of this.d.memory.standing(3000)) known.set(m.id, m);
    for (const m of this.d.memory.retrieve(transcript.slice(0, 4000), { limit: 25, markAccess: false })) if (m.kind !== 'task_history' && m.kind !== 'tool_doc') known.set(m.id, m);
    const earlier = this.list({ conversationId, limit: 1 })[0];
    const prompt = [
      `Today is ${new Date().toDateString()}.`,
      earlier ? `Your digest of the earlier part of this conversation:\n${earlier.summary}\n` : '',
      known.size ? `What you already know (use it to tell new from repeated):\n${[...known.values()].map((m) => `- [${m.kind}] ${truncate(m.content, 300)}`).join('\n')}\n` : 'You know nothing about the user yet.\n',
      `Conversation "${title}" — the part you have not digested yet:\n${transcript}`,
    ].join('\n');
    const res = await this.d.llm.generate({
      system: `You are Jarvis, writing your own private digest of a conversation you had with the user, so you never forget it. Reply with ONE JSON object and nothing else:
{"summary": "2-5 sentences: what happened, what was decided, what is still open", "items": [{"category": "<category>", "text": "<one self-contained statement>", "repeated": <true|false>}]}
Categories: rule (a standing instruction for how you must behave or work from now on), preference, plan, schedule (anything with a time or date: appointments, deadlines, recurring things), idea, decision, project, procedure (how to do something), fact (about the user, their work or their world), request (something the user asked you to do that is not done yet), question (something the user asked that is still unanswered).
- Include every rule, plan, schedule, idea, decision and request the user expressed, even small ones. Skip greetings and chit-chat.
- Each text stands alone: name the thing, keep the user's wording for rules, and turn relative dates ("tomorrow", "next Friday") into dates.
- repeated is true when it is already in what you know or the user had said it before; false when it is new.
- Only what was said or confirmed in the conversation. Never invent anything.`,
      prompt,
      maxTokens: 3000,
      signal,
    });
    signal.throwIfAborted(); // interrupted: store nothing, the part stays pending
    const parsed = parseDigestJson(res.text);
    if (!parsed) throw new Error('the model did not return a digest');
    const items = this.file(conversationId, fromTs ?? msgs[0].createdAt - 1, parsed.items, 'jarvis (digest)');
    return { conversationId, conversationTitle: title, fromTs: fromTs ?? msgs[0].createdAt - 1, toTs: msgs[msgs.length - 1].createdAt, messages: msgs.length, summary: parsed.summary || 'Conversation digested.', items, ...this.totals(items), method: 'model' };
  }
}

/** Read the model's digest leniently: thinking stripped, code fences or extra text around the JSON tolerated. */
export function parseDigestJson(text: string): { summary: string; items: Array<{ category: DigestCategory; text: string; repeated?: boolean }> } | null {
  const t = stripThinking(text);
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { summary?: unknown; items?: unknown };
  const alias: Record<string, DigestCategory> = { rules: 'rule', instruction: 'rule', preferences: 'preference', plans: 'plan', schedules: 'schedule', ideas: 'idea', decisions: 'decision', projects: 'project', procedures: 'procedure', facts: 'fact', requests: 'request', task: 'request', tasks: 'request', todo: 'request', questions: 'question' };
  const items = (Array.isArray(o.items) ? o.items : [])
    .map((i) => {
      if (!i || typeof i !== 'object') return null;
      const r = i as { category?: unknown; text?: unknown; repeated?: unknown };
      const cat = String(r.category ?? '').toLowerCase().trim();
      const category = (DIGEST_CATEGORIES as readonly string[]).includes(cat) ? (cat as DigestCategory) : alias[cat];
      const text = typeof r.text === 'string' ? r.text.trim() : '';
      return category && text ? { category, text, repeated: r.repeated === true } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return { summary: typeof o.summary === 'string' ? o.summary.trim() : '', items };
}
