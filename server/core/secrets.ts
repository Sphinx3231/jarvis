import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Database } from '../db/database.ts';
import { now } from './util.ts';

/**
 * Encrypted credential storage (AES-256-GCM). The master key comes from JARVIS_MASTER_KEY
 * (64 hex chars) or a key file created with 0600 permissions in the data directory.
 * Secret values are never returned through the API — only whether they are configured.
 */
export class SecretStore {
  private db: Database;
  private key: Buffer;

  constructor(db: Database, keyFile: string) {
    this.db = db;
    this.key = SecretStore.loadKey(keyFile);
  }

  private static loadKey(keyFile: string): Buffer {
    const fromEnv = process.env.JARVIS_MASTER_KEY;
    if (fromEnv && /^[0-9a-f]{64}$/i.test(fromEnv)) return Buffer.from(fromEnv, 'hex');
    if (existsSync(keyFile)) {
      const hex = readFileSync(keyFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
      throw new Error(`Master key file ${keyFile} is corrupt`);
    }
    const key = randomBytes(32);
    writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
    try {
      chmodSync(keyFile, 0o600);
    } catch {
      /* best effort on platforms without chmod */
    }
    return key;
  }

  set(name: string, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.db.run(
      `INSERT INTO secrets (name, iv, tag, data, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = excluded.updated_at`,
      name,
      iv.toString('base64'),
      tag.toString('base64'),
      data.toString('base64'),
      now(),
    );
  }

  get(name: string): string | undefined {
    const row = this.db.get<{ iv: string; tag: string; data: string }>('SELECT iv, tag, data FROM secrets WHERE name = ?', name);
    if (!row) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(row.data, 'base64')), decipher.final()]).toString('utf8');
  }

  has(name: string): boolean {
    return Boolean(this.db.get('SELECT 1 FROM secrets WHERE name = ?', name));
  }

  delete(name: string): void {
    this.db.run('DELETE FROM secrets WHERE name = ?', name);
  }

  deletePrefix(prefix: string): void {
    this.db.run('DELETE FROM secrets WHERE name LIKE ?', `${prefix}%`);
  }
}
