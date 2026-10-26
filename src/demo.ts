import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Authenticator } from './auth.js';
import { Inbox, inspectInbox } from './inbox.js';
import { startReceiver } from './server.js';

/** Synthetic loopback intake demonstration; no worker/effect claim. */
export async function runIntakeDemo() {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-intake-'));
  const path = join(dir, 'inbox.sqlite');
  const key = randomBytes(32);
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from('{"type":"ledger.credit","data":{"entryId":"demo_credit","amount":25}}');
  let inbox: Inbox | undefined;
  let receiver: Awaited<ReturnType<typeof startReceiver>> | undefined;
  try {
    inbox = new Inbox(path);
    receiver = await startReceiver({ inbox, auth: new Authenticator([`whsec_${key.toString('base64')}`]), now: () => now });
    const url = receiver.url + '/webhooks';
    async function send(payload = body, timestamp = now, tamper = false) {
      const signature = createHmac('sha256', key).update(`msg_demo.${timestamp}.`).update(payload).digest('base64');
      const res = await fetch(url, { method: 'POST', headers: {
        'content-type': 'application/json', 'webhook-id': tamper ? 'msg_changed' : 'msg_demo',
        'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${signature}`,
      }, body: payload });
      await res.arrayBuffer();
      return res.status;
    }
    const statuses = await Promise.all(Array.from({ length: 20 }, () => send()));
    assert.equal(statuses.filter(s => s === 202).length, 1);
    assert.equal(statuses.filter(s => s === 200).length, 19);
    const conflict = await send(Buffer.from('{"type":"ledger.credit","data":{"amount":999}}'));
    const tampered = await send(body, now, true);
    const stale = await send(body, now - 301);
    assert.equal(conflict, 409); assert.equal(tampered, 401); assert.equal(stale, 401);
    await receiver.close(); receiver = undefined;
    inbox.close(); inbox = undefined;
    const snapshot = inspectInbox(path);
    assert.equal(snapshot.total, 1);
    const report = {
      dataset: 'Synthetic local intake; one event delivered 20 times concurrently',
      acceptedNew: statuses.filter(s => s === 202).length,
      acceptedDuplicate: statuses.filter(s => s === 200).length,
      conflictingBodyStatus: conflict,
      tamperedIdStatus: tampered,
      staleAttemptStatus: stale,
      durableRowsAfterReopen: snapshot.total,
      state: snapshot.events[0]?.state,
      limitations: 'Intake only. Pending events have not been processed; this does not demonstrate worker recovery or exactly-once effects.',
    };
    return report;
  } finally {
    await receiver?.close(); inbox?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIntakeDemo().then(report => console.log(JSON.stringify(report, null, 2))).catch(() => {
    console.error('Intake demo failed'); process.exitCode = 1;
  });
}
