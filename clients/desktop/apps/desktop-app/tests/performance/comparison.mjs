import {
  assessSmokeComparison,
  usesLocalSmokePolicy,
} from './smoke-acceptance.mjs';
import {
  assertHeadlessStudyMetadata,
  assertHeadlessWindowEvidence,
} from './browser-profiles-evidence.mjs';
import {
  collectedWorkScopes,
  isRepeatedResult,
  sampleIsComparable,
  workMetricScope,
} from './results.mjs';
import {
  VERDICT_DEFAULTS,
  geometricMeanHeadline,
  judgeScenarioMetrics,
  scenarioRerunGuidance,
} from './verdicts.mjs';

// Artifacts written before metric kinds existed contain only timings.
const metricKind = (entry) => entry?.kind ?? 'time';

function metricsOfKind(metrics, kind) {
  return Object.fromEntries(
    Object.entries(metrics).filter(([, entry]) => metricKind(entry) === kind),
  );
}

/** Every work scope a run collected in full, across its scenarios. */
function runWorkScopes(result) {
  return new Set(
    (result.scenarios ?? []).flatMap((scenario) => [
      ...collectedWorkScopes(scenario),
    ]),
  );
}

/**
 * Work counters are compared exactly and reported, never judged by the
 * timing thresholds: until a counter is admitted, its verdict belongs to the
 * work-counter ratchet (`work-ratchet.mjs`). An absent counter is zero only
 * where both runs collected its scope in full: its source's window, or every
 * task of its kind. Other scopes are unavailable.
 */
function compareWorkCounters(baseline, current, baselineCounts, currentCounts) {
  const baselineScopes = runWorkScopes(baseline);
  const currentScopes = runWorkScopes(current);
  const comparisons = [];
  const unavailable = new Set();
  let mismatch = false;
  const keys = new Set([
    ...Object.keys(baselineCounts),
    ...Object.keys(currentCounts),
  ]);
  for (const key of [...keys].sort()) {
    const baselineMetric = baselineCounts[key];
    const currentMetric = currentCounts[key];
    const scope = workMetricScope(key);
    if (!scope) {
      if (!baselineMetric || !currentMetric) {
        mismatch = true;
        continue;
      }
    } else if (!baselineScopes.has(scope) || !currentScopes.has(scope)) {
      unavailable.add(scope);
      continue;
    }
    if (
      baselineMetric &&
      currentMetric &&
      baselineMetric.unit !== currentMetric.unit
    ) {
      mismatch = true;
      continue;
    }
    // An absent counter is zero; a present one without a value (a repeated
    // artifact with no comparable sample) is unmeasured and is skipped.
    const baselineValue = baselineMetric ? baselineMetric.value : 0;
    const currentValue = currentMetric ? currentMetric.value : 0;
    if (!Number.isFinite(baselineValue) || !Number.isFinite(currentValue)) {
      continue;
    }
    const delta = currentValue - baselineValue;
    comparisons.push({
      key,
      unit: (baselineMetric ?? currentMetric).unit,
      baseline: baselineValue,
      current: currentValue,
      delta,
      percent:
        baselineValue === 0 ? null : (delta / Math.abs(baselineValue)) * 100,
    });
  }
  return { comparisons, unavailable: [...unavailable].sort(), mismatch };
}

function requiresStudyValidation(result) {
  const environment = result.environment;
  return (
    environment?.studyWindowMode !== undefined ||
    (environment?.studyViewportPreset !== undefined &&
      environment.studyViewportPreset !== 'headed-native-1000x640') ||
    result.scenarios?.some((scenario) => scenario.windowEvidence)
  );
}

/**
 * Why two runs cannot be compared. A repeated comparison compares the set of
 * scenario names rather than the records (one per sample) and judges failed
 * samples itself instead of refusing the pair.
 */
