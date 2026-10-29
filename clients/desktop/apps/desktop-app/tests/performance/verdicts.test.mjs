import assert from 'node:assert/strict';
import test from 'node:test';
import {
  geometricMeanHeadline,
  holmAdjust,
  hodgesLehmannShift,
  isJourneyMetric,
  judgeScenarioMetrics,
  midranks,
  minimumTwoSidedPValue,
  rankSumTest,
  requiredSamplesPerSide,
  scenarioRerunGuidance,
} from './verdicts.mjs';

/** Seeded PRNG (mulberry32), so every synthetic distribution is reproducible. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` normal samples (Box–Muller) drawn from the injected PRNG. */
function normalSamples(random, count, mean, deviation) {
  return Array.from({ length: count }, () => {
    const radius = Math.sqrt(-2 * Math.log(1 - random()));
    return mean + deviation * radius * Math.cos(2 * Math.PI * random());
  });
}

/** Right-skewed launch times: a floor plus a log-normal tail. */
function launchSamples(random, count, floor, scale) {
  return normalSamples(random, count, 0, 0.6).map(
    (value) => floor + scale * Math.exp(value),
  );
}

function metric(key, baseline, candidate, fields = {}) {
  return { key, unit: 'ms', baseline, candidate, ...fields };
}

function judgeOne(baseline, candidate, fields = {}, options = {}) {
  const scenario = judgeScenarioMetrics(
    [metric('startup-settle.launch.shell_ms', baseline, candidate, fields)],
    options,
  );
  return { scenario, record: scenario.metrics[0] };
}

/** Exhaustive two-sided rank-sum p-value, the definition the DP must match. */
function bruteForcePValue(baseline, candidate) {
  const pooled = [...baseline, ...candidate];
  const ranks = midranks(pooled);
  const expected = (candidate.length * (pooled.length + 1)) / 2;
  const observed = ranks
    .slice(baseline.length)
    .reduce((total, rank) => total + rank, 0);
  let total = 0;
  let tail = 0;
  const choose = (start, left, rankSum) => {
    if (left === 0) {
      total += 1;
      if (Math.abs(rankSum - expected) >= Math.abs(observed - expected) - 1e-9)
        tail += 1;
      return;
    }
    for (let index = start; index <= pooled.length - left; index += 1)
      choose(index + 1, left - 1, rankSum + ranks[index]);
  };
  choose(0, candidate.length, 0);
  return tail / total;
}

test('the exact rank-sum p-value matches exhaustive enumeration, ties included', () => {
  const cases = [
    [
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
    ],
    [
      [1, 2, 3, 4, 5],
      [1.5, 2.5, 3.5, 4.5, 5.5],
    ],
    [
      [0, 0, 0, 1, 1],
      [1, 1, 2, 2, 2],
    ],
    [
      [100, 100, 100, 100],
      [100, 101, 102, 100, 103],
    ],
    [
      [3, 1, 4, 1, 5, 9, 2],
      [6, 5, 3, 5, 8, 9, 7, 9],
    ],
  ];
  for (const [baseline, candidate] of cases) {
    const result = rankSumTest(baseline, candidate);
    assert.equal(result.method, 'exact');
    assert.ok(
      Math.abs(result.pValue - bruteForcePValue(baseline, candidate)) < 1e-12,
      `${baseline} vs ${candidate}`,
    );
  }
  // Complete separation of five against five: 2 / C(10, 5).
  assert.equal(rankSumTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]).pValue, 2 / 252);
  assert.equal(minimumTwoSidedPValue(5, 5), 2 / 252);
  assert.equal(rankSumTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]).u, 25);
});

