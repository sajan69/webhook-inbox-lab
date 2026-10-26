import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Inbox, CapacityError, ConflictError, StorageError } from '../src/inbox.js';

const delivery = { id: 'event_1', timestamp: 1_800_000_000, body: Buffer.from('{"type":"test"}') };
function location() {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-test-'));
  return { path: join(dir, 'inbox.sqlite'), clean: () => rmSync(dir, { recursive: true, force: true }) };
}
test('committed intake survives close/reopen; retry preserves original metadata', () => {
  const temp = location();
  try {
    let inbox = new Inbox(temp.path);
    assert.equal(inbox.enqueue(delivery, 100), 'inserted');
    inbox.close(); inbox = new Inbox(temp.path);
    assert.equal(inbox.enqueue({ ...delivery, timestamp: delivery.timestamp + 30 }, 200), 'duplicate');
    assert.equal(inbox.count(), 1);
    assert.equal(inbox.inspect()[0]?.receivedAt, 100);
    assert.equal(inbox.inspect()[0]?.signedAt, delivery.timestamp);
    assert.ok(!('body' in (inbox.inspect()[0] ?? {})));
    inbox.close();
    if (process.platform !== 'win32') assert.equal(statSync(temp.path).mode & 0o777, 0o600);
  } finally { temp.clean(); }
});
test('conflicting authenticated ID rolls back and leaves original bytes intact', () => {
  const inbox = new Inbox(':memory:');
  inbox.enqueue(delivery);
  assert.throws(() => inbox.enqueue({ ...delivery, body: Buffer.from('changed') }), ConflictError);
  assert.equal(inbox.enqueue(delivery), 'duplicate');
  assert.equal(inbox.enqueue({ ...delivery, id: 'event_2' }), 'inserted');
  assert.equal(inbox.count(), 2); inbox.close();
});
test('capacity rejects new rows while acknowledging existing duplicates', () => {
  const inbox = new Inbox(':memory:', 1); inbox.enqueue(delivery);
  assert.throws(() => inbox.enqueue({ ...delivery, id: 'event_2' }), CapacityError);
  assert.equal(inbox.enqueue(delivery), 'duplicate');
  assert.equal(inbox.count(), 1); inbox.close();
});
test('closed storage raises sanitized errors and bounded inspection validates limits', () => {
  const inbox = new Inbox(':memory:');
  for (const n of [0, 1001, 1.5]) assert.throws(() => inbox.inspect(n));
  inbox.close();
  assert.throws(() => inbox.enqueue(delivery), StorageError);
  assert.throws(() => inbox.inspect(), StorageError);
});
test('refuses unrelated databases without creating inbox tables', () => {
  const temp = location();
  try {
    const db = new DatabaseSync(temp.path); db.exec('CREATE TABLE personal (id INTEGER)'); db.close();
    chmodSync(temp.path, 0o600);
    assert.throws(() => new Inbox(temp.path), StorageError);
    const inspect = new DatabaseSync(temp.path);
    assert.equal(inspect.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='inbox'").get()?.n, 0);
    inspect.close();
  } finally { temp.clean(); }
});
test('refuses symlink database paths and permissive existing file modes', { skip: process.platform === 'win32' }, () => {
  const temp = location();
  try {
    new Inbox(temp.path).close();
    symlinkSync(temp.path, temp.path + '.link');
    assert.throws(() => new Inbox(temp.path + '.link'), StorageError);
    chmodSync(temp.path, 0o644);
    assert.throws(() => new Inbox(temp.path), StorageError);
  } finally { temp.clean(); }
});
test('independent concurrent processes converge on one durable event', async () => {
  const temp = location();
  try {
    new Inbox(temp.path).close();
    const module = new URL('../src/inbox.js', import.meta.url).href;
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const script = `import { Inbox } from ${JSON.stringify(module)};
        const inbox = new Inbox(process.argv[1]);
        console.log(inbox.enqueue({id:'event_1',timestamp:1800000000,body:Buffer.from('{"type":"test"}')}));
        inbox.close();`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, temp.path], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
    })));
    assert.equal(results.filter(x => x === 'inserted').length, 1);
    assert.equal(results.filter(x => x === 'duplicate').length, 7);
    const inbox = new Inbox(temp.path); assert.equal(inbox.count(), 1); inbox.close();
  } finally { temp.clean(); }
});