function compatibleBaseline(baseline, current, { repeated = false } = {}) {
  const mismatches = [];
  if (baseline.schemaVersion !== current.schemaVersion) {
    mismatches.push('schemaVersion');
  }
  if (baseline.suite !== current.suite) mismatches.push('suite');
  if (baseline.benchmarkKind !== current.benchmarkKind) {
    mismatches.push('benchmarkKind');
  }
  if (baseline.profile !== current.profile) mismatches.push('profile');
  if (baseline.acceptancePolicy !== current.acceptancePolicy)
    mismatches.push('acceptancePolicy');
  const scenarioNames = (result) => {
    const names = (result.scenarios ?? []).map(({ name }) => name);
    return (repeated ? [...new Set(names)] : names).sort();
  };
  const baselineScenarios = scenarioNames(baseline);
  const currentScenarios = scenarioNames(current);
  if (JSON.stringify(baselineScenarios) !== JSON.stringify(currentScenarios)) {
    mismatches.push('scenarios');
  }
  if (JSON.stringify(baseline.config) !== JSON.stringify(current.config)) {
    mismatches.push('config');
  }
  const environmentKeys = [
    'electronVersion',
    'playwrightVersion',
    'nodeVersion',
    'platform',
    'osRelease',
    'architecture',
    'cpuModel',
    'logicalCpuCount',
    'totalMemoryMb',
    'viewport',
    'windowVisible',
    'studyWindowMode',
    'studyViewportPreset',
  ];
  const environmentSnapshot = (result) =>
    Object.fromEntries(
      environmentKeys.map((key) => [key, result.environment?.[key]]),
    );
  if (
    JSON.stringify(environmentSnapshot(baseline)) !==
    JSON.stringify(environmentSnapshot(current))
  ) {
    mismatches.push('environment');
  }
  if (
    !repeated &&
    [...(baseline.scenarios ?? []), ...(current.scenarios ?? [])].some(
      (scenario) => scenario.status !== 'ok',
    )
  ) {
    mismatches.push('scenarioStatus');
  }
  for (const result of repeated ? [] : [baseline, current]) {
    if (requiresStudyValidation(result)) {
      try {
        assertHeadlessStudyMetadata(result.environment);
        if (
          result.scenarios?.length !== 1 ||
          result.scenarios[0].name !== 'browser-panels'
        )
          throw new Error('Hidden study requires one browser-panels scenario');
        for (const scenario of result.scenarios ?? []) {
          assertHeadlessWindowEvidence(scenario.windowEvidence);
          if (scenario.diagnostics?.replay)
            assertHeadlessWindowEvidence(
              scenario.diagnostics.replay.windowEvidence,
            );
        }
      } catch {
        if (!mismatches.includes('studyWindowEvidence'))
          mismatches.push('studyWindowEvidence');
      }
    }
  }
  return mismatches;
}

function normalizeLegacyLongTaskMetrics(metrics) {
  const normalized = { ...metrics };
  const countSuffix = '.renderer.long_tasks.count';
  for (const [key, entry] of Object.entries(metrics)) {
    if (!key.endsWith(countSuffix) || entry?.value !== 0) continue;
    const prefix = key.slice(0, -countSuffix.length);
    const maxKey = `${prefix}.renderer.long_tasks.max_ms`;
    if (normalized[maxKey]) continue;
    normalized[maxKey] = {
      value: 0,
      unit: 'ms',
      direction: 'lower',
      description: 'Renderer longest long task',
    };
  }
  return normalized;
}

