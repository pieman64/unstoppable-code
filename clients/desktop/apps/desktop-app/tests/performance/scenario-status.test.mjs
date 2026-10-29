import assert from 'node:assert/strict';
import test from 'node:test';
import {
  performanceScenarioStatus,
  shouldRunPerformanceDiagnostics,
} from './scenario-status.mjs';

test('regular scenarios retain responsive and unresponsive statuses', () => {
  assert.equal(performanceScenarioStatus({}, { passed: true }), 'ok');
  assert.equal(
    performanceScenarioStatus({}, { passed: false }),
    'unresponsive',
  );
});

test('diagnostic-only runs still replay responsiveness failures', () => {
  assert.equal(
    shouldRunPerformanceDiagnostics('on-failure', {
      status: 'diagnostic',
      responsiveness: { passed: false },
    }),
    true,
  );
  assert.equal(
    shouldRunPerformanceDiagnostics('on-failure', {
      status: 'diagnostic',
      responsiveness: { passed: true },
    }),
    false,
  );
});

test('diagnostic replay mode overrides remain authoritative', () => {
  const responsive = { status: 'ok', responsiveness: { passed: true } };
  assert.equal(shouldRunPerformanceDiagnostics('always', responsive), true);
  assert.equal(shouldRunPerformanceDiagnostics('off', responsive), false);
});

test('failed scenarios trigger diagnostic replay unless disabled', () => {
  assert.equal(
    shouldRunPerformanceDiagnostics('on-failure', { status: 'error' }),
    true,
  );
  assert.equal(
    shouldRunPerformanceDiagnostics('off', { status: 'error' }),
    false,
  );
});
