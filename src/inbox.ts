import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MAX_BODY_BYTES, type VerifiedDelivery } from './auth.js';

export class StorageError extends Error {
  constructor() { super('Inbox unavailable'); }
}
export class ConflictError extends Error {
  constructor() { super('Event ID already has different content'); }
}
export class CapacityError extends Error {
  constructor() { super('Inbox capacity reached'); }
}
export interface Receipt {
  id: string;
  bodyHash: string;
  signedAt: number;
  receivedAt: number;
  state: 'pending';
}

/** Trusted internal API: callers must authenticate the delivery before enqueueing. */
export class Inbox {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly maxEvents = 10_000) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100_000) {
      throw new Error('Invalid inbox capacity');
    }
    let db: DatabaseSync | undefined;
    try {
      if (path !== ':memory:') {
        try { closeSync(openSync(path, 'wx', 0o600)); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()
          || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new StorageError();
      }
      db = new DatabaseSync(path, { timeout: 5000, allowExtension: false });
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (version !== 1 && (version !== 0 || tables.length !== 0)) throw new StorageError();
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
      if (version === 0) db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS inbox (
          id TEXT PRIMARY KEY NOT NULL,
          body BLOB NOT NULL,
          body_hash TEXT NOT NULL,
          signed_at INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending' CHECK (state='pending')
        ) STRICT;
        PRAGMA user_version=1;
        COMMIT;
      `);
      // Fail closed when a version number was set on an incompatible schema.
      db.prepare('SELECT id, body, body_hash, signed_at, received_at, state FROM inbox LIMIT 0').all();
      this.db = db;
    } catch {
      try { db?.close(); } catch { /* Preserve the sanitized error. */ }
      throw new StorageError();
    }
  }

  enqueue(delivery: VerifiedDelivery, receivedAt = Math.floor(Date.now() / 1000)): 'inserted' | 'duplicate' {
    // Check internal invariants as well as the public request boundary.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(delivery.id) || delivery.body.length > MAX_BODY_BYTES
      || !Number.isSafeInteger(delivery.timestamp) || delivery.timestamp <= 0
      || !Number.isSafeInteger(receivedAt) || receivedAt < 0) throw new Error('Invalid verified delivery');
    const hash = createHash('sha256').update(delivery.body).digest('hex');
    let transaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      const existing = this.db.prepare('SELECT body_hash FROM inbox WHERE id=?').get(delivery.id);
      if (existing) {
        if (existing.body_hash !== hash) throw new ConflictError();
        this.db.exec('COMMIT'); transaction = false;
        return 'duplicate';
      }
      const count = this.db.prepare('SELECT count(*) AS n FROM inbox').get()?.n;
      if (typeof count !== 'number' || count >= this.maxEvents) throw new CapacityError();
      this.db.prepare('INSERT INTO inbox(id,body,body_hash,signed_at,received_at) VALUES(?,?,?,?,?)')
        .run(delivery.id, delivery.body, hash, delivery.timestamp, receivedAt);
      this.db.exec('COMMIT'); transaction = false;
      return 'inserted';
    } catch (e) {
      if (transaction) { try { this.db.exec('ROLLBACK'); } catch { /* Connection may be unavailable. */ } }
      if (e instanceof ConflictError || e instanceof CapacityError) throw e;
      throw new StorageError();
    }
  }

  inspect(limit = 100): Receipt[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid inspection limit');
    try {
      return this.db.prepare(`SELECT id, body_hash AS bodyHash, signed_at AS signedAt,
        received_at AS receivedAt, state FROM inbox ORDER BY received_at,id LIMIT ?`).all(limit) as unknown as Receipt[];
    } catch { throw new StorageError(); }
  }

  count(): number {
    try { return this.db.prepare('SELECT count(*) AS n FROM inbox').get()?.n as number; }
    catch { throw new StorageError(); }
  }
  close(): void { this.db.close(); }
}