export function comparePerformanceResults(
  baseline,
  current,
  { maxRegressionPercent = 15, minRegressionMs = 20 } = {},
) {
  const incompatibilities = compatibleBaseline(baseline, current);
  const study = [baseline, current].some((result) =>
    requiresStudyValidation(result),
  );
  const studyMetadata = study
    ? {
        studyWindowMode: current.environment?.studyWindowMode ?? null,
        studyViewportPreset: current.environment?.studyViewportPreset ?? null,
        viewport: current.environment?.viewport ?? null,
        windowVisible: current.environment?.windowVisible ?? null,
      }
    : {};
  if (study && incompatibilities.length)
    return {
      ...studyMetadata,
      compatible: false,
      incompatibilities,
      thresholds: { maxRegressionPercent, minRegressionMs },
      comparisons: [],
      regressions: [],
      workComparisons: [],
      workUnavailable: [],
      regressedScenarios: [],
      passed: false,
    };
  const comparisons = [];
  const regressions = [];
  const baselineMetrics = normalizeLegacyLongTaskMetrics(
    baseline.metrics ?? {},
  );
  const currentMetrics = normalizeLegacyLongTaskMetrics(current.metrics ?? {});
  // A metric that changes kind, or has a kind this comparator does not know,
  // cannot be compared.
  let metricMismatch = [baselineMetrics, currentMetrics].some((metrics) =>
    Object.entries(metrics).some(
      ([key, entry]) =>
        !['time', 'count'].includes(metricKind(entry)) ||
        (baselineMetrics[key] &&
          currentMetrics[key] &&
          metricKind(baselineMetrics[key]) !== metricKind(currentMetrics[key])),
    ),
  );
  // Timings keep the strict key-set rule; work counters may appear or vanish
  // with the work itself and are compared separately below.
  const baselineTimings = metricsOfKind(baselineMetrics, 'time');
  const currentTimings = metricsOfKind(currentMetrics, 'time');
  const baselineMetricKeys = Object.keys(baselineTimings).sort();
  const currentMetricKeys = Object.keys(currentTimings).sort();
  if (JSON.stringify(baselineMetricKeys) !== JSON.stringify(currentMetricKeys))
    metricMismatch = true;

  for (const [key, baselineMetric] of Object.entries(baselineTimings)) {
    const currentMetric = currentTimings[key];
    if (!currentMetric || baselineMetric.unit !== currentMetric.unit) {
      metricMismatch = true;
      continue;
    }
    const baselineValue = baselineMetric.value;
    const currentValue = currentMetric.value;
    if (!Number.isFinite(baselineValue) || !Number.isFinite(currentValue))
      continue;
    const delta = currentValue - baselineValue;
    const percent =
      baselineValue === 0 ? null : (delta / Math.abs(baselineValue)) * 100;
    const absoluteFloor = Number.isFinite(baselineMetric.minRegressionAbsolute)
      ? baselineMetric.minRegressionAbsolute
      : baselineMetric.unit === 'ms'
        ? minRegressionMs
        : 0;
    const regression =
      delta > absoluteFloor &&
      (percent === null
        ? currentValue > absoluteFloor
        : percent > maxRegressionPercent);
    const entry = {
      key,
      unit: baselineMetric.unit,
      baseline: baselineValue,
      current: currentValue,
      delta,
      percent,
      regression,
    };
    comparisons.push(entry);
    if (regression) regressions.push(entry);
  }
  const work = compareWorkCounters(
    baseline,
    current,
    metricsOfKind(baselineMetrics, 'count'),
    metricsOfKind(currentMetrics, 'count'),
  );
  if (work.mismatch) metricMismatch = true;
  if (metricMismatch) incompatibilities.push('metrics');

  return {
    ...studyMetadata,
    compatible: incompatibilities.length === 0,
    incompatibilities,
    thresholds: { maxRegressionPercent, minRegressionMs },
    comparisons,
    regressions,
    workComparisons: work.comparisons,
    workUnavailable: work.unavailable,
    regressedScenarios: [
      ...new Set(regressions.map((entry) => entry.key.split('.')[0])),
    ],
    passed: incompatibilities.length === 0 && regressions.length === 0,
  };
}

/**
 * One side's comparable samples of a metric in sample order: an entry's
 * `samples` for a repeated artifact, its `value` for a single-sample one.
 * Samples whose scenario launch failed are left out.
 */
