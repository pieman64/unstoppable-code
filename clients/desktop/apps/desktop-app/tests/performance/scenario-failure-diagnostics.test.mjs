import assert from 'node:assert/strict';
import test from 'node:test';
import { failedPerformanceScenario } from './scenario-failure-diagnostics.mjs';

test('window-identification evidence survives failed-scenario JSON publication', () => {
  const evidence = {
    expectedUrl: 'file:///fixture/renderer/index.html',
    events: [
      { stage: 'window-observed', windowId: 1, order: 1, monotonicNs: '100' },
      { stage: 'selection-rejected', order: 2, monotonicNs: '200' },
    ],
    truncated: false,
  };
  const error = new Error('Timed out identifying the application window.');
  Object.defineProperty(error, 'mainWindowSelection', { value: evidence });
  const result = JSON.parse(
    JSON.stringify(
      failedPerformanceScenario('stress-transcript', 30000, error),
    ),
  );
  assert.deepEqual(result.mainWindowSelection, evidence);
  assert.equal(result.status, 'error');
  assert.match(result.error, /Timed out identifying the application window/);
});

test('failed-scenario publication retains existing workload and monitoring details', () => {
  const error = new Error('workload failed');
  error.performanceDetails = {
    tasks: [{ name: 'open', durationMs: 12 }],
    launch: { runtime: 'e2e' },
    foreground: { requested: true },
    windowEvidence: { identityMatched: true },
    monitoring: { valid: true },
    gitAttribution: { available: true },
    userDataDir: '/fixture/data',
  };
  const result = failedPerformanceScenario('worktrees', 12, error);
  for (const [key, value] of Object.entries(error.performanceDetails)) {
    assert.deepEqual(result[key], value);
  }
  assert.equal(result.durationMs, 12);
  assert.equal(result.error, error.stack);
  assert.equal(Object.hasOwn(result, 'mainWindowSelection'), false);
});

test('failed-scenario publication preserves primitive rejections', () => {
  const result = failedPerformanceScenario(
    'worktrees',
    0,
    'original rejection',
  );
  assert.equal(result.error, 'original rejection');
  assert.deepEqual(result.tasks, []);
  assert.equal(Object.hasOwn(result, 'mainWindowSelection'), false);
});
