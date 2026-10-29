/**
 * Noise-aware three-way verdicts for repeated timing samples (methodology R4).
 *
 * Each timing metric of a scenario is a set of samples per side, one per
 * launch. A metric is `regressed` or `improved` only when both hold:
 *
 * - The two-sided Mann–Whitney U (Wilcoxon rank-sum) test rejects "both sides
 *   come from one distribution" at `alpha`, after a Holm correction across the
 *   scenario's timing metrics.
 * - The p50 and the p75 of the samples both moved past an effect-size floor,
 *   in the same direction: `max(minEffectPercent of the baseline quantile,
 *   the metric's minRegressionAbsolute, or minEffectMs for milliseconds)`.
 *
 * Everything else is `inconclusive`. The p95 and max of the samples are
 * reported for diagnosis and never decide a verdict.
 *
 * Why Mann–Whitney U and not a bootstrap interval of the median difference:
 * comparisons here have 5 to 15 launches per side. At that size a percentile
 * bootstrap treats the handful of observed values as the population (with five
 * samples a resampled median can take only five values), so its interval is
 * too narrow and a build compared with itself reports false shifts more often
 * than its nominal level. The rank-sum test computed from its exact
 * permutation distribution is valid at any sample size whenever the two sides
 * are exchangeable, which is what interleaving the builds is designed to
 * provide. Ranks also resist the heavy right tail of wall-clock samples, where
 * one slow launch moves a mean but not a rank. The p-values allow the Holm
 * correction that a scenario with thirty timing metrics needs so that a build
 * compared with itself does not report a regression from one of them by
 * chance, and the effect floor keeps statistically real but negligible shifts
 * from being reported as a change. The test is deterministic: no random
 * resampling, so no seed.
 *
 * The exact distribution conditions on the pooled values, so tied samples,
 * such as a zero-variance side, are handled exactly. Above
 * `EXACT_TEST_MAX_SAMPLES` pooled samples the normal approximation with a tie
 * correction is used instead.
 */
import { percentile } from './statistics.mjs';

export const VERDICT_DEFAULTS = Object.freeze({
  alpha: 0.05,
  minEffectPercent: 5,
  minEffectMs: 20,
  intervalLevel: 0.95,
});

/** Pooled sample count up to which p-values come from the exact distribution. */
export const EXACT_TEST_MAX_SAMPLES = 60;

export const VERDICTS = Object.freeze([
  'improved',
  'regressed',
  'inconclusive',
]);

const sum = (values) => values.reduce((total, value) => total + value, 0);

/** Ranks with ties sharing the mean of their positions (1-based). */
export function midranks(values) {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const ranks = new Array(values.length);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (
      end + 1 < order.length &&
      order[end + 1].value === order[start].value
    )
      end += 1;
    const rank = (start + end) / 2 + 1;
    for (let index = start; index <= end; index += 1)
      ranks[order[index].index] = rank;
    start = end + 1;
  }
  return ranks;
}

/**
 * The number of `size`-element subsets of `weights` (non-negative integers)
 * with each total, indexed by the total.
 */
function subsetSumCounts(weights, size) {
  const total = sum(weights);
  const ways = Array.from(
    { length: size + 1 },
    () => new Float64Array(total + 1),
  );
  ways[0][0] = 1;
  let reach = 0;
  for (const [index, weight] of weights.entries()) {
    reach += weight;
    for (let chosen = Math.min(size, index + 1); chosen >= 1; chosen -= 1) {
      const row = ways[chosen];
      const previous = ways[chosen - 1];
      for (let value = reach; value >= weight; value -= 1)
        row[value] += previous[value - weight];
    }
  }
  return ways[size];
}