function comparableSamples(result, key, entry) {
  const scenarioName = key.split('.')[0];
  const values =
    isRepeatedResult(result) && Array.isArray(entry.samples)
      ? entry.samples
      : [entry.value];
  return values.filter(
    (value, index) =>
      Number.isFinite(value) && sampleIsComparable(result, scenarioName, index),
  );
}

function scenarioSampleStatuses(result, scenarioName) {
  const statuses = {};
  for (const scenario of result.scenarios ?? []) {
    if (scenario.name !== scenarioName) continue;
    statuses[scenario.status] = (statuses[scenario.status] ?? 0) + 1;
  }
  return statuses;
}

function excludedSampleCount(statuses) {
  return Object.entries(statuses)
    .filter(([status]) => status !== 'ok' && status !== 'unresponsive')
    .reduce((total, [, count]) => total + count, 0);
}

/**
 * The samples of one side whose scenario launch was not `ok`, in artifact
 * order: each one's scenario, sample index and status.
 */
function nonOkSamples(result) {
  return (result.scenarios ?? [])
    .filter((scenario) => scenario.status !== 'ok')
    .map((scenario) => ({
      scenario: scenario.name,
      sample: scenario.sample ?? 0,
      status: scenario.status,
    }));
}

function sampleLoadRange(result) {
  const loads = (result.repeat?.samples ?? [])
    .map((sample) => sample.loadAverage?.[0])
    .filter(Number.isFinite);
  return loads.length === 0
    ? null
    : { min: Math.min(...loads), max: Math.max(...loads) };
}

function scenarioOrder(baseline, candidate) {
  return [
    ...new Set(
      [...(baseline.scenarios ?? []), ...(candidate.scenarios ?? [])].map(
        ({ name }) => name,
      ),
    ),
  ];
}

/**
 * The noise-aware three-way comparison of repeated timing samples (R4); see
 * `verdicts.mjs` for the method. Each scenario is `improved`, `regressed` or
 * `inconclusive`, and so is the comparison: `regressed` if any scenario
 * regressed, `improved` if any improved and none regressed. Work counters keep
 * the exact-count report of the single-sample comparison, over each side's
 * median, and never decide a verdict. The p95 and max of the samples are
 * reported for diagnosis only. The comparison fails, whatever its verdict, when
 * either side has a sample whose launch failed or was unresponsive; the verdict
 * itself leaves failed samples out and counts unresponsive ones, and
 * `nonOkSamples` names them. Marked local smoke pairs instead apply the
 * workload, host-evidence, and relative-regression gates after retaining these
 * raw observations. Legacy and release-like comparisons stay strict.
 */