test('large samples fall back to the tie-corrected normal approximation', () => {
  const random = seededRandom(7);
  const baseline = normalSamples(random, 40, 100, 5);
  const candidate = normalSamples(random, 40, 100, 5);
  const result = rankSumTest(baseline, candidate);
  assert.equal(result.method, 'normal');
  assert.ok(result.pValue > 0 && result.pValue <= 1);
  const shifted = rankSumTest(
    baseline,
    candidate.map((value) => value + 30),
  );
  assert.ok(shifted.pValue < 1e-6);
});

test('the Hodges-Lehmann interval uses the rank-sum critical value', () => {
  // For five against five at 95% the critical count is 3: the interval runs
  // from the 3rd to the 23rd of the 25 ordered pairwise differences.
  const shift = hodgesLehmannShift([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], 0.95);
  assert.deepEqual(shift, { estimate: 5, lower: 2, upper: 8, level: 0.95 });
  // Three against three cannot give a 95% interval.
  const tiny = hodgesLehmannShift([1, 2, 3], [4, 5, 6], 0.95);
  assert.equal(tiny.estimate, 3);
  assert.equal(tiny.lower, null);
  assert.equal(tiny.upper, null);
});

test('Holm adjustment is step-down and monotone', () => {
  assert.deepEqual(holmAdjust([0.01, 0.04, 0.03, null]), [
    0.03,
    0.06,
    0.06,
    null,
  ]);
  assert.deepEqual(holmAdjust([0.5]), [0.5]);
  assert.deepEqual(holmAdjust([0.4, 0.9]), [0.8, 0.9]);
});

test('a clear improvement is improved', () => {
  const random = seededRandom(1);
  // Baseline centred 30 ms above the candidate, low variance.
  const { scenario, record } = judgeOne(
    normalSamples(random, 7, 530, 3),
    normalSamples(random, 7, 500, 3),
  );
  assert.equal(record.verdict, 'improved');
  assert.equal(record.reason, 'significant');
  assert.ok(record.delta.p50 < -20 && record.delta.p75 < -20);
  assert.ok(record.shift.upper < 0, 'the whole interval is an improvement');
  assert.equal(scenario.verdict, 'improved');
  assert.deepEqual(scenarioRerunGuidance(scenario), []);
});

test('a clear regression is regressed', () => {
  const random = seededRandom(2);
  const { scenario, record } = judgeOne(
    normalSamples(random, 7, 500, 3),
    normalSamples(random, 7, 540, 3),
  );
  assert.equal(record.verdict, 'regressed');
  assert.ok(record.test.adjustedPValue <= 0.05);
  assert.ok(record.shift.lower > 0);
  assert.equal(scenario.verdict, 'regressed');
});

test('two samples from one distribution are inconclusive', () => {
  const random = seededRandom(3);
  const { scenario, record } = judgeOne(
    launchSamples(random, 8, 2_000, 300),
    launchSamples(random, 8, 2_000, 300),
  );
  assert.equal(record.verdict, 'inconclusive');
  assert.equal(record.reason, 'not-significant');
  assert.equal(scenario.verdict, 'inconclusive');
  assert.ok(scenarioRerunGuidance(scenario).length > 0);
});

test('pure noise almost never produces a regressed verdict', () => {
  const random = seededRandom(4);
  let regressed = 0;
  let improved = 0;
  const trials = 400;
  for (let trial = 0; trial < trials; trial += 1) {
    const { record } = judgeOne(
      launchSamples(random, 7, 2_000, 300),
      launchSamples(random, 7, 2_000, 300),
    );
    if (record.verdict === 'regressed') regressed += 1;
    if (record.verdict === 'improved') improved += 1;
  }
  // Each direction is bounded by alpha / 2 = 2.5% before the effect floor.
  assert.ok(regressed / trials <= 0.025, `${regressed} of ${trials}`);
  assert.ok(improved / trials <= 0.025, `${improved} of ${trials}`);
});

