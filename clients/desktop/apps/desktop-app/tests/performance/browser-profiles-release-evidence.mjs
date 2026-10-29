/** Pure release fixture/classification rules. Host identity and cleanup remain caller-owned. */
import assert from 'node:assert/strict';
import { assessResponsiveness } from './responsiveness.mjs';

export const RELEASE_TASK_COUNTS = Object.freeze({
  common: {
    workspace_ready: 1,
    cold_task_ready: 1,
    named_switch_ready: 20,
    cold_cowork_command_ready: 1,
    cold_advisor_command_ready: 1,
    shared_20_tabs_ready: 1,
    shared_20_tabs_closed: 1,
  },
  maintenance: {
    workspace_ready: 1,
    cold_task_ready: 1,
    inventory_cancel_acknowledged: 1,
    inventory_1gib_10000_files: 1,
    shared_20_cache_clear: 1,
    shared_20_site_clear: 1,
    shared_20_reset: 1,
    owner_retirement_acknowledged: 100,
    retirement_cleanup_retry_acknowledged: 1,
  },
  startup: { type_startup_composer: 1 },
  cold: {
    cold_cowork_add_browser_click_to_account_ready: 1,
    cold_advisor_add_browser_click_to_account_ready: 1,
  },
  veto: {
    switch_click_to_beforeunload_prompt: 1,
    source_veto_click_to_original_account_ready: 1,
  },
  inventory: {
    inventory_navigation_ready_while_running: 1,
    type_inventory_while_running: 1,
    inventory_request_to_complete: 1,
  },
  retirement: {
    owner_retirement_durable_acknowledgement: 100,
    restart_invocation_to_physical_task_purge: 1,
  },
});
const finite = (value, label) =>
  assert(Number.isFinite(value) && value >= 0, `Missing/invalid ${label}`);
export function validateReleaseStructure(mode, sample) {
  assert(
    ['ok', 'unresponsive'].includes(sample?.status),
    'Incomplete/error workload',
  );
  assert(!sample.error && !sample.cleanupError, 'Unexplained workload error');
  const expected = RELEASE_TASK_COUNTS[mode];
  assert(expected, 'Unknown workload');
  const counts = {};
  for (const task of sample.tasks ?? []) {
    assert.equal(task.status, 'ok', `Failed task ${task.kind}`);
    finite(task.durationMs, `task ${task.kind}`);
    counts[task.kind] = (counts[task.kind] ?? 0) + 1;
  }
  assert.deepEqual(
    counts,
    expected,
    'Missing/duplicate/unexpected workload task counts',
  );
  const workloads = Array.isArray(sample.monitoring)
    ? sample.monitoring.filter((x) => x.scope !== 'setup')
    : [sample.monitoring];
  assert(workloads.length, 'Missing workload monitor');
  for (const monitor of [
    ...workloads,
    ...(['common', 'maintenance', 'startup'].includes(mode)
      ? [sample.settled]
      : []),
  ]) {
    for (const field of [
      'ipcOuterMs',
      'rendererFrameDelayMs',
      'totalWorkingSetMb',
      'totalCpuPercent',
    ]) {
      assert(monitor?.summary?.[field]?.count > 0, `Missing ${field} samples`);
      finite(monitor.summary[field].max, field);
    }
    assert(
      monitor?.raw?.renderer?.longTaskObserverAvailable === true,
      'Long-task observer coverage unavailable',
    );
    assert(
      monitor.raw.renderer.frames?.length > 0,
      'Individual frame evidence unavailable',
    );
  }
  if (['common', 'maintenance', 'startup'].includes(mode))
    for (const field of ['mean', 'p95'])
      finite(
        sample.settled.summary.totalCpuPercent[field],
        `settled CPU ${field}`,
      );
  const typing = { common: 40, maintenance: 27, startup: 48, inventory: 11 }[
    mode
  ];
  if (typing)
    assert.equal(
      workloads.reduce(
        (sum, x) =>
          sum + (x.summary.rendererKeyToPaintConfirmationMs?.count ?? 0),
        0,
      ),
      typing,
      'Required typing count',
    );
  if (mode === 'common') {
    finite(sample.firstWindowMs, 'firstWindowMs');
    finite(sample.shellMs, 'shellMs');
  }
  if (mode === 'startup') {
    assert(
      sample.earlyCoverage?.preWindowSampleCount >= 2,
      'Missing pre-window coverage',
    );
    finite(sample.earlyCoverage.preWindowPeakRssKb, 'pre-window RSS KiB');
    finite(
      sample.earlyCoverage.preWindowObservedCumulativeCpuMs,
      'pre-window observed cumulative CPU ms',
    );
    for (const field of ['firstWindowMs', 'usableShellMs', 'usableComposerMs'])
      finite(sample.milestones?.[field], field);
    for (const observation of sample.startupResources?.samples ?? []) {
      finite(observation.rssKb, 'sampled process-tree RSS KiB');
      finite(
        observation.collectionCompletedMs,
        'resource collection completion',
      );
    }
    assert(
      sample.startupResources?.samples?.some(
        (x) => x.collectionCompletedMs <= sample.milestones.usableShellMs,
      ),
      'Missing PID-to-shell resources',
    );
  }
  if (mode === 'inventory') {
    assert.equal(sample.inventory?.intermediateProgressStatus, 'observed');
    const worker = sample.inventory.workerResources;
    assert(
      worker.observedWorkloadSamples >= 2,
      'Missing inventory worker observations',
    );
    for (const field of ['cpuPercent', 'workingSetSizeKb']) {
      assert(worker[field]?.count >= 2, `Missing worker ${field}`);
      finite(worker[field].max, `worker ${field}`);
    }
    finite(worker.cpuPercent.mean, 'worker CPU mean');
    finite(worker.cpuPercent.p95, 'worker CPU p95');
    assert.equal(sample.inventory.result?.coverage, 'partial');
  }
  if (mode === 'retirement') {
    assert.equal(sample.retirement?.acknowledgements?.length, 100);
    assert.equal(sample.retirement?.paths?.length, 50);
    assert.equal(
      sample.retirement.passiveCleanupEvidence?.status,
      'physical-purge-complete',
    );
    assert.equal(sample.retirement.passiveCleanupEvidence.remainingCount, 0);
  }
  return sample;
}