export function compareRepeatedPerformanceResults(
  baseline,
  candidate,
  overrides = {},
) {
  const options = { ...VERDICT_DEFAULTS, ...overrides };
  const incompatibilities = compatibleBaseline(baseline, candidate, {
    repeated: true,
  });
  // The hidden browser-profile study has its own single-run protocol.
  if ([baseline, candidate].some((result) => requiresStudyValidation(result)))
    incompatibilities.push('study');
  const baselineMetrics = normalizeLegacyLongTaskMetrics(
    baseline.metrics ?? {},
  );
  const candidateMetrics = normalizeLegacyLongTaskMetrics(
    candidate.metrics ?? {},
  );
  // A metric that changes kind or unit, or has an unknown kind, cannot be
  // compared. A metric one side lacks is judged inconclusive instead.
  const metricMismatch = [baselineMetrics, candidateMetrics].some((metrics) =>
    Object.entries(metrics).some(([key, entry]) => {
      const other =
        metrics === baselineMetrics
          ? candidateMetrics[key]
          : baselineMetrics[key];
      return (
        !['time', 'count'].includes(metricKind(entry)) ||
        (other !== undefined &&
          (metricKind(other) !== metricKind(entry) ||
            (metricKind(entry) === 'time' && other.unit !== entry.unit)))
      );
    }),
  );
  const baselineTimings = metricsOfKind(baselineMetrics, 'time');
  const candidateTimings = metricsOfKind(candidateMetrics, 'time');
  const work = compareWorkCounters(
    baseline,
    candidate,
    metricsOfKind(baselineMetrics, 'count'),
    metricsOfKind(candidateMetrics, 'count'),
  );
  if (metricMismatch || work.mismatch) incompatibilities.push('metrics');
  const compatible = incompatibilities.length === 0;

  const scenarios = [];
  for (const name of compatible ? scenarioOrder(baseline, candidate) : []) {
    const keys = [
      ...new Set([
        ...Object.keys(baselineTimings),
        ...Object.keys(candidateTimings),
      ]),
    ].filter((key) => key.split('.')[0] === name);
    const inputs = keys.map((key) => {
      const baselineEntry = baselineTimings[key];
      const candidateEntry = candidateTimings[key];
      const template = baselineEntry ?? candidateEntry;
      return {
        key,
        unit: template.unit,
        direction: template.direction,
        minRegressionAbsolute: template.minRegressionAbsolute,
        baseline: baselineEntry
          ? comparableSamples(baseline, key, baselineEntry)
          : null,
        candidate: candidateEntry
          ? comparableSamples(candidate, key, candidateEntry)
          : null,
      };
    });
    const sampleStatuses = {
      baseline: scenarioSampleStatuses(baseline, name),
      candidate: scenarioSampleStatuses(candidate, name),
    };
    const scenario = {
      name,
      ...judgeScenarioMetrics(inputs, options),
      sampleStatuses,
      excludedSamples: {
        baseline: excludedSampleCount(sampleStatuses.baseline),
        candidate: excludedSampleCount(sampleStatuses.candidate),
      },
    };
    scenario.guidance = scenarioRerunGuidance(scenario, options);
    scenarios.push(scenario);
  }
  const withVerdict = (verdict) =>
    scenarios
      .filter((scenario) => scenario.verdict === verdict)
      .map((scenario) => scenario.name);
  const regressedScenarios = withVerdict('regressed');
  const improvedScenarios = withVerdict('improved');
  const result = {
    mode: 'repeated',
    compatible,
    incompatibilities,
    method: {
      test: 'mann-whitney-u',
      correction: 'holm-per-scenario',
      gate: ['p50', 'p75'],
      diagnostic: ['p95', 'max'],
      ...options,
    },
    samples: {
      baseline: baseline.repeat?.count ?? 1,
      candidate: candidate.repeat?.count ?? 1,
    },
    hostLoad: {
      baseline: sampleLoadRange(baseline),
      candidate: sampleLoadRange(candidate),
    },
    headline: geometricMeanHeadline(scenarios),
    scenarios,
    workComparisons: work.comparisons,
    workUnavailable: work.unavailable,
    nonOkSamples: {
      baseline: nonOkSamples(baseline),
      candidate: nonOkSamples(candidate),
    },
    regressedScenarios,
    improvedScenarios,
    inconclusiveScenarios: withVerdict('inconclusive'),
    verdict:
      regressedScenarios.length > 0
        ? 'regressed'
        : improvedScenarios.length > 0
          ? 'improved'
          : 'inconclusive',
    passed:
      compatible &&
      regressedScenarios.length === 0 &&
      nonOkSamples(baseline).length === 0 &&
      nonOkSamples(candidate).length === 0,
  };
  if (usesLocalSmokePolicy(baseline) && usesLocalSmokePolicy(candidate)) {
    result.acceptance = assessSmokeComparison(baseline, candidate, result);
    result.passed = result.acceptance.verdict === 'pass';
    if (result.acceptance.measurement !== 'valid') {
      result.statisticalVerdict = result.verdict;
      result.verdict = 'inconclusive';
    }
  }
  return result;
}
