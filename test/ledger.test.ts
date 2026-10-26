import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Inbox, inspectInbox, StorageError } from '../src/inbox.js';
import { LedgerError } from '../src/ledger.js';
import { LeaseError, type Lease } from '../src/leases.js';
import { processNext, TransientHandlerError } from '../src/worker.js';

const now = 1000;
const credit = (entryId = 'entry_1', amount = 25) => ({ type: 'ledger.credit', data: { entryId, account: 'demo', amount } });
function enqueue(inbox: Inbox, id: string, value: unknown) {
  inbox.enqueue({ id, timestamp: now, body: Buffer.from(JSON.stringify(value)) }, now);
}
function claim(inbox: Inbox, at = now): Lease { const lease = inbox.claim(at); assert.ok(lease); return lease; }
function disk() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-')); const path = join(dir, 'inbox.sqlite');
  return { path, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
test('different delivery IDs for one immutable business entry apply only one effect', () => {
  const temp = disk();
  try {
    const inbox = new Inbox(temp.path);
    enqueue(inbox, 'event_b', credit()); enqueue(inbox, 'event_a', credit());
    assert.deepEqual(processNext(inbox, { now }), { id: 'event_a', state: 'done', effect: 'applied' });
    assert.deepEqual(processNext(inbox, { now }), { id: 'event_b', state: 'done', effect: 'duplicate' });
    assert.deepEqual(inspectInbox(temp.path).ledger, { entries: 1, totalUnits: 25 });
    assert.ok(inbox.inspect().every(row => row.state === 'done'));
    assert.equal(inbox.enqueue({ id: 'event_a', timestamp: now, body: Buffer.from(JSON.stringify(credit())) }), 'duplicate');
    inbox.close();
  } finally { temp.clean(); }
});
test('business-key conflicts never change the original entry', () => {
  const temp = disk();
  try {
    const inbox = new Inbox(temp.path); enqueue(inbox, 'a', credit()); enqueue(inbox, 'b', credit('entry_1', 99));
    processNext(inbox, { now });
    assert.deepEqual(processNext(inbox, { now }), { id: 'b', state: 'dead' });
    assert.equal(inbox.inspect()[1]?.lastError, 'business_conflict');
    assert.deepEqual(inspectInbox(temp.path).ledger, { entries: 1, totalUnits: 25 }); inbox.close();
  } finally { temp.clean(); }
});
test('strict business validation rejects unknown fields, unsafe integers and non-credit payloads', () => {
  const inbox = new Inbox(':memory:');
  const invalid = [null, { type: 'other', data: {} }, credit('', 25), credit('id', 0), credit('id', 1.5), credit('id', 1e9 + 1),
    { ...credit(), data: { ...credit().data, account: '../bad' } },
    { ...credit(), data: { ...credit().data, amount: '25' } },
    { ...credit(), data: { ...credit().data, destinationUrl: 'https://untrusted.invalid' } }];
  invalid.forEach((value, n) => {
    enqueue(inbox, `bad_${n}`, value);
    assert.equal(processNext(inbox, { now }).state, 'dead');
  });
  assert.ok(inbox.inspect().every(row => row.lastError === 'invalid_event')); inbox.close();
});
test('stale or expired workers cannot commit effects or overwrite recovered work', () => {
  const temp = disk();
  try {
    const inbox = new Inbox(temp.path); enqueue(inbox, 'event', credit());
    const old = claim(inbox);
    assert.throws(() => inbox.completeLedger(old, now + 30), LeaseError);
    const fresh = claim(inbox, now + 30);
    assert.throws(() => inbox.completeLedger(old, now + 31), LeaseError);
    assert.equal(inspectInbox(temp.path).ledger.entries, 0);
    assert.equal(inbox.completeLedger(fresh, now + 31), 'applied');
    assert.throws(() => inbox.fail(old, 'invalid_event', now + 31), LeaseError); inbox.close();
  } finally { temp.clean(); }
});
test('failure after effect insertion rolls back both effect and completion', () => {
  const temp = disk();
  try {
    const inbox = new Inbox(temp.path); enqueue(inbox, 'event', credit());
    const lease = claim(inbox);
    const db = new DatabaseSync(temp.path);
    db.exec(`CREATE TRIGGER abort_done BEFORE UPDATE OF state ON inbox WHEN NEW.state='done'
      BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END;`);
    assert.throws(() => inbox.completeLedger(lease, now), StorageError);
    assert.equal(inspectInbox(temp.path).ledger.entries, 0);
    assert.equal(inbox.inspect()[0]?.state, 'leased');
    db.exec('DROP TRIGGER abort_done'); db.close();
    assert.equal(inbox.completeLedger(lease, now), 'applied'); inbox.close();
  } finally { temp.clean(); }
});
test('already-applied entry is reconciled without repeating its effect', () => {
  const temp = disk();
  try {
    const inbox = new Inbox(temp.path); enqueue(inbox, 'later_event', credit());
    const db = new DatabaseSync(temp.path);
    db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?)').run('entry_1', 'demo', 25, 'previous_event', 900); db.close();
    assert.deepEqual(processNext(inbox, { now }), { id: 'later_event', state: 'done', effect: 'duplicate' });
    assert.deepEqual(inspectInbox(temp.path).ledger, { entries: 1, totalUnits: 25 }); inbox.close();
  } finally { temp.clean(); }
});
test('worker retries only explicit transient faults and does not store arbitrary exception text', () => {
  const inbox = new Inbox(':memory:'); enqueue(inbox, 'retry', credit());
  assert.equal(processNext(inbox, { now, beforeLedger: () => { throw new TransientHandlerError(); } }).state, 'retry');
  assert.equal(processNext(inbox, { now }).state, 'idle');
  assert.equal(processNext(inbox, { now: now + 1 }).state, 'done');
  enqueue(inbox, 'unknown', credit('entry_2'));
  assert.throws(() => processNext(inbox, { now, beforeLedger: () => { throw new Error('sensitive marker'); } }), e => e instanceof Error && e.message === 'Worker unavailable');
  assert.equal(inbox.inspect().find(row => row.id === 'unknown')?.state, 'leased');
  assert.ok(!JSON.stringify(inbox.inspect()).includes('sensitive marker')); inbox.close();
});
test('direct ledger validation errors preserve the lease until worker records terminal state', () => {
  const inbox = new Inbox(':memory:'); enqueue(inbox, 'invalid', { type: 'bad', data: {} });
  const lease = claim(inbox);
  assert.throws(() => inbox.completeLedger(lease, now), LedgerError);
  assert.equal(inbox.inspect()[0]?.state, 'leased'); inbox.close();
});