function binomial(n, k) {
  let result = 1;
  for (let index = 1; index <= k; index += 1)
    result = (result * (n - k + index)) / index;
  return result;
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, error below 1.5e-7). */
function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    t *
      (0.254829592 +
        t *
          (-0.284496736 +
            t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
      Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

function normalQuantile(probability) {
  let low = -10;
  let high = 10;
  for (let step = 0; step < 100; step += 1) {
    const middle = (low + high) / 2;
    if (normalCdf(middle) < probability) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/**
 * The smallest two-sided p-value the rank-sum test can return for these
 * sample sizes: complete separation of the two sides, without ties.
 */
export function minimumTwoSidedPValue(baselineCount, candidateCount) {
  if (baselineCount < 1 || candidateCount < 1) return 1;
  return Math.min(
    1,
    2 / binomial(baselineCount + candidateCount, candidateCount),
  );
}

/**
 * The fewest samples per side at which complete separation can reach
 * `alpha` after a Holm correction over `tests` metrics.
 */
export function requiredSamplesPerSide(alpha, tests) {
  const threshold = alpha / Math.max(1, tests);
  for (let samples = 2; samples <= 1_000; samples += 1) {
    if (minimumTwoSidedPValue(samples, samples) <= threshold) return samples;
  }
  return null;
}

/**
 * Two-sided Mann–Whitney U test of `candidate` against `baseline`. `u` counts
 * the pairs in which the candidate sample is larger (ties count one half).
 */
export function rankSumTest(baseline, candidate) {
  const baselineCount = baseline.length;
  const candidateCount = candidate.length;
  if (baselineCount === 0 || candidateCount === 0) return null;
  const pooledCount = baselineCount + candidateCount;
  // Doubled midranks are integers, so the exact distribution can be counted.
  const doubled = midranks([...baseline, ...candidate]).map((rank) =>
    Math.round(rank * 2),
  );
  const observed = sum(doubled.slice(baselineCount));
  const expected = candidateCount * (pooledCount + 1);
  const u = observed / 2 - (candidateCount * (candidateCount + 1)) / 2;
  const distance = Math.abs(observed - expected);
  if (pooledCount <= EXACT_TEST_MAX_SAMPLES) {
    const counts = subsetSumCounts(doubled, candidateCount);
    let total = 0;
    let tail = 0;
    for (const [value, count] of counts.entries()) {
      if (count === 0) continue;
      total += count;
      if (Math.abs(value - expected) >= distance - 1e-9) tail += count;
    }
    return { u, pValue: Math.min(1, tail / total), method: 'exact' };
  }
  const ties = new Map();
  for (const rank of doubled) ties.set(rank, (ties.get(rank) ?? 0) + 1);
  const tieTerm = sum([...ties.values()].map((size) => size ** 3 - size));
  // Variance of the doubled rank sum, with the tie correction.
  const variance =
    ((4 * baselineCount * candidateCount) / 12) *
    (pooledCount + 1 - tieTerm / (pooledCount * (pooledCount - 1)));
  if (variance <= 0) return { u, pValue: 1, method: 'normal' };
  const z = Math.max(0, distance - 1) / Math.sqrt(variance);
  return {
    u,
    pValue: Math.min(1, 2 * (1 - normalCdf(z))),
    method: 'normal',
  };
}

/**
 * The largest U whose lower-tail probability under the untied null is at most
 * `tailProbability`, or -1 when even U = 0 is more likely than that.
 */
function lowerCriticalU(baselineCount, candidateCount, tailProbability) {
  const pooledCount = baselineCount + candidateCount;
  if (pooledCount > EXACT_TEST_MAX_SAMPLES) {
    const pairs = baselineCount * candidateCount;
    const deviation = Math.sqrt((pairs * (pooledCount + 1)) / 12);
    return Math.floor(pairs / 2 + normalQuantile(tailProbability) * deviation);
  }
  const counts = subsetSumCounts(
    Array.from({ length: pooledCount }, (_, index) => 2 * (index + 1)),
    candidateCount,
  );
  const total = sum(counts);
  const offset = candidateCount * (candidateCount + 1);
  let cumulative = 0;
  let critical = -1;
  for (let u = 0; u <= baselineCount * candidateCount; u += 1) {
    cumulative += counts[offset + 2 * u];
    if (cumulative / total > tailProbability) break;
    critical = u;
  }
  return critical;
}

/**
 * Hodges–Lehmann estimate of the candidate-minus-baseline shift (the median
 * of all pairwise differences) and its distribution-free interval at `level`,
 * from the rank-sum distribution. Bounds are null when the samples are too
 * few for an interval at that level.
 */
export function hodgesLehmannShift(baseline, candidate, level) {
  const differences = [];
  for (const candidateValue of candidate)
    for (const baselineValue of baseline)
      differences.push(candidateValue - baselineValue);
  differences.sort((left, right) => left - right);
  if (differences.length === 0)
    return { estimate: null, lower: null, upper: null, level };
  const critical = lowerCriticalU(
    baseline.length,
    candidate.length,
    (1 - level) / 2,
  );
  return {
    estimate: percentile(differences, 0.5),
    lower: critical < 0 ? null : differences[critical],
    upper: critical < 0 ? null : differences[differences.length - 1 - critical],
    level,
  };
}

/** Holm step-down adjusted p-values; non-finite entries stay null. */
export function holmAdjust(pValues) {
  const ranked = pValues
    .map((pValue, index) => ({ pValue, index }))
    .filter((entry) => Number.isFinite(entry.pValue))
    .sort((left, right) => left.pValue - right.pValue);
  const adjusted = pValues.map(() => null);
  let running = 0;
  for (const [rank, entry] of ranked.entries()) {
    running = Math.max(
      running,
      Math.min(1, (ranked.length - rank) * entry.pValue),
    );
    adjusted[entry.index] = running;
  }
  return adjusted;
}

/** Quantiles of one side's samples; p95 and max are diagnostic only. */
export function sampleQuantiles(values) {
  if (values.length === 0)
    return { count: 0, p50: null, p75: null, p95: null, max: null };
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

/** The smallest shift of a quantile that counts as a change. */
export function effectFloor(metric, reference, options = VERDICT_DEFAULTS) {
  const absolute = Number.isFinite(metric.minRegressionAbsolute)
    ? metric.minRegressionAbsolute
    : metric.unit === 'ms'
      ? options.minEffectMs
      : 0;
  return Math.max(
    absolute,
    (options.minEffectPercent / 100) * Math.abs(reference ?? 0),
  );
}

function percentChange(delta, reference) {
  return reference === 0 || !Number.isFinite(reference)
    ? null
    : (delta / Math.abs(reference)) * 100;
}

function measureMetric(input, options) {
  const baseline = input.baseline?.filter(Number.isFinite) ?? null;
  const candidate = input.candidate?.filter(Number.isFinite) ?? null;
  const record = {
    key: input.key,
    unit: input.unit,
    direction: input.direction ?? 'lower',
    baseline: sampleQuantiles(baseline ?? []),
    candidate: sampleQuantiles(candidate ?? []),
    delta: null,
    floors: null,
    shift: null,
    test: null,
    verdict: 'inconclusive',
    reason: null,
  };
  // Absent from a side's artifact, or present with no comparable sample.
  if (!baseline || !candidate) {
    record.reason = !baseline ? 'missing-baseline' : 'missing-candidate';
    return record;
  }
  if (baseline.length === 0 || candidate.length === 0) {
    record.reason = 'no-comparable-samples';
    return record;
  }
  const p50 = record.candidate.p50 - record.baseline.p50;
  const p75 = record.candidate.p75 - record.baseline.p75;
  record.delta = {
    p50,
    p75,
    p50Percent: percentChange(p50, record.baseline.p50),
    p75Percent: percentChange(p75, record.baseline.p75),
  };
  record.floors = {
    p50: effectFloor(input, record.baseline.p50, options),
    p75: effectFloor(input, record.baseline.p75, options),
  };
  record.shift = hodgesLehmannShift(baseline, candidate, options.intervalLevel);
  const pooled = [...baseline, ...candidate];
  if (pooled.every((value) => value === pooled[0])) {
    record.reason = 'identical';
    return record;
  }
  record.test = {
    ...rankSumTest(baseline, candidate),
    minimumPValue: minimumTwoSidedPValue(baseline.length, candidate.length),
    adjustedPValue: null,
  };
  return record;
}

/** +1 when the p50 and p75 both moved past their floors toward worse, -1 toward better. */
function flooredDirection(record) {
  const worse = record.direction === 'higher' ? -1 : 1;
  const p50 = worse * record.delta.p50;
  const p75 = worse * record.delta.p75;
  if (p50 > record.floors.p50 && p75 > record.floors.p75) return 1;
  if (p50 < -record.floors.p50 && p75 < -record.floors.p75) return -1;
  return 0;
}

/** Sets a tested metric's verdict and the reason for it. */
function assignVerdict(record, tests, options) {
  const direction = flooredDirection(record);
  if (record.test.adjustedPValue <= options.alpha) {
    record.verdict =
      direction === 0
        ? 'inconclusive'
        : direction > 0
          ? 'regressed'
          : 'improved';
    record.reason = direction === 0 ? 'below-effect-floor' : 'significant';
  } else {
    // Underpowered: even complete separation could not pass the first Holm step.
    record.reason =
      record.test.minimumPValue * tests > options.alpha
        ? 'underpowered'
        : 'not-significant';
  }
  // A shift past the floor that the test could not confirm: the case where
  // more samples would most likely change the verdict.
  record.suggestive = record.verdict === 'inconclusive' && direction !== 0;
}

/**
 * Judges one scenario's timing metrics. Each input is `{ key, unit,
 * direction, minRegressionAbsolute, baseline, candidate }` with the sample
 * arrays, or null for a metric the side did not report.
 *
 * The Holm family is every metric with a test. A metric whose pooled samples
 * are all equal has a degenerate permutation distribution and can never be
 * rejected; leaving it out conditions only on the pooled values, which the
 * permutation null already does, so the family-wise error stays controlled.
 */
export function judgeScenarioMetrics(inputs, overrides = {}) {
  const options = { ...VERDICT_DEFAULTS, ...overrides };
  const metrics = inputs.map((input) => measureMetric(input, options));
  const tested = metrics.filter((record) => record.test);
  const adjusted = holmAdjust(tested.map((record) => record.test.pValue));
  for (const [index, record] of tested.entries())
    record.test.adjustedPValue = adjusted[index];
  const tests = tested.length;
  for (const record of tested) assignVerdict(record, tests, options);
  const count = (verdict) =>
    metrics.filter((record) => record.verdict === verdict).length;
  const counts = {
    improved: count('improved'),
    regressed: count('regressed'),
    inconclusive: count('inconclusive'),
  };
  const sampleCounts = tested.map((record) =>
    Math.min(record.baseline.count, record.candidate.count),
  );
  return {
    verdict:
      counts.regressed > 0
        ? 'regressed'
        : counts.improved > 0
          ? 'improved'
          : 'inconclusive',
    tests,
    counts,
    underpowered:
      tests > 0 && tested.every((record) => record.reason === 'underpowered'),
    samplesPerSide: sampleCounts.length > 0 ? Math.min(...sampleCounts) : 0,
    requiredSamplesPerSide:
      tests > 0 ? requiredSamplesPerSide(options.alpha, tests) : null,
    metrics,
  };
}

/** Rerun guidance for an inconclusive scenario, one line per cause. */
export function scenarioRerunGuidance(scenario, overrides = {}) {
  const options = { ...VERDICT_DEFAULTS, ...overrides };
  if (scenario.verdict !== 'inconclusive') return [];
  const lines = [];
  const excluded = scenario.excludedSamples ?? { baseline: 0, candidate: 0 };
  if (excluded.baseline > 0 || excluded.candidate > 0) {
    lines.push(
      `${excluded.baseline} baseline and ${excluded.candidate} candidate sample(s) failed and were left out; fix the failure and rerun.`,
    );
  }
  const missing = scenario.metrics.filter((record) =>
    ['missing-baseline', 'missing-candidate'].includes(record.reason),
  );
  if (missing.length > 0) {
    lines.push(
      `${missing.length} timing metric(s) were reported by one side only (${missing
        .slice(0, 3)
        .map((record) => record.key)
        .join(
          ', ',
        )}${missing.length > 3 ? ', …' : ''}); check both builds ran the same scenario.`,
    );
  }
  if (scenario.tests === 0) {
    lines.push('No timing metric could be tested; rerun with more samples.');
    return lines;
  }
  if (scenario.underpowered) {
    lines.push(
      `Underpowered: with ${scenario.samplesPerSide} sample(s) per side the test cannot reach α=${options.alpha} across ${scenario.tests} timing metrics. Rerun with --repeat ${scenario.requiredSamplesPerSide} or more.`,
    );
    return lines;
  }
  const suggestive = scenario.metrics
    .filter((record) => record.suggestive)
    .sort(
      (left, right) =>
        Math.abs(right.delta.p50Percent ?? 0) -
        Math.abs(left.delta.p50Percent ?? 0),
    );
  if (suggestive.length > 0) {
    lines.push(
      `${suggestive.length} metric(s) moved past the effect floor without reaching significance (largest: ${suggestive[0].key}, p50 ${formatSigned(suggestive[0].delta.p50Percent, '%')}). Rerun with --repeat ${Math.max(2 * scenario.samplesPerSide, scenario.requiredSamplesPerSide ?? 0)} on a quieter host to decide it.`,
    );
  } else {
    lines.push(
      `No timing moved past its effect floor (${options.minEffectPercent}% or ${options.minEffectMs} ms). Rerun only to resolve a smaller effect: raise --repeat or lower --min-effect-percent.`,
    );
  }
  return lines;
}

function formatSigned(value, suffix = '') {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}${suffix}`;
}

/**
 * Journey timings for the geometric-mean headline: end-to-end durations
 * (scenario wall time, launch milestones, per-run task and typing medians,
 * journey and phase timings), not sampler readings or within-run tails.
 */
export function isJourneyMetric(key, unit) {
  if (unit !== 'ms') return false;
  const rest = key.slice(key.indexOf('.') + 1);
  return (
    rest === 'wall_ms' ||
    rest.startsWith('launch.') ||
    rest.startsWith('timing.') ||
    /^task\.[^.]+\.p50_ms$/.test(rest) ||
    /^typing\.[^.]+\.p50_ms$/.test(rest)
  );
}

export function geometricMean(values) {
  const positive = values.filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  if (positive.length === 0) return null;
  return Math.exp(
    sum(positive.map((value) => Math.log(value))) / positive.length,
  );
}

/**
 * Candidate/baseline p50 ratios of each scenario's journey timings, their
 * geometric mean per scenario, and the geometric mean across scenarios (each
 * scenario weighs the same however many journeys it has). Descriptive only.
 */
export function geometricMeanHeadline(scenarios) {
  const perScenario = [];
  for (const scenario of scenarios) {
    const ratios = scenario.metrics
      .filter(
        (record) =>
          isJourneyMetric(record.key, record.unit) &&
          record.baseline.p50 > 0 &&
          record.candidate.p50 > 0,
      )
      .map((record) => record.candidate.p50 / record.baseline.p50);
    const ratio = geometricMean(ratios);
    if (ratio !== null)
      perScenario.push({ name: scenario.name, ratio, metrics: ratios.length });
  }
  const ratio = geometricMean(perScenario.map((entry) => entry.ratio));
  return {
    ratio,
    percent: ratio === null ? null : (ratio - 1) * 100,
    scenarios: perScenario,
  };
}
