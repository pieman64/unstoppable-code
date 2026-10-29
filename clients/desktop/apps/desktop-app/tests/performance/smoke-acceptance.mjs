import { assessHostMeasurement } from './host-measurement.mjs';

export const LOCAL_SMOKE_POLICY = 'local-smoke-v1';
const TIMING_VIOLATIONS = new Set([
  'renderer.frame_delay.max_ms',
  'renderer.key_to_paint_confirmation.p95_ms',
  'renderer.key_to_paint_confirmation.max_ms',
  'renderer.long_tasks.max_ms',
  'ipc.outer.max_ms',
]);

export function usesLocalSmokePolicy(result) {
  return (
    result.acceptancePolicy === LOCAL_SMOKE_POLICY &&
    result.profile === 'smoke' &&
    result.benchmarkKind === 'e2e-relative' &&
    !result.environment?.studyWindowMode &&
    !result.environment?.studyViewportPreset
  );
}

// Unknown failures remain hard failures. Only the five known tail-latency
// ceilings move out of the local workload gate; liveness and timeouts do not.
export function smokeWorkloadCompleted(scenario) {
  if (
    !Number.isFinite(scenario.durationMs) ||
    scenario.durationMs < 0 ||
    !Array.isArray(scenario.tasks) ||
    !Array.isArray(scenario.responsiveness?.violations)
  )
    return false;
  if (scenario.error || !['ok', 'unresponsive'].includes(scenario.status))
    return false;
  if (
    scenario.tasks.some(
      (task) =>
        task.status !== 'ok' ||
        (Number.isFinite(task.responsivenessBudgetMs) &&
          task.durationMs > task.responsivenessBudgetMs),
    )
  )
    return false;
  const violations = scenario.responsiveness?.violations;
  if (scenario.responsiveness.passed !== (violations.length === 0))
    return false;
  if (scenario.status === 'unresponsive' && !violations?.length) return false;
  return (violations ?? []).every((entry) =>
    TIMING_VIOLATIONS.has(entry.metric),
  );
}

export function assessSmokeRun(result) {
  const reasons = [];
  const scenarios = result.scenarios ?? [];
  const expected = result.requestedScenarios ?? [];
  const count = result.repeat?.count ?? 1;
  const complete =
    Number.isFinite(Date.parse(result.startedAt)) &&
    Number.isFinite(Date.parse(result.completedAt)) &&
    Date.parse(result.completedAt) >= Date.parse(result.startedAt) &&
    expected.length > 0 &&
    new Set(expected).size === expected.length &&
    Number.isInteger(count) &&
    count > 0 &&
    scenarios.length === expected.length * count &&
    expected.every((name) =>
      Array.from(
        { length: count },
        (_, sample) =>
          scenarios.filter((s) => s.name === name && (s.sample ?? 0) === sample)
            .length === 1,
      ).every(Boolean),
    );
  const workload =
    complete &&
    scenarios.every(smokeWorkloadCompleted) &&
    result.workRatchet?.passed !== false
      ? 'pass'
      : 'fail';
  if (workload === 'fail')
    reasons.push(
      'The workload failed, exceeded a hard liveness limit, or did not produce every requested sample.',
    );
  const hosts = scenarios.map((scenario) => {
    const assessment = assessHostMeasurement(scenario.hostMeasurement);
    if (
      assessment.status === 'valid' &&
      scenario.hostMeasurement.samples.at(-1).elapsedMs < scenario.durationMs
    ) {
      assessment.status = 'unknown';
      assessment.reasons.push(
        'Host load evidence does not cover the complete scenario.',
      );
    }
    return {
      scenario: scenario.name,
      sample: scenario.sample ?? 0,
      ...assessment,
    };
  });
  for (const host of hosts)
    for (const reason of host.reasons)
      reasons.push(`${host.scenario} sample ${host.sample + 1}: ${reason}`);
  const measurement =
    hosts.length && hosts.every((host) => host.status === 'valid')
      ? 'valid'
      : 'inconclusive';
  const absoluteLatency =
    !scenarios.length ||
    scenarios.some((s) => typeof s.responsiveness?.passed !== 'boolean')
      ? 'unknown'
      : scenarios.some((s) => s.responsiveness?.passed === false)
        ? 'exceeded'
        : 'within-limits';
  if (absoluteLatency === 'exceeded')
    reasons.push(
      'Absolute latency limits were exceeded; retained for investigation, not attributed to this change.',
    );
  return {
    policy: LOCAL_SMOKE_POLICY,
    verdict:
      workload === 'fail'
        ? 'fail'
        : measurement === 'inconclusive' || absoluteLatency === 'exceeded'
          ? 'inconclusive'
          : 'pass',
    workload,
    measurement,
    absoluteLatency,
    relativeRegression: 'not-measured',
    // A completed local smoke satisfies the routine check only. It is not
    // performance acceptance, including when its absolute observations pass.
    localCheckPassed: workload === 'pass',
    performanceAccepted: false,
    reasons,
    hosts,
  };
}

