import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { arch, availableParallelism, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { Authenticator } from './auth.js';
import { Inbox, inspectInbox } from './inbox.js';
import { processNext } from './worker.js';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function runBenchmark(uniqueEvents = 500, repeats = 3) {
  if (!Number.isInteger(uniqueEvents) || uniqueEvents < 1 || uniqueEvents > 2000
    || !Number.isInteger(repeats) || repeats < 1 || repeats > 7) throw new Error('Invalid benchmark workload');
  const now = Math.floor(Date.now() / 1000);
  const key = Buffer.alloc(32, 42); // Public dummy key, synthetic in-process workload only.
  const auth = new Authenticator([`whsec_${key.toString('base64')}`]);
  const deliveries = Array.from({ length: uniqueEvents }, (_, n) => {
    const id = `bench_${n}`;
    const body = Buffer.from(JSON.stringify({ type: 'ledger.credit', data: { entryId: `entry_${n}`, account: 'lab', amount: 1 } }));
    const signature = `v1,${createHmac('sha256', key).update(`${id}.${now}.`).update(body).digest('base64')}`;
    return { body, headers: { id, timestamp: String(now), signature } };
  });
  const runs = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const dir = mkdtempSync(join(tmpdir(), 'webhook-benchmark-')); const path = join(dir, 'inbox.sqlite');
    let inbox: Inbox | undefined;
    try {
      inbox = new Inbox(path);
      let inserted = 0; let duplicates = 0; let processed = 0;
      let start = performance.now();
      for (const item of deliveries) {
        if (inbox.enqueue(auth.verify(item.body, item.headers, now), now) === 'inserted') inserted++;
      }
      const insertMs = performance.now() - start;
      start = performance.now();
      for (const item of deliveries) {
        if (inbox.enqueue(auth.verify(item.body, item.headers, now), now) === 'duplicate') duplicates++;
      }
      const duplicateMs = performance.now() - start;
      start = performance.now();
      for (let n = 0; n <= uniqueEvents; n++) {
        const result = processNext(inbox, { now });
        if (result.state === 'idle') break;
        assert.equal(result.state, 'done'); processed++;
      }
      const processingMs = performance.now() - start;
      const snapshot = inspectInbox(path, 1);
      assert.equal(inserted, uniqueEvents); assert.equal(duplicates, uniqueEvents); assert.equal(processed, uniqueEvents);
      assert.equal(snapshot.total, uniqueEvents); assert.equal(snapshot.ledger.entries, uniqueEvents);
      assert.equal(snapshot.ledger.totalUnits, uniqueEvents);
      inbox.close(); inbox = undefined;
      runs.push({ repeat, inserted, duplicates, processed, insertMs, duplicateMs, processingMs, databaseBytesAfterClose: statSync(path).size });
    } finally { inbox?.close(); rmSync(dir, { recursive: true, force: true }); }
  }
  return {
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, sqlite: process.versions.sqlite,
      package: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string,
      platform: platform(), arch: arch(), kernel: release(), availableParallelism: availableParallelism() },
    workload: { uniqueEvents, repeatedIdenticalDeliveries: uniqueEvents,
      uniqueBodyBytes: deliveries.reduce((total, item) => total + item.body.length, 0), repeats,
      signature: 'HMAC v1; pre-generated signatures with one fixed verification timestamp per workload',
      storage: 'Fresh temporary file per repeat; WAL; synchronous=FULL; no pre-populated ledger' },
    method: 'Single process, sequential calls. Insert/duplicate times include signature verification and complete enqueue transactions. Processing includes claim plus effect/completion transactions and one idle check. Generation, schema setup, inspection and close are outside timers. No HTTP or concurrent sender is measured.',
    runs,
    mediansMs: { insert: median(runs.map(row => row.insertMs)), duplicate: median(runs.map(row => row.duplicateMs)), processing: median(runs.map(row => row.processingMs)) },
    limitations: 'Synthetic functional microbenchmark on a shared host and temporary filesystem with unknown backing storage/cache behavior. No competing implementation baseline, HTTP latency, production SLA or physical durability claim. Sequential phase order and warm caches can affect results.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 2 || args.some(value => !/^[1-9][0-9]{0,3}$/.test(value))) throw new Error('Invalid arguments');
    console.log(JSON.stringify(runBenchmark(args[0] === undefined ? 500 : Number(args[0]), args[1] === undefined ? 3 : Number(args[1])), null, 2));
  } catch { console.error('Benchmark failed; expected events 1-2000 and repeats 1-7'); process.exitCode = 1; }
}
