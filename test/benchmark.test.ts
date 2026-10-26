import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark } from '../src/benchmark.js';

test('small benchmark verifies counts and isolates fresh databases per repeat without speed assertions', () => {
  const report = runBenchmark(3, 2);
  assert.equal(report.runs.length, 2);
  for (const row of report.runs) {
    assert.equal(row.inserted, 3); assert.equal(row.duplicates, 3); assert.equal(row.processed, 3);
    assert.ok(row.insertMs > 0); assert.ok(row.processingMs > 0); assert.ok(row.databaseBytesAfterClose > 0);
  }
  assert.ok(report.workload.uniqueBodyBytes > 0);
});
test('benchmark refuses invalid or excessive workloads before opening databases', () => {
  for (const [count, repeats] of [[0, 1], [2001, 1], [1.5, 1], [1, 0], [1, 8]] as const) {
    assert.throws(() => runBenchmark(count, repeats));
  }
});