export function assessSmokeComparison(baseline, candidate, comparison) {
  const runs = [assessSmokeRun(baseline), assessSmokeRun(candidate)];
  const reasons = runs.flatMap((run, index) =>
    run.reasons.map(
      (reason) => `${index === 0 ? 'baseline' : 'candidate'}: ${reason}`,
    ),
  );
  const workload = runs.every((run) => run.workload === 'pass')
    ? 'pass'
    : 'fail';
  const matched =
    baseline.environment?.hostname &&
    baseline.environment.hostname === candidate.environment?.hostname &&
    baseline.repeat?.interleaved?.runId &&
    baseline.repeat.interleaved.runId ===
      candidate.repeat?.interleaved?.runId &&
    baseline.repeat.count === candidate.repeat.count &&
    [baseline, candidate].every(
      (run) =>
        run.repeat?.interleaved?.order === 'abba' &&
        run.repeat.interleaved.warmup >= 1,
    );
  if (!matched)
    reasons.push(
      'Timing acceptance requires an alternating same-host comparison from the interleaved driver.',
    );
  const measurement =
    matched && runs.every((run) => run.measurement === 'valid')
      ? 'valid'
      : 'inconclusive';
  const uncertain =
    comparison.scenarios.length === 0 ||
    comparison.scenarios.some(
      (scenario) =>
        scenario.metrics.length === 0 ||
        scenario.metrics.some(
          (metric) =>
            metric.suggestive ||
            ![
              'significant',
              'below-effect-floor',
              'not-significant',
              'identical',
            ].includes(metric.reason) ||
            metric.baseline.count < 7 ||
            metric.candidate.count < 7 ||
            metric.baseline.count !== baseline.repeat?.count ||
            metric.candidate.count !== candidate.repeat?.count,
        ),
    );
  if (uncertain)
    reasons.push(
      'Timing evidence is incomplete, underpowered, or has an unresolved shift; collect more matched samples.',
    );
  const relativeRegression =
    measurement !== 'valid'
      ? 'inconclusive'
      : comparison.regressedScenarios.length
        ? 'regressed'
        : uncertain
          ? 'inconclusive'
          : 'no-material-regression';
  const verdict =
    workload === 'fail' ||
    !comparison.compatible ||
    relativeRegression === 'regressed'
      ? 'fail'
      : relativeRegression === 'inconclusive'
        ? 'inconclusive'
        : 'pass';
  return {
    policy: LOCAL_SMOKE_POLICY,
    verdict,
    workload,
    measurement,
    relativeRegression,
    absoluteLatency: runs.some((run) => run.absoluteLatency === 'exceeded')
      ? 'exceeded'
      : 'within-limits',
    relativeRegressionAccepted: verdict === 'pass',
    reasons,
  };
}

export function formatSmokeAcceptance(acceptance) {
  return [
    `[perf] ${acceptance.verdict.toUpperCase()}: workload=${acceptance.workload}; measurement=${acceptance.measurement}; absolute latency=${acceptance.absoluteLatency}; relative regression=${acceptance.relativeRegression}`,
    ...acceptance.reasons.map((reason) => `[perf]   ${reason}`),
    ...(acceptance.localCheckPassed === undefined
      ? []
      : [
          `[perf] Local smoke check: ${acceptance.localCheckPassed ? 'passed' : 'failed'}. Performance acceptance: not established by a standalone smoke run.`,
        ]),
  ];
}

/**
 * Cleanup is part of workload correctness, including on a contended host.
 * `run` closes the app in its `finally` through `closeScenario`, which records
 * the failure instead of throwing, so it cannot replace the pending record or
 * error and discard the evidence attached to it.
 */
export async function settlePerformanceScenario(name, run) {
  let cleanupError;
  const closeScenario = async (close) => {
    try {
      await close();
    } catch (error) {
      cleanupError = new Error(`Failed to close ${name}: ${String(error)}`, {
        cause: error,
      });
    }
  };
  let record;
  try {
    record = await run(closeScenario);
  } catch (error) {
    if (!cleanupError) throw error;
    if (error && typeof error === 'object') {
      error.cleanupError = cleanupError;
      throw error;
    }
    throw new AggregateError(
      [error, cleanupError],
      `${String(error)}; ${cleanupError.message}`,
    );
  }
  if (!cleanupError) return record;
  return {
    ...record,
    status: 'error',
    error: record.error
      ? `${record.error}; ${cleanupError.message}`
      : cleanupError.message,
    cleanupError: cleanupError.message,
  };
}
