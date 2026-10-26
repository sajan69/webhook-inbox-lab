import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox, inspectInbox } from '../src/inbox.js';
import { processNext } from '../src/worker.js';

const inboxModule = new URL('../src/inbox.js', import.meta.url).href;
const workerModule = new URL('../src/worker.js', import.meta.url).href;
const event = (id = 'event') => ({ id, timestamp: 1000,
  body: Buffer.from('{"type":"ledger.credit","data":{"entryId":"shared","account":"lab","amount":25}}') });
function disk() {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-recovery-'));
  return { path: join(dir, 'inbox.sqlite'), clean: () => rmSync(dir, { recursive: true, force: true }) };
}
function killAt(path: string, code: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Inbox } from ${JSON.stringify(inboxModule)};
    const path=process.argv[1];
    ${code}
    process.kill(process.pid, 'SIGKILL');
  `, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
}
function children(path: string, code: string): Promise<string[]> {
  return Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { Inbox } from ${JSON.stringify(inboxModule)};
      import { processBatch } from ${JSON.stringify(workerModule)};
      const inbox = new Inbox(process.argv[1]);
      ${code}
      inbox.close();
    `, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(error)); });
  })));
}
test('a terminated lease owner is recovered by a new process connection without duplicating the effect', () => {
  const temp = disk();
  try {
    const inbox = new Inbox(temp.path); inbox.enqueue(event(), 1000); inbox.close();
    killAt(temp.path, 'const inbox = new Inbox(path); inbox.claim(1000,1);');
    assert.equal(inspectInbox(temp.path).events[0]?.state, 'leased');
    const recovered = new Inbox(temp.path);
    assert.equal(processNext(recovered, { now: 1001 }).state, 'done');
    assert.equal(recovered.inspect()[0]?.attempts, 2); recovered.close();
    assert.deepEqual(inspectInbox(temp.path).ledger, { entries: 1, totalUnits: 25 });
  } finally { temp.clean(); }
});
test('process termination inside the effect transaction rolls back uncommitted ledger data', () => {
  const temp = disk();
  try {
    const inbox = new Inbox(temp.path); inbox.enqueue(event(), 1000); inbox.claim(1000); inbox.close();
    killAt(temp.path, `
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?)').run('shared','lab',25,'event',1000);
    `);
    assert.equal(inspectInbox(temp.path).ledger.entries, 0);
    const recovered = new Inbox(temp.path);
    assert.equal(processNext(recovered, { now: 1030 }).state, 'done'); recovered.close();
    assert.equal(inspectInbox(temp.path).ledger.entries, 1);
  } finally { temp.clean(); }
});
test('process termination after the combined commit retains completion and does not reapply', () => {
  const temp = disk();
  try {
    const inbox = new Inbox(temp.path); inbox.enqueue(event(), 1000); inbox.close();
    killAt(temp.path, 'const inbox = new Inbox(path); inbox.completeLedger(inbox.claim(1000),1000);');
    const recovered = new Inbox(temp.path);
    assert.equal(processNext(recovered, { now: 2000 }).state, 'idle');
    assert.equal(recovered.enqueue(event(), 2000), 'duplicate'); recovered.close();
    const snapshot = inspectInbox(temp.path);
    assert.equal(snapshot.events[0]?.state, 'done');
    assert.deepEqual(snapshot.ledger, { entries: 1, totalUnits: 25 });
  } finally { temp.clean(); }
});
test('eight independent concurrent claimers obtain only one active lease', async () => {
  const temp = disk();
  try {
    const inbox = new Inbox(temp.path); inbox.enqueue(event(), 1000); inbox.close();
    const results = await children(temp.path, 'console.log(JSON.stringify(inbox.claim(1000)));');
    assert.equal(results.map(line => JSON.parse(line)).filter(Boolean).length, 1);
    assert.equal(inspectInbox(temp.path).events[0]?.attempts, 1);
  } finally { temp.clean(); }
});
test('concurrent worker processes complete duplicate business events with one ledger entry', async () => {
  const temp = disk();
  try {
    const inbox = new Inbox(temp.path);
    for (let n = 0; n < 8; n++) inbox.enqueue(event(`event_${n}`), 1000);
    inbox.close();
    await children(temp.path, 'console.log(JSON.stringify(processBatch(inbox,100)));');
    const snapshot = inspectInbox(temp.path);
    assert.equal(snapshot.events.filter(row => row.state === 'done').length, 8);
    assert.ok(snapshot.events.every(row => row.attempts === 1));
    assert.deepEqual(snapshot.ledger, { entries: 1, totalUnits: 25 });
  } finally { temp.clean(); }
});
