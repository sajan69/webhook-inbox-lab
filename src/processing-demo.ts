import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Authenticator } from './auth.js';
import { Inbox, inspectInbox } from './inbox.js';
import { processNext, TransientHandlerError } from './worker.js';
import { startReceiver } from './server.js';

/** Uses real HTTP and persistent SQLite; retry/expiry time advances without sleeps. */
export async function runProcessingDemo() {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-processing-')); const path = join(dir, 'inbox.sqlite');
  const key = randomBytes(32); const start = Math.floor(Date.now() / 1000);
  let inbox: Inbox | undefined; let receiver: Awaited<ReturnType<typeof startReceiver>> | undefined;
  const credit = (entryId: string, amount: number) => ({ type: 'ledger.credit', data: { entryId, account: 'lab', amount } });
  const scenarios: [string, unknown][] = [
    ['h_reordered', credit('independent', 3)], // Delivered first, independent of processing order.
    ['a_original', credit('shared', 25)],
    ['b_business_duplicate', credit('shared', 25)],
    ['c_business_conflict', credit('shared', 999)],
    ['d_retry_then_ok', credit('retry', 7)],
    ['e_retry_exhausted', credit('exhausted', 9)],
    ['f_interrupted_claim', credit('recovered', 11)],
    ['g_invalid_business', { type: 'ledger.credit', data: { entryId: 'bad', account: 'lab', amount: '25' } }],
  ];
  try {
    inbox = new Inbox(path);
    receiver = await startReceiver({ inbox, auth: new Authenticator([`whsec_${key.toString('base64')}`]), now: () => start });
    async function send(id: string, value: unknown) {
      const body = Buffer.from(JSON.stringify(value));
      const signature = createHmac('sha256', key).update(`${id}.${start}.`).update(body).digest('base64');
      const response = await fetch(receiver!.url + '/webhooks', { method: 'POST', body, headers: {
        'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(start), 'webhook-signature': `v1,${signature}`,
      } });
      await response.arrayBuffer(); return response.status;
    }
    for (const [id, value] of scenarios) assert.equal(await send(id, value), 202);
    assert.equal(await send('a_original', credit('shared', 25)), 200);
    await receiver.close(); receiver = undefined;
    inbox.close(); inbox = new Inbox(path); // Persistent enqueue/restart boundary.
    let restartsAfterClaim = 0;
    let interrupted = false;
    let elapsed = 0;
    for (; elapsed <= 120; elapsed++) {
      for (let n = 0; n < 50; n++) {
        let faultInjected = false;
        try {
          const step = processNext(inbox, { now: start + elapsed, beforeLedger: lease => {
            if (lease.id === 'd_retry_then_ok' && lease.attempt <= 2) throw new TransientHandlerError();
            if (lease.id === 'e_retry_exhausted') throw new TransientHandlerError();
            if (lease.id === 'f_interrupted_claim' && !interrupted) {
              interrupted = true; faultInjected = true; throw new Error('Synthetic interruption');
            }
          } });
          if (step.state === 'idle') break;
        } catch (error) {
          if (!faultInjected) throw error;
          inbox.close(); inbox = new Inbox(path); restartsAfterClaim++;
        }
      }
      if (inbox.inspect().every(row => row.state === 'done' || row.state === 'dead')) break;
    }
    const snapshot = inspectInbox(path);
    const attempts = Object.fromEntries(snapshot.events.map(row => [row.id, row.attempts]));
    const done = snapshot.events.filter(row => row.state === 'done').length;
    const dead = snapshot.events.filter(row => row.state === 'dead').length;
    assert.equal(done, 5); assert.equal(dead, 3);
    assert.deepEqual(snapshot.ledger, { entries: 4, totalUnits: 46 });
    assert.equal(attempts.d_retry_then_ok, 3); assert.equal(attempts.e_retry_exhausted, 5);
    assert.equal(attempts.f_interrupted_claim, 2); assert.equal(restartsAfterClaim, 1);
    return {
      dataset: 'Eight synthetic events, one repeated delivery and one duplicate immutable business key',
      method: 'Real loopback HTTP intake and SQLite reopen; injected faults and virtual worker clock for retries/expiry',
      retainedEvents: snapshot.total, completedEvents: done, deadLetters: dead,
      ledgerEntries: snapshot.ledger.entries, ledgerTotalUnits: snapshot.ledger.totalUnits,
      retryThenSuccessAttempts: attempts.d_retry_then_ok,
      exhaustedAttempts: attempts.e_retry_exhausted,
      recoveredLeaseAttempts: attempts.f_interrupted_claim,
      restartsAfterUnsettledClaim: restartsAfterClaim,
      simulatedSecondsElapsed: elapsed,
      deadLetterReasons: Object.fromEntries(snapshot.events.filter(row => row.state === 'dead').map(row => [row.id, row.lastError])),
      limitations: 'Synthetic functional drill, not a timing benchmark. This demo reopens after an injected interruption; separate tests use SIGKILL. No external effects or physical power-loss guarantee.',
    };
  } finally {
    await receiver?.close(); inbox?.close(); rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProcessingDemo().then(result => console.log(JSON.stringify(result, null, 2))).catch(() => {
    console.error('Processing demo failed'); process.exitCode = 1;
  });
}
