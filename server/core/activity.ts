import type { Database } from '../db/database.ts';
import type { EventBus } from './events.ts';
import { newId, now, parseJson, redact } from './util.ts';

export type Level = 'info' | 'success' | 'warning' | 'error';

export interface ActivityEntry {
  id: number;
  ts: number;
  level: Level;
  category: string;
  message: string;
  data: unknown;
}

export interface NotificationEntry {
  id: string;
  ts: number;
  level: Level;
  title: string;
  body: string;
  taskId: string | null;
  read: boolean;
}

/** Human-readable activity feed + user-facing notifications. Everything is redacted first. */
export class ActivityLog {
  private db: Database;
  private bus: EventBus;
  private quiet: boolean;

  constructor(db: Database, bus: EventBus, opts: { quiet?: boolean } = {}) {
    this.db = db;
    this.bus = bus;
    this.quiet = opts.quiet ?? false;
  }

  log(level: Level, category: string, message: string, data?: unknown): void {
    const safe = data === undefined ? null : JSON.stringify(redact(data));
    const ts = now();
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO activity (ts, level, category, message, data) VALUES (?, ?, ?, ?, ?)',
      ts,
      level,
      category,
      message,
      safe,
    );
    if (!this.quiet) {
      const tag = level === 'error' ? 'ERR ' : level === 'warning' ? 'WARN' : 'INFO';
      console.log(`[${new Date(ts).toISOString()}] ${tag} ${category}: ${message}`);
    }
    this.bus.emit('activity', { id: lastInsertRowid, level, category, message });
  }

  recent(limit = 50, category?: string): ActivityEntry[] {
    const rows = category
      ? this.db.all<Record<string, unknown>>('SELECT * FROM activity WHERE category = ? ORDER BY id DESC LIMIT ?', category, limit)
      : this.db.all<Record<string, unknown>>('SELECT * FROM activity ORDER BY id DESC LIMIT ?', limit);
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      level: r.level as Level,
      category: String(r.category),
      message: String(r.message),
      data: parseJson(r.data as string | null, null),
    }));
  }

  /**
   * Create a notification. If dedupeKey is given and a notification with that key already
   * exists, nothing is created (prevents the background monitor from spamming reminders).
   */
  notify(level: Level, title: string, body = '', opts: { taskId?: string; dedupeKey?: string } = {}): NotificationEntry | null {
    if (opts.dedupeKey) {
      const exists = this.db.get('SELECT id FROM notifications WHERE dedupe_key = ?', opts.dedupeKey);
      if (exists) return null;
    }
    const entry: NotificationEntry = {
      id: newId('ntf'),
      ts: now(),
      level,
      title,
      body: String(redact(body)),
      taskId: opts.taskId ?? null,
      read: false,
    };
    this.db.run(
      'INSERT INTO notifications (id, ts, level, title, body, task_id, dedupe_key, read) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      entry.id,
      entry.ts,
      level,
      title,
      entry.body,
      entry.taskId,
      opts.dedupeKey ?? null,
    );
    this.bus.emit('notification', { ...entry });
    return entry;
  }

  notifications(limit = 50, unreadOnly = false): NotificationEntry[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM notifications ${unreadOnly ? 'WHERE read = 0' : ''} ORDER BY ts DESC LIMIT ?`,
      limit,
    );
    return rows.map((r) => ({
      id: String(r.id),
      ts: Number(r.ts),
      level: r.level as Level,
      title: String(r.title),
      body: String(r.body),
      taskId: (r.task_id as string | null) ?? null,
      read: Number(r.read) === 1,
    }));
  }

  unreadCount(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE read = 0')?.n ?? 0);
  }

  markRead(id?: string): void {
    if (id) this.db.run('UPDATE notifications SET read = 1 WHERE id = ?', id);
    else this.db.run('UPDATE notifications SET read = 1 WHERE read = 0');
    this.bus.emit('notification', { read: true });
  }
}
