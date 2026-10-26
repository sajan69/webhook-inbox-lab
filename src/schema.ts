import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;
export const MAX_ATTEMPTS = 5;

const createInbox = `CREATE TABLE inbox (
  id TEXT PRIMARY KEY NOT NULL,
  body BLOB NOT NULL,
  body_hash TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','retry','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT,
  completed_at INTEGER,
  CHECK ((state='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state!='leased' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK ((state IN ('done','dead') AND completed_at IS NOT NULL)
    OR (state NOT IN ('done','dead') AND completed_at IS NULL))
) STRICT;`;

/** Called after WAL/FULL setup. Version is re-read under the write lock. */
export function initializeSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    if (version === 0) {
      if (tables.length !== 0) throw new Error('Unrelated database');
      db.exec(createInbox);
    } else if (version === 1) {
      if (tables.length !== 1 || tables[0] !== 'inbox') throw new Error('Unexpected legacy schema');
      // Build/copy/swap in one transaction so failure leaves the old schema intact.
      db.exec(createInbox.replace('CREATE TABLE inbox (', 'CREATE TABLE inbox_next ('));
      db.exec(`INSERT INTO inbox_next(id,body,body_hash,signed_at,received_at,state,available_at)
        SELECT id,body,body_hash,signed_at,received_at,state,received_at FROM inbox;
        DROP TABLE inbox;
        ALTER TABLE inbox_next RENAME TO inbox;`);
    } else if (version !== SCHEMA_VERSION) throw new Error('Unsupported schema');

    if (version !== SCHEMA_VERSION) db.exec(`
      CREATE INDEX inbox_ready ON inbox(state,available_at,received_at,id);
      CREATE TABLE ledger (
        entry_id TEXT PRIMARY KEY NOT NULL,
        account TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 1000000000),
        first_event_id TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version=2;
    `);
    db.prepare(`SELECT id,body,body_hash,signed_at,received_at,state,attempts,available_at,
      lease_token,lease_until,last_error,completed_at FROM inbox LIMIT 0`).all();
    db.prepare('SELECT entry_id,account,amount,first_event_id,applied_at FROM ledger LIMIT 0').all();
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Keep original initialization error. */ }
    throw error;
  }
}

export type EventState = 'pending' | 'leased' | 'retry' | 'done' | 'dead';
export const receiptColumns = `id, body_hash AS bodyHash, signed_at AS signedAt, received_at AS receivedAt,
  state, attempts, available_at AS availableAt, lease_until AS leaseUntil,
  last_error AS lastError, completed_at AS completedAt`;
