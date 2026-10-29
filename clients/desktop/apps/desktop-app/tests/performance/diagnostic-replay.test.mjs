import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diagnosticReplayError,
  diagnosticReplayOutcome,
  failedDiagnosticReplay,
} from './diagnostic-replay.mjs';

test('failed diagnostic replays retain captured profiler artifacts', () => {
  const failure = new Error('routing assertion failed');
  failure.performanceDetails = {
    diagnostics: {
      status: 'ok',
      artifacts: { report: '/tmp/triage.md', trace: '/tmp/trace.json' },
    },
  };

  assert.deepEqual(failedDiagnosticReplay(failure), {
    status: 'ok',
    artifacts: { report: '/tmp/triage.md', trace: '/tmp/trace.json' },
    replay: {
      status: 'error',
      error: failure.stack,
    },
  });
});

test('failed diagnostic replays report failures before capture starts', () => {
  assert.deepEqual(failedDiagnosticReplay('setup failed'), {
    status: 'not-started',
    replay: { status: 'error', error: 'setup failed' },
  });
});

test('diagnostic replay errors surface retained replay failures', () => {
  const diagnostics = failedDiagnosticReplay(
    Object.assign(new Error('replay failed'), {
      performanceDetails: {
        diagnostics: {
          status: 'ok',
          artifacts: { report: '/tmp/triage.md' },
        },
      },
    }),
  );

  assert.match(diagnosticReplayError(diagnostics), /replay failed/);
  assert.equal(diagnosticReplayError({ status: 'ok' }), undefined);
});

test('replay admission failure before capture retains attempted outcome and all available failure evidence', () => {
  const foreground = {
    admission: { status: 'failed', observations: [{ focused: false }] },
  };
  const failure = Object.assign(new Error('foreground admission timed out'), {
    performanceDetails: {
      foreground,
      tasks: [],
      monitoring: { raw: { renderer: null } },
    },
  });
  const result = failedDiagnosticReplay(failure);
  assert.equal(result.status, 'not-started');
  assert.equal(result.replay.status, 'error');
  assert.match(result.replay.error, /foreground admission timed out/);
  assert.deepEqual(result.replay.foreground, foreground);
  assert.deepEqual(result.replay.tasks, []);
  assert.deepEqual(
    result.replay.monitoring,
    failure.performanceDetails.monitoring,
  );
});
test('replay action failure after capture retains capture outcome independently of failed scenario evidence', () => {
  const details = {
    diagnostics: { status: 'ok', artifacts: { report: '/tmp/triage.md' } },
    foreground: { admission: { status: 'admitted' } },
    tasks: [{ kind: 'workspace', status: 'error' }],
    monitoring: { raw: { renderer: { frames: [{ timestampMs: 4 }] } } },
    launch: { firstWindowMs: 1 },
  };
  const failure = Object.assign(new Error('action failed'), {
    performanceDetails: details,
  });
  const result = failedDiagnosticReplay(failure);
  assert.equal(result.status, 'ok');
  assert.equal(result.replay.status, 'error');
  assert.match(result.replay.error, /action failed/);
  for (const key of ['foreground', 'tasks', 'monitoring', 'launch'])
    assert.deepEqual(result.replay[key], details[key]);
});
test('returned unresponsive replay retains error, tasks, monitoring and admission alongside captured artifacts', () => {
  const replay = {
    status: 'unresponsive',
    error: 'renderer paint timed out',
    durationMs: 20,
    tasks: [{ status: 'unresponsive' }],
    monitoring: { raw: { renderer: { frames: [{ timestampMs: 10 }] } } },
    foreground: { admission: { status: 'admitted' } },
    responsiveness: { passed: false, violations: [{ metric: 'frame' }] },
    diagnostics: { status: 'ok', artifacts: { trace: '/tmp/trace.json' } },
  };
  const result = diagnosticReplayOutcome(replay);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.artifacts, replay.diagnostics.artifacts);
  assert.equal(result.replay.error, 'renderer paint timed out');
  for (const key of [
    'status',
    'durationMs',
    'tasks',
    'monitoring',
    'foreground',
    'responsiveness',
  ])
    assert.deepEqual(result.replay[key], replay[key]);
  assert.equal(result.replay.diagnostics, undefined);
});
