import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.ts';

export type Row = Record<string, unknown>;
export type Param = SQLInputValue;

/**
 * Thin wrapper around node:sqlite. All access is synchronous and in-process, which keeps
 * state transitions (e.g. claiming a queued task) atomic without extra locking.
 */
export class Database {
  readonly raw: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.raw.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.raw.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue;
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.raw.prepare('UPDATE schema_version SET version = ?').run(migration.version);
      });
      version = migration.version;
    }
  }

  get schemaVersion(): number {
    return (this.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const res = this.raw.prepare(sql).run(...params);
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    try {
      this.raw.close();
    } catch {
      /* already closed */
    }
  }
}
