import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIntakeDemo } from '../src/demo.js';

test('integrated synthetic intake demo proves duplicate and rejection behavior', async () => {
  const report = await runIntakeDemo();
  assert.equal(report.acceptedNew, 1);
  assert.equal(report.acceptedDuplicate, 19);
  assert.equal(report.durableRowsAfterReopen, 1);
  assert.equal(report.state, 'pending');
});
