import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MAX_BODY_BYTES, type VerifiedDelivery } from './auth.js';
import { initializeSchema, receiptColumns, SCHEMA_VERSION, type EventState } from './schema.js';
import { claimEvent, failEvent, LeaseError, type FailureCode, type Lease } from './leases.js';

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
  state: EventState;
  attempts: number;
  availableAt: number;
  leaseUntil: number | null;
  lastError: string | null;
  completedAt: number | null;
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
      if (![1, SCHEMA_VERSION].includes(version as number) && (version !== 0 || tables.length !== 0)) throw new StorageError();
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
      initializeSchema(db);
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
      this.db.prepare('INSERT INTO inbox(id,body,body_hash,signed_at,received_at,available_at) VALUES(?,?,?,?,?,?)')
        .run(delivery.id, delivery.body, hash, delivery.timestamp, receivedAt, receivedAt);
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
      return this.db.prepare(`SELECT ${receiptColumns} FROM inbox ORDER BY received_at,id LIMIT ?`).all(limit) as unknown as Receipt[];
    } catch { throw new StorageError(); }
  }

  count(): number {
    try { return this.db.prepare('SELECT count(*) AS n FROM inbox').get()?.n as number; }
    catch { throw new StorageError(); }
  }

  private transaction<T>(operation: () => T): T {
    let active = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); active = true;
      const result = operation();
      this.db.exec('COMMIT'); active = false;
      return result;
    } catch (error) {
      if (active) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve original error. */ } }
      if (error instanceof LeaseError) throw error;
      throw new StorageError();
    }
  }

  claim(now = Math.floor(Date.now() / 1000), leaseSeconds = 30): Lease | null {
    return this.transaction(() => claimEvent(this.db, now, leaseSeconds));
  }

  fail(lease: Lease, code: FailureCode, now = Math.floor(Date.now() / 1000)): 'retry' | 'dead' {
    return this.transaction(() => failEvent(this.db, lease, code, now));
  }
  close(): void { this.db.close(); }
}

/** Does not create a missing database, migrate a schema or expose payloads. */
export function inspectInbox(path: string, limit = 100): { total: number; events: Receipt[] } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid inspection limit');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1000 });
    if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION) throw new StorageError();
    db.exec('BEGIN');
    const total = db.prepare('SELECT count(*) AS n FROM inbox').get()?.n as number;
    const events = db.prepare(`SELECT ${receiptColumns} FROM inbox ORDER BY received_at,id LIMIT ?`).all(limit) as unknown as Receipt[];
    db.exec('COMMIT');
    return { total, events };
  } catch { throw new StorageError(); }
  finally { try { db?.close(); } catch { /* Preserve sanitized errors. */ } }
}
