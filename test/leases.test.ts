import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inbox } from '../src/inbox.js';
import { LeaseError, type Lease } from '../src/leases.js';

const event = { id: 'lease_test', timestamp: 1000, body: Buffer.from('{}') };
function claim(inbox: Inbox, now: number, seconds = 30): Lease {
  const result = inbox.claim(now, seconds); assert.ok(result); return result;
}
test('claims only eligible rows, never a live lease, and recovers at the exact expiry boundary', () => {
  const inbox = new Inbox(':memory:'); inbox.enqueue(event, 1000);
  assert.equal(inbox.claim(999), null);
  const first = claim(inbox, 1000);
  assert.equal(inbox.claim(1029), null);
  assert.throws(() => inbox.fail(first, 'transient_handler_error', 1030), LeaseError);
  const recovered = claim(inbox, 1030);
  assert.equal(recovered.attempt, 2); assert.notEqual(first.token, recovered.token);
  assert.equal(inbox.inspect()[0]?.lastError, 'lease_expired');
  assert.throws(() => inbox.fail(first, 'invalid_event', 1031), LeaseError);
  inbox.close();
});
test('backoff survives new claims and fifth failed attempt becomes dead without a sixth claim', () => {
  const inbox = new Inbox(':memory:'); inbox.enqueue(event, 1000); let now = 1000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const lease = claim(inbox, now);
    assert.equal(lease.attempt, attempt);
    assert.equal(inbox.fail({ ...lease, attempt: 0 }, 'transient_handler_error', now), attempt === 5 ? 'dead' : 'retry');
    if (attempt < 5) {
      const next = now + 2 ** (attempt - 1);
      assert.equal(inbox.claim(next - 1), null);
      now = next;
    }
  }
  assert.equal(inbox.claim(now + 1000), null);
  assert.equal(inbox.inspect()[0]?.attempts, 5);
  assert.equal(inbox.inspect()[0]?.state, 'dead'); inbox.close();
});
test('five crashed leases are bounded and the next worker sweep records expiration', () => {
  const inbox = new Inbox(':memory:'); inbox.enqueue(event, 1000);
  for (let n = 0; n < 5; n++) assert.equal(claim(inbox, 1000 + n, 1).attempt, n + 1);
  assert.equal(inbox.claim(1005), null);
  assert.equal(inbox.inspect()[0]?.state, 'dead');
  assert.equal(inbox.inspect()[0]?.lastError, 'lease_expired'); inbox.close();
});
test('nonretryable validation failures are terminal and token ownership cannot be forged by ID alone', () => {
  const inbox = new Inbox(':memory:'); inbox.enqueue(event, 1000);
  const lease = claim(inbox, 1000);
  assert.throws(() => inbox.fail({ ...lease, token: 'wrong' }, 'invalid_event', 1000), LeaseError);
  assert.equal(inbox.fail(lease, 'invalid_event', 1000), 'dead');
  assert.equal(inbox.inspect()[0]?.attempts, 1);
  assert.equal(inbox.enqueue(event, 1100), 'duplicate');
  assert.equal(inbox.inspect()[0]?.state, 'dead'); inbox.close();
});
test('claim ordering is stable and invalid parameters do not alter queue state', () => {
  const inbox = new Inbox(':memory:');
  inbox.enqueue({ ...event, id: 'z' }, 1000); inbox.enqueue({ ...event, id: 'a' }, 1000);
  for (const seconds of [0, 301, 1.5]) assert.throws(() => inbox.claim(1000, seconds));
  assert.throws(() => inbox.claim(-1));
  assert.equal(claim(inbox, 1000).id, 'a');
  assert.equal(claim(inbox, 1000).id, 'z'); inbox.close();
});
