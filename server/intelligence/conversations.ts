import type { Database } from '../db/database.ts';
import type { EventBus } from '../core/events.ts';
import { newId, now, parseJson, UserError } from '../core/util.ts';

export interface Conversation {
  id: string;
  title: string;
  summary: string | null;
  summarizedUntil: number;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  meta: Record<string, unknown>;
  createdAt: number;
}

/** Short-term conversational context, persisted so conversations survive restarts. */
export class ConversationStore {
  private db: Database;
  private bus: EventBus;

  constructor(db: Database, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  private mapConv(r: Record<string, unknown>): Conversation {
    return {
      id: String(r.id),
      title: String(r.title),
      summary: (r.summary as string | null) ?? null,
      summarizedUntil: Number(r.summarized_until),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      messageCount: r.message_count === undefined ? undefined : Number(r.message_count),
    };
  }

  create(title: string): Conversation {
    const id = newId('cnv');
    const ts = now();
    this.db.run('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', id, title.slice(0, 80) || 'Conversation', ts, ts);
    return this.get(id)!;
  }

  get(id: string): Conversation | undefined {
    const r = this.db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', id);
    return r ? this.mapConv(r) : undefined;
  }

  list(limit = 50): Conversation[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c ORDER BY updated_at DESC LIMIT ?',
        limit,
      )
      .map((r) => this.mapConv(r));
  }

  addMessage(conversationId: string, role: 'user' | 'assistant', content: string, meta: Record<string, unknown> = {}): ChatMessage {
    const msg: ChatMessage = { id: newId('msg'), conversationId, role, content, meta, createdAt: now() };
    this.db.run('INSERT INTO messages (id, conversation_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)', msg.id, conversationId, role, content, JSON.stringify(meta), msg.createdAt);
    this.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', msg.createdAt, conversationId);
    this.bus.emit('conversation.updated', { id: conversationId, messageId: msg.id, role });
    return msg;
  }

  messages(conversationId: string, opts: { limit?: number; after?: number } = {}): ChatMessage[] {
    const rows = this.db.all<Record<string, unknown>>(
      'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC',
      conversationId,
      opts.after ?? 0,
      opts.limit ?? 200,
    );
    return rows.map((r) => ({
      id: String(r.id),
      conversationId: String(r.conversation_id),
      role: r.role as 'user' | 'assistant',
      content: String(r.content),
      meta: parseJson(r.meta as string, {}),
      createdAt: Number(r.created_at),
    }));
  }

  count(conversationId: string): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conversationId)?.n ?? 0);
  }

  setSummary(id: string, summary: string, until: number): void {
    this.db.run('UPDATE conversations SET summary = ?, summarized_until = ? WHERE id = ?', summary, until, id);
  }

  delete(id: string): void {
    const { changes } = this.db.run('DELETE FROM conversations WHERE id = ?', id);
    if (!changes) throw new UserError('Conversation not found', 404);
    this.bus.emit('conversation.updated', { id, deleted: true });
  }

  pruneOlderThan(cutoff: number): number {
    return this.db.run('DELETE FROM conversations WHERE updated_at < ?', cutoff).changes;
  }

  /** Conversations with many messages beyond their last summary — candidates for summarisation. */
  needingSummary(threshold: number): Conversation[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT c.* FROM conversations c WHERE (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.created_at > c.summarized_until) > ? ORDER BY updated_at DESC LIMIT 3',
        threshold,
      )
      .map((r) => this.mapConv(r));
  }
}
