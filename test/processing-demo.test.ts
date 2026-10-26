import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcessingDemo } from '../src/processing-demo.js';

test('end-to-end processing drill proves retries, expiry recovery and immutable effects', async () => {
  const result = await runProcessingDemo();
  assert.equal(result.completedEvents, 5); assert.equal(result.deadLetters, 3);
  assert.equal(result.ledgerEntries, 4); assert.equal(result.ledgerTotalUnits, 46);
  assert.equal(result.retryThenSuccessAttempts, 3); assert.equal(result.exhaustedAttempts, 5);
});
