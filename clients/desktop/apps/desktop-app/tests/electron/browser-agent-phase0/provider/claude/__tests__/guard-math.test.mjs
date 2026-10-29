import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateTokens,
  median,
  observationGrowth,
  observationsThatFit,
  recommendGuard,
} from '../guard-math.mjs';

test('token estimates are labelled estimates', () => {
  const estimate = estimateTokens(48_000);
  assert.equal(estimate.estimate, true);
  assert.equal(estimate.bytesDiv3, 16_000);
  assert.equal(estimate.bytesDiv4, 12_000);
});

test('observations that fit under the budget', () => {
  assert.equal(
    observationsThatFit({
      fixedBytes: 10_000,
      perObservationBytes: 10_000,
      bytesPerToken: 3,
    }),
    3,
  );
  assert.equal(
    observationsThatFit({
      fixedBytes: 10_000,
      perObservationBytes: 10_000,
      bytesPerToken: 4,
    }),
    5,
  );
  assert.equal(
    observationsThatFit({
      fixedBytes: 60_000,
      perObservationBytes: 10_000,
      bytesPerToken: 3,
    }),
    0,
  );
  assert.equal(
    observationsThatFit({
      fixedBytes: 1,
      perObservationBytes: 0,
      bytesPerToken: 3,
    }),
    null,
  );
});

test('observation growth ignores small acks', () => {
  const growth = observationGrowth([
    { deltaBytes: null },
    { deltaBytes: 19_000 },
    { deltaBytes: 400 },
    { deltaBytes: 21_000 },
  ]);
  assert.deepEqual(growth.samples, [19_000, 21_000]);
  assert.equal(growth.median, 20_000);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
});

test('provisional guard with finite epoch cap inside the task limits', () => {
  const guard = recommendGuard({
    fixedBytes: 12_000,
    growth: { median: 4_000 },
    coldStartMs: [900, 1_100, 1_000],
  });
  assert.equal(guard.status, 'provisional');
  assert.equal(guard.basis.synthetic, true);
  assert.equal(guard.basis.estimate, true);
  assert.equal(guard.perPageGuardBytes, 43_200);
  assert.equal(guard.fitsBy.conservative.observationsWithHeadroom, 7);
  assert.equal(guard.fitsBy.typical.observationsAtFullBudget, 13);
  assert.equal(guard.epochCap.maxObservationActionsPerEpoch, 7);
  assert.equal(guard.epochCap.epochsNeededForActionLimit, 8);
  assert.equal(guard.epochCap.rotationsNeeded, 7);
  assert.equal(guard.epochCap.withinRequestLimit, true);
  assert.equal(guard.rotationCost.coldStartMedianMs, 1_000);
  assert.equal(guard.rotationCost.rotationsTimesColdStartMs, 7_000);
});

test('unresolved when one observation cannot fit the conservative budget', () => {
  const guard = recommendGuard({
    fixedBytes: 40_000,
    growth: { median: 19_000 },
    coldStartMs: [],
  });
  assert.equal(guard.status, 'unresolved');
  assert.match(guard.reason, /tokenizer/);
  assert.equal(guard.fitsBy.conservative.observationsWithHeadroom, 0);
  const none = recommendGuard({ fixedBytes: null, growth: { median: null } });
  assert.equal(none.status, 'unresolved');
});