test('a scenario with many noisy metrics keeps its family-wise error', () => {
  const random = seededRandom(5);
  let regressedScenarios = 0;
  const trials = 100;
  for (let trial = 0; trial < trials; trial += 1) {
    const inputs = Array.from({ length: 30 }, (_, index) =>
      metric(
        `startup-settle.metric_${index}.p95_ms`,
        launchSamples(random, 8, 100, 40),
        launchSamples(random, 8, 100, 40),
      ),
    );
    if (judgeScenarioMetrics(inputs).verdict === 'regressed')
      regressedScenarios += 1;
  }
  assert.ok(regressedScenarios / trials <= 0.05, `${regressedScenarios}`);
});

test('too few samples are underpowered, with the repeat count that would decide', () => {
  const { scenario, record } = judgeOne([100, 101], [300, 301]);
  assert.equal(record.verdict, 'inconclusive');
  assert.equal(record.reason, 'underpowered');
  assert.equal(scenario.underpowered, true);
  assert.equal(scenario.requiredSamplesPerSide, 4);
  assert.match(scenarioRerunGuidance(scenario)[0], /--repeat 4 or more/);
  // Thirty metrics need seven samples per side before any can be decided.
  assert.equal(requiredSamplesPerSide(0.05, 30), 7);
  assert.equal(requiredSamplesPerSide(0.05, 1), 4);
});

test('identical samples are inconclusive and leave the Holm family', () => {
  const scenario = judgeScenarioMetrics([
    metric(
      'chats.renderer.frame_delay.p95_ms',
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ),
    metric(
      'chats.wall_ms',
      [500, 501, 502, 503, 504],
      [560, 561, 562, 563, 564],
    ),
  ]);
  const [identical, wall] = scenario.metrics;
  assert.equal(identical.verdict, 'inconclusive');
  assert.equal(identical.reason, 'identical');
  assert.equal(identical.test, null);
  assert.equal(scenario.tests, 1);
  // With one tested metric, complete separation of five against five decides.
  assert.equal(wall.verdict, 'regressed');
});

test('a zero-variance side is tested exactly with its ties', () => {
  const random = seededRandom(6);
  const { record } = judgeOne(
    Array(8).fill(1_000),
    normalSamples(random, 8, 1_200, 10),
  );
  assert.equal(record.test.method, 'exact');
  assert.equal(record.verdict, 'regressed');
  const constant = judgeOne(Array(5).fill(1_000), Array(5).fill(1_500));
  assert.equal(constant.record.verdict, 'regressed');
  assert.equal(constant.record.test.pValue, 2 / 252);
});

test('a metric missing on one side is inconclusive and named in the guidance', () => {
  const scenario = judgeScenarioMetrics([
    metric(
      'chats.wall_ms',
      [500, 501, 502, 503, 504],
      [500, 502, 501, 503, 504],
    ),
    metric('chats.timing.j7.first_token_ms', [40, 41, 42, 43, 44], null),
    metric('chats.timing.j7.settled_ms', null, [90, 91, 92, 93, 94]),
    metric('chats.launch.shell_ms', [], [90, 91]),
  ]);
  const reasons = scenario.metrics.map((record) => record.reason);
  assert.deepEqual(reasons.slice(1), [
    'missing-candidate',
    'missing-baseline',
    'no-comparable-samples',
  ]);
  assert.equal(scenario.verdict, 'inconclusive');
  assert.equal(scenario.tests, 1);
  const guidance = scenarioRerunGuidance(scenario).join('\n');
  assert.match(guidance, /2 timing metric\(s\) were reported by one side only/);
  assert.match(guidance, /chats\.timing\.j7\.first_token_ms/);
});

test('a significant shift below the effect floor is not a change', () => {
  const random = seededRandom(8);
  const { record } = judgeOne(
    normalSamples(random, 10, 1_000, 1),
    normalSamples(random, 10, 1_004, 1),
  );
  assert.ok(record.test.adjustedPValue <= 0.05);
  assert.equal(record.reason, 'below-effect-floor');
  assert.equal(record.verdict, 'inconclusive');
  // The metric's own floor replaces the millisecond default.
  const fine = judgeOne(
    normalSamples(random, 10, 2, 0.05),
    normalSamples(random, 10, 4, 0.05),
    { minRegressionAbsolute: 1 },
  );
  assert.equal(fine.record.verdict, 'regressed');
});

