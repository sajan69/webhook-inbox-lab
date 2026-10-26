import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { Authenticator, MAX_BODY_BYTES } from '../src/auth.js';
import { Inbox } from '../src/inbox.js';
import { startReceiver } from '../src/server.js';

const key = Buffer.alloc(32, 9);
const auth = new Authenticator([`whsec_${key.toString('base64')}`]);
const now = 1_800_000_000;
const body = Buffer.from('{"type":"ledger.credit","data":{"amount":10}}');
function signed(payload = body, id = 'msg_http', timestamp = now): Record<string, string> {
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.`).update(payload).digest('base64')}` };
}
async function withReceiver(fn: (url: string, inbox: Inbox) => Promise<void>, capacity = 100) {
  const inbox = new Inbox(':memory:', capacity);
  const receiver = await startReceiver({ inbox, auth, now: () => now });
  try { await fn(receiver.url, inbox); } finally { await receiver.close(); try { inbox.close(); } catch { /* Fault injection may close it. */ } }
}
function raw(url: string, payload: Buffer, headers: Record<string, string | string[]>, chunked = false) {
  return new Promise<number>((resolve, reject) => {
    const req = request(url + '/webhooks', { method: 'POST', headers }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    if (chunked) { req.write(payload.subarray(0, 100)); req.end(payload.subarray(100)); }
    else req.end(payload);
  });
}
test('new delivery is acknowledged after insertion; duplicates and conflicts are explicit', async () => {
  await withReceiver(async (url, inbox) => {
    let res = await fetch(url + '/webhooks', { method: 'POST', headers: signed(), body });
    assert.equal(res.status, 202); assert.deepEqual(await res.json(), { status: 'inserted' }); assert.equal(inbox.count(), 1);
    res = await fetch(url + '/webhooks', { method: 'POST', headers: signed(body, 'msg_http', now + 1), body });
    assert.equal(res.status, 200); await res.body?.cancel();
    const changed = Buffer.from('{"type":"ledger.credit","data":{"amount":99}}');
    res = await fetch(url + '/webhooks', { method: 'POST', headers: signed(changed), body: changed });
    assert.equal(res.status, 409); await res.body?.cancel(); assert.equal(inbox.count(), 1);
  });
});
test('invalid signatures and stale attempts cannot insert rows', async () => {
  await withReceiver(async (url, inbox) => {
    for (const headers of [{ ...signed(), 'webhook-id': 'tampered' }, signed(body, 'stale', now - 301), { 'content-type': 'application/json' }]) {
      const res = await fetch(url + '/webhooks', { method: 'POST', headers, body });
      assert.equal(res.status, 401); assert.deepEqual(await res.json(), { status: 'invalid_webhook' });
    }
    assert.equal(inbox.count(), 0);
  });
});
test('authenticated invalid UTF-8, malformed JSON and unsupported event shapes fail without storage', async () => {
  await withReceiver(async (url, inbox) => {
    for (const payload of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from('null'), Buffer.from('[]'), Buffer.from('{"type":"bad type","data":{}}')]) {
      const res = await fetch(url + '/webhooks', { method: 'POST', headers: signed(payload), body: payload });
      assert.equal(res.status, 422); await res.body?.cancel();
    }
    assert.equal(inbox.count(), 0);
  });
});
test('rejects oversized fixed-length and chunked bodies without acknowledging or persisting', async () => {
  await withReceiver(async (url, inbox) => {
    const big = Buffer.alloc(MAX_BODY_BYTES + 1, 32);
    assert.equal(await raw(url, big, { ...signed(big), 'content-length': String(big.length) }), 413);
    assert.equal(await raw(url, big, signed(big), true), 413);
    assert.equal(inbox.count(), 0);
  });
});
test('rejects ambiguous authentication headers, encodings and browser origins', async () => {
  await withReceiver(async (url, inbox) => {
    assert.equal(await raw(url, body, { ...signed(), 'webhook-id': ['msg_http', 'other'] }), 400);
    for (const [extra, status] of [[{ origin: 'https://untrusted.invalid' }, 403], [{ host: 'untrusted.invalid' }, 403], [{ 'content-encoding': 'gzip' }, 415], [{ 'content-type': 'text/plain' }, 415]] as const) {
      // Use node:http so Host reaches the wire unchanged; fetch can override it.
      assert.equal(await raw(url, body, { ...signed(), ...extra }), status);
    }
    assert.equal(inbox.count(), 0);
  });
});
test('storage failure returns retryable sanitized failure, never a success acknowledgment', async () => {
  await withReceiver(async (url, inbox) => {
    inbox.close();
    const res = await fetch(url + '/webhooks', { method: 'POST', headers: signed(), body });
    assert.equal(res.status, 503); assert.equal(res.headers.get('retry-after'), '5');
    assert.deepEqual(await res.json(), { status: 'storage_unavailable' });
  });
});
test('capacity is retryable; duplicate at capacity still succeeds', async () => {
  await withReceiver(async (url, inbox) => {
    for (const [id, status] of [['first', 202], ['second', 503], ['first', 200]] as const) {
      const res = await fetch(url + '/webhooks', { method: 'POST', headers: signed(body, id), body });
      assert.equal(res.status, status); await res.body?.cancel();
    }
    assert.equal(inbox.count(), 1);
  }, 1);
});
test('health is minimal, responses are not cached, and no inspection route is exposed', async () => {
  await withReceiver(async url => {
    const res = await fetch(url + '/health'); assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await res.json(), { status: 'ready' });
    const inspection = await fetch(url + '/inbox'); assert.equal(inspection.status, 404); await inspection.body?.cancel();
    const wrongMethod = await fetch(url + '/webhooks'); assert.equal(wrongMethod.status, 405); await wrongMethod.body?.cancel();
  });
});
