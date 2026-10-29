import assert from 'node:assert/strict';
import test from 'node:test';
import { assessResponsiveness } from './responsiveness.mjs';

const thresholds = {
  rendererFrameDelayMaxMs: 100,
  rendererKeyToPaintConfirmationP95Ms: 100,
  rendererKeyToPaintConfirmationMaxMs: 250,
  rendererLongTaskMaxMs: 100,
  ipcOuterMaxMs: 250,
};

test('responsiveness assessment passes samples inside the ceilings', () => {
  const assessment = assessResponsiveness(
    {
      rendererFrameDelayMs: { max: 50 },
      rendererKeyToPaintConfirmationMs: { p95: 30, max: 80 },
      longTasks: { max: 60 },
      ipcOuterMs: { max: 90 },
    },
    thresholds,
  );
  assert.equal(assessment.passed, true);
  assert.deepEqual(assessment.violations, []);
});

test('responsiveness assessment tolerates sub-resolution frame arithmetic only', () => {
  const summary = {
    rendererFrameDelayMs: { max: 100.03333333333332 },
    rendererKeyToPaintConfirmationMs: { p95: 30, max: 80 },
    longTasks: { max: 60 },
    ipcOuterMs: { max: 90 },
  };
  assert.equal(assessResponsiveness(summary, thresholds).passed, true);

  summary.rendererFrameDelayMs.max = 100.1;
  const overBudget = assessResponsiveness(summary, thresholds);
  assert.equal(overBudget.passed, false);
  assert.equal(overBudget.violations[0].metric, 'renderer.frame_delay.max_ms');
});

test('responsiveness assessment reports each severe tail stall', () => {
  const assessment = assessResponsiveness(
    {
      rendererFrameDelayMs: { max: 180 },
      rendererKeyToPaintConfirmationMs: { p95: 120, max: 300 },
      longTasks: { max: 160 },
      ipcOuterMs: { max: 275 },
    },
    thresholds,
  );
  assert.equal(assessment.passed, false);
  assert.equal(assessment.violations.length, 5);
});

test('responsiveness assessment fails rejected IPC probes', () => {
  const assessment = assessResponsiveness(
    {
      rendererFrameDelayMs: { max: 50 },
      rendererKeyToPaintConfirmationMs: { p95: 30, max: 80 },
      longTasks: { max: 60 },
      ipcOuterMs: { max: 90 },
      ipcErrorCount: 1,
    },
    thresholds,
  );
  assert.equal(assessment.passed, false);
  assert.equal(assessment.violations[0].metric, 'ipc.error_count');
  assert.equal(assessment.violations[0].budgetMs, 0);
  assert.equal(assessment.violations[0].unit, 'count');
});

test('responsiveness assessment includes completed task budget overruns', () => {
  const assessment = assessResponsiveness(
    {
      rendererFrameDelayMs: { max: 50 },
      rendererKeyToPaintConfirmationMs: { p95: 30, max: 80 },
      longTasks: { max: 60 },
      ipcOuterMs: { max: 90 },
    },
    thresholds,
    [
      {
        kind: 'active-load-typing',
        durationMs: 5_001,
        responsivenessBudgetMs: 5_000,
      },
    ],
  );
  assert.equal(assessment.passed, false);
  assert.equal(
    assessment.violations[0].metric,
    'task.active-load-typing.duration_ms',
  );
});