test('p95 and max are diagnostic: a single slow launch decides nothing', () => {
  const baseline = [500, 502, 504, 506, 508, 510, 512, 514];
  const candidate = [501, 503, 505, 507, 509, 511, 513, 9_000];
  const { record } = judgeOne(baseline, candidate);
  assert.ok(record.candidate.max > 8_000);
  assert.ok(record.candidate.p95 > record.baseline.p95 + 1_000);
  assert.equal(record.verdict, 'inconclusive');
});

test('a regression needs the p50 and p75 to move past the floor together', () => {
  // Every launch is slower, so the test rejects, but only the upper quarter
  // moved past the floor: the p50 shift is 10 ms.
  const baseline = [1_000, 1_001, 1_002, 1_003, 1_004, 1_005, 1_006, 1_007];
  const candidate = [1_010, 1_011, 1_012, 1_013, 1_014, 1_015, 1_400, 1_401];
  const { record } = judgeOne(baseline, candidate);
  assert.ok(record.test.adjustedPValue <= 0.05);
  assert.ok(record.delta.p75 > record.floors.p75);
  assert.ok(record.delta.p50 <= record.floors.p50);
  assert.equal(record.reason, 'below-effect-floor');
  assert.equal(record.verdict, 'inconclusive');
});

test('a shift past the floor without significance asks for more samples', () => {
  const scenario = judgeScenarioMetrics([
    metric(
      'chats.wall_ms',
      [500, 700, 520, 690, 510],
      [560, 760, 580, 750, 570],
    ),
  ]);
  assert.equal(scenario.metrics[0].reason, 'not-significant');
  assert.equal(scenario.metrics[0].suggestive, true);
  assert.match(
    scenarioRerunGuidance(scenario)[0],
    /moved past the effect floor without reaching significance.*--repeat 10/,
  );
});

test('the headline is a geometric mean of journey p50 ratios per scenario', () => {
  assert.equal(isJourneyMetric('chats.wall_ms', 'ms'), true);
  assert.equal(isJourneyMetric('chats.launch.shell_ms', 'ms'), true);
  assert.equal(isJourneyMetric('chats.task.send.p50_ms', 'ms'), true);
  assert.equal(isJourneyMetric('chats.timing.j7.first_token_ms', 'ms'), true);
  assert.equal(isJourneyMetric('chats.task.send.p95_ms', 'ms'), false);
  assert.equal(isJourneyMetric('chats.ipc.outer.p95_ms', 'ms'), false);
  assert.equal(
    isJourneyMetric('chats.resources.cpu.p95_percent', 'percent'),
    false,
  );
  const record = (key, baseline, candidate) => ({
    key,
    unit: 'ms',
    baseline: { p50: baseline },
    candidate: { p50: candidate },
  });
  const headline = geometricMeanHeadline([
    {
      name: 'a',
      metrics: [
        record('a.wall_ms', 100, 200),
        record('a.launch.shell_ms', 100, 50),
        record('a.ipc.outer.p95_ms', 1, 100),
      ],
    },
    { name: 'b', metrics: [record('b.wall_ms', 100, 400)] },
    { name: 'c', metrics: [record('c.wall_ms', 0, 10)] },
  ]);
  assert.deepEqual(
    headline.scenarios.map(({ name, ratio, metrics }) => [
      name,
      ratio,
      metrics,
    ]),
    [
      ['a', 1, 2],
      ['b', 4, 1],
    ],
  );
  assert.ok(Math.abs(headline.ratio - 2) < 1e-12);
  assert.ok(Math.abs(headline.percent - 100) < 1e-9);
});