export function validateReleaseSample(mode, sample) {
  assert.equal(sample?.status, 'ok', 'Failed workload remains diagnostic');
  return validateReleaseStructure(mode, sample);
}

function distribution(summary, name, required = false) {
  const value = summary?.[name];
  assert(
    value && Number.isInteger(value.count) && value.count >= 0,
    `Missing/invalid ${name} count`,
  );
  assert(!required || value.count > 0, `Missing ${name} coverage`);
  for (const field of name === 'rendererKeyToPaintConfirmationMs'
    ? ['p95', 'max']
    : ['max']) {
    if (value.count === 0)
      assert.equal(value[field], null, `Empty ${name}.${field} must stay null`);
    else finite(value[field], `${name}.${field}`);
  }
}

function assessMonitor(monitor, thresholds, scope) {
  const summary = monitor?.summary;
  assert(
    !monitor.error && !summary?.rendererCollectionError,
    `${scope}: invalid monitoring`,
  );
  for (const name of [
    'ipcOuterMs',
    'rendererFrameDelayMs',
    'totalWorkingSetMb',
    'totalCpuPercent',
  ])
    distribution(summary, name, true);
  for (const name of ['longTasks', 'rendererKeyToPaintConfirmationMs'])
    distribution(summary, name);
  const ipcSamples = monitor.raw?.ipcSamples;
  assert(Array.isArray(ipcSamples), `${scope}: missing raw IPC coverage`);
  for (const entry of ipcSamples)
    finite(entry?.outerMs, `${scope}: raw IPC outerMs`);
  assert.equal(
    ipcSamples.length,
    summary.ipcOuterMs.count,
    `${scope}: IPC outer count mismatch`,
  );
  for (const [field, rawField] of [
    ['ipcErrorCount', 'error'],
    ['ipcTimeoutCount', 'timeout'],
  ]) {
    assert(
      Number.isInteger(summary[field]) && summary[field] >= 0,
      `${scope}: invalid ${field}`,
    );
    assert.equal(
      summary[field],
      ipcSamples.filter((entry) => entry[rawField]).length,
      `${scope}: ${field} disagrees with raw IPC observations`,
    );
  }
  assert(
    Array.isArray(monitor.raw.renderer.longTasks),
    `${scope}: missing raw Long Task observations`,
  );
  assert.equal(
    monitor.raw.renderer.longTasks.length,
    summary.longTasks.count,
    `${scope}: Long Task coverage mismatch`,
  );
  for (const entry of monitor.raw.renderer.longTasks)
    finite(entry.duration, `${scope}: Long Task duration`);
  const rawFrames = monitor.raw.renderer.frameGapsMs;
  assert(
    Array.isArray(rawFrames) &&
      rawFrames.length === summary.rendererFrameDelayMs.count,
    `${scope}: frame coverage mismatch`,
  );
  for (const value of rawFrames) finite(value, `${scope}: raw frame gap`);
  const typing = monitor.raw.renderer.keyToPaintConfirmationMs;
  assert(
    Array.isArray(typing) &&
      typing.length === summary.rendererKeyToPaintConfirmationMs.count,
    `${scope}: typing coverage mismatch`,
  );
  for (const value of typing) finite(value, `${scope}: raw typing`);
  return assessResponsiveness(summary, thresholds);
}

