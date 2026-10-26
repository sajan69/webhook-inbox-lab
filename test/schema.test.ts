import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Inbox, StorageError, inspectInbox } from '../src/inbox.js';

const body = Buffer.from('{"type":"ledger.credit","data":{"entryId":"old"}}');
function legacy(path: string, malformed = false) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE inbox(id TEXT PRIMARY KEY NOT NULL, body BLOB NOT NULL, body_hash TEXT NOT NULL,
    signed_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending') STRICT; PRAGMA user_version=1;`);
  db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?)').run('old', body, createHash('sha256').update(body).digest('hex'), 1000, 1001, malformed ? 'bad' : 'pending');
  db.close(); chmodSync(path, 0o600);
}
test('version-one migration preserves payload identity, timestamps and duplicate history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-migrate-')); const path = join(dir, 'inbox.sqlite');
  try {
    legacy(path);
    const inbox = new Inbox(path);
    assert.equal(inbox.enqueue({ id: 'old', body, timestamp: 2000 }), 'duplicate');
    assert.equal(inbox.inspect()[0]?.signedAt, 1000);
    assert.equal(inbox.inspect()[0]?.receivedAt, 1001);
    assert.equal(inbox.inspect()[0]?.availableAt, 1001);
    assert.equal(inbox.inspect()[0]?.attempts, 0); inbox.close();
    new Inbox(path).close(); // Reopening does not repeat migration.
    assert.equal(inspectInbox(path).total, 1);
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.deepEqual(Buffer.from(db.prepare('SELECT body FROM inbox').get()?.body as Uint8Array), body); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('failed migration rolls back schema swap and version without dropping the original row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-migrate-')); const path = join(dir, 'inbox.sqlite');
  try {
    legacy(path, true);
    assert.throws(() => new Inbox(path), StorageError);
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM inbox').get()?.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='inbox_next'").get()?.n, 0); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('read-only inspection does not migrate a legacy database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-migrate-')); const path = join(dir, 'inbox.sqlite');
  try {
    legacy(path); assert.throws(() => inspectInbox(path), StorageError);
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
