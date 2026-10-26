import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { Authenticator, MAX_BODY_BYTES, VerificationError } from '../src/auth.js';

const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const next = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
const now = 1_800_000_000;
const body = Buffer.from('{ "type": "example.event", "text": "café" }');
const auth = new Authenticator([secret]);
function headers(id = 'msg_test', timestamp = String(now), payload = body, key = secret) {
  return { id, timestamp, signature: `v1,${createHmac('sha256', Buffer.from(key.slice(6), 'base64'))
    .update(`${id}.${timestamp}.`).update(payload).digest('base64')}` };
}

test('accepts reference-library signature without reserializing JSON', () => {
  const signature = new Webhook(secret).sign('msg_test', new Date(now * 1000), body);
  assert.equal(auth.verify(body, { ...headers(), signature }, now).id, 'msg_test');
});
test('raw bytes, including invalid UTF-8, are authenticated exactly', () => {
  const bytes = Buffer.from([0xff, 0x00, 0x80]);
  assert.deepEqual(auth.verify(bytes, headers('bytes', String(now), bytes), now).body, bytes);
  assert.throws(() => auth.verify(Buffer.from(bytes.toString()), headers('bytes', String(now), bytes), now), VerificationError);
});
test('changing ID, timestamp or original whitespace invalidates the signature', () => {
  for (const h of [{ ...headers(), id: 'different' }, { ...headers(), timestamp: String(now + 1) }]) {
    assert.throws(() => auth.verify(body, h, now), VerificationError);
  }
  assert.throws(() => auth.verify(Buffer.from(JSON.stringify(JSON.parse(body.toString()))), headers(), now), VerificationError);
});
test('inclusive freshness bounds reject older and future attempts', () => {
  for (const delta of [-300, 300]) assert.ok(auth.verify(body, headers('fresh', String(now + delta)), now));
  for (const delta of [-301, 301]) assert.throws(() => auth.verify(body, headers('stale', String(now + delta)), now), VerificationError);
});
test('rejects ambiguous IDs and timestamps rather than parsing prefixes', () => {
  for (const id of ['', 'id.dot', 'id space', 'x'.repeat(129), '日本']) {
    assert.throws(() => auth.verify(body, headers(id), now), VerificationError);
  }
  for (const value of ['1800000000junk', '01800000000', '-1', '1.8e9', '1800000000.0', '']) {
    assert.throws(() => auth.verify(body, headers('bad', value), now), VerificationError);
  }
});
test('rotation accepts either trusted secret and any matching v1 signature', () => {
  const rotated = new Authenticator([secret, next]);
  assert.ok(rotated.verify(body, headers('msg_test', String(now), body, next), now));
  const signature = `v2,ignored ${headers().signature} ${headers('msg_test', String(now), body, next).signature}`;
  assert.ok(new Authenticator([next]).verify(body, { ...headers(), signature }, now));
  assert.throws(() => new Authenticator([next]).verify(body, headers(), now), VerificationError);
});
test('rejects malformed, excessive and unknown-only signatures', () => {
  for (const signature of ['', 'v2,abc', 'v1,abc', 'v1,' + 'A'.repeat(44), 'x'.repeat(2049), Array(9).fill(headers().signature).join(' ')]) {
    assert.throws(() => auth.verify(body, { ...headers(), signature }, now), VerificationError);
  }
});
test('configuration fails closed without including secret values', () => {
  for (const values of [[], ['bad-secret'], ['whsec_%%%'], [`whsec_${Buffer.alloc(23).toString('base64')}`], [secret, next, secret]]) {
    assert.throws(() => new Authenticator(values), e => e instanceof Error && !e.message.includes('bad-secret'));
  }
});
test('body limits and returned body isolation', () => {
  const tooBig = Buffer.alloc(MAX_BODY_BYTES + 1);
  assert.throws(() => auth.verify(tooBig, headers('large', String(now), tooBig), now), VerificationError);
  const original = Buffer.from(body);
  const verified = auth.verify(original, headers(), now);
  original.fill(0);
  assert.deepEqual(verified.body, body);
});