/** Classifies only complete raw schema-2 reports; throws on all structural invalidity.
 * The caller must still attest source/runtime/configuration/native archives and safe
 * owned cleanup before publishing structuralStatus=valid or launching again.
 */
export function classifyReleaseReport(mode, raw, code, thresholds) {
  assert.equal(raw?.schemaVersion, 2, 'Raw release schema mismatch');
  assert.equal(raw.configuration?.samples, 1);
  assert.equal(raw.configuration?.warmups, 0);
  assert.equal(raw.samples?.length, 1);
  assert.equal(raw.warmup, null);
  assert(code === 0 || code === 1, 'Unexplained command exit');
  const sample = validateReleaseStructure(mode, raw.samples[0]);
  assert(
    !sample.teardownError &&
      !sample.samplerError &&
      !sample.partialMonitoring &&
      !raw.error,
    'Unexplained workload error',
  );
  if (!['common', 'maintenance', 'startup'].includes(mode))
    assert.equal(raw.mode, mode, 'Raw mode mismatch');
  const workloads = Array.isArray(sample.monitoring)
    ? sample.monitoring.filter((entry) => entry.scope !== 'setup')
    : [sample.monitoring];
  if (mode === 'cold') {
    assert.deepEqual(
      sample.cold?.map(({ record }) => record?.owner?.taskScope?.kind),
      ['cowork_work_entry', 'app_advisor_work_entry'],
      'Cold owner fixture incomplete',
    );
    assert.equal(
      workloads.length,
      2,
      'Cold requires main and Advisor monitoring',
    );
  }
  const assessed = workloads.map((monitor, index) => ({
    scope: `workload[${index}]`,
    label: monitor.label ?? null,
    assessment: assessMonitor(monitor, thresholds, `workload[${index}]`),
    recorded: Array.isArray(sample.monitoring)
      ? monitor.responsiveness
      : sample.responsiveness,
    driverScored: true,
  }));
  if (sample.settled)
    assessed.push({
      scope: 'settled',
      label: null,
      assessment: assessMonitor(sample.settled, thresholds, 'settled'),
      recorded: mode === 'startup' ? sample.settledResponsiveness : null,
      driverScored: mode === 'startup',
    });
  for (const entry of assessed.filter((entry) => entry.driverScored))
    assert.deepEqual(
      entry.recorded,
      entry.assessment,
      `${entry.scope}: recorded assessment contradicts canonical scope`,
    );
  const rawPassed = assessed
    .filter((entry) => entry.driverScored)
    .every((entry) => entry.assessment.passed);
  assert.equal(
    sample.status,
    rawPassed ? 'ok' : 'unresponsive',
    'Raw status contradicts canonical driver assessment',
  );
  assert.equal(
    raw.summary?.passed,
    rawPassed,
    'Raw summary contradicts canonical driver assessment',
  );
  assert.equal(
    code,
    rawPassed ? 0 : 1,
    'Command exit contradicts canonical driver assessment',
  );
  const violations = assessed.flatMap(
    ({ scope, label, driverScored, assessment }) =>
      assessment.violations.map((violation) => ({
        scope,
        label,
        driverScored,
        ...violation,
      })),
  );
  const passed = violations.length === 0;
  return {
    structuralStatus: 'valid',
    performanceStatus: passed ? 'passed' : 'failed',
    status: passed ? 'ok' : 'failed',
    failureClass: passed ? null : 'performance',
    passed,
    violations,
    recordedAssessments: assessed.map(({ scope, recorded, driverScored }) => ({
      scope,
      driverScored,
      assessment: recorded,
    })),
    raw: { status: sample.status, passed: raw.summary.passed, exitCode: code },
  };
}
