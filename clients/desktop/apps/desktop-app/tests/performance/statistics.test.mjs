import assert from 'node:assert/strict';
import test from 'node:test';
import { percentile, summarize } from './statistics.mjs';

test('percentile sorts and interpolates finite values', () => {
  assert.equal(percentile([40, 10, Number.NaN, 30, 20], 0.5), 25);
  assert.equal(percentile([10, 20, 30], 0.95), 29);
});

test('summarize returns stable empty and populated shapes', () => {
  assert.deepEqual(summarize([]), {
    count: 0,
    min: null,
    mean: null,
    p50: null,
    p95: null,
    p99: null,
    max: null,
  });
  assert.deepEqual(summarize([1, 2, 3]), {
    count: 3,
    min: 1,
    mean: 2,
    p50: 2,
    p95: 2.9,
    p99: 2.98,
    max: 3,
  });
});
