import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProbeArgs } from './runner-lib.mjs';
import { collectExecutionFailures } from './app/qualification.mjs';

test('out-dir accepts only the artifact root and descendants', () => {
  for (const value of [
    '.playwright/can-1570-spikes',
    '.playwright/can-1570-spikes/cost',
    '.playwright/can-1570-spikes/nested/run',
  ]) {
    assert.equal(parseProbeArgs([`--out-dir=${value}`]).outDir, value);
  }
});

test('out-dir rejects traversal, backslashes, absolute paths, and other roots', () => {
  for (const value of [
    '.playwright/can-1570-spikes/../outside',
    '.playwright/can-1570-spikes/..',
    '.playwright/can-1570-spikes/../../outside',
    '.playwright/can-1570-spikes/..\\..\\..\\outside',
    '.playwright/can-1570-spikes\\outside',
    '/.playwright/can-1570-spikes',
    'C:\\.playwright\\can-1570-spikes',
    '.playwright/outside',
    '.playwright/can-1570-spikes-other',
  ]) {
    assert.throws(() => parseProbeArgs([`--out-dir=${value}`]), value);
  }
});

function cleanSpikes() {
  return {
    S1: {
      status: 'recorded',
      scenarios: {
        control: {
          findings: [],
          operations: {
            wheel: {
              commandResults: [
                { status: 'error', error: 'CDP wheel timed out as observed' },
              ],
            },
          },
        },
      },
    },
    S2: { status: 'recorded', findings: {}, errors: [] },
    S3: { status: 'recorded', findings: {}, errors: [] },
    S5: {
      status: 'recorded',
      strategies: {
        contextBridge: { setupErrors: ['frame readiness timed out'] },
      },
    },
  };
}

test('qualification preserves recorded protocol observations', () => {
  assert.deepEqual(collectExecutionFailures(cleanSpikes()), []);
});

test('qualification detects an S1 case crash', () => {
  const spikes = cleanSpikes();
  spikes.S1.scenarios.control.findings.push({
    kind: 'case-error',
    error: 'harness timeout',
  });
  assert.deepEqual(collectExecutionFailures(spikes), [
    {
      path: 'S1.scenarios.control.findings[0]',
      detail: 'harness timeout',
    },
  ]);
});

test('qualification detects an S2 finding error', () => {
  const spikes = cleanSpikes();
  spikes.S2.findings.x = { status: 'error', error: 'setup failed' };
  assert.deepEqual(collectExecutionFailures(spikes), [
    { path: 'S2.findings.x', detail: 'setup failed' },
  ]);
});

test('qualification detects an S3 errors array', () => {
  const spikes = cleanSpikes();
  spikes.S3.errors.push('fixture failed');
  assert.deepEqual(collectExecutionFailures(spikes), [
    { path: 'S3.errors', detail: 'fixture failed' },
  ]);
});

test('qualification detects sample errors and missing OOPIF attachment', () => {
  const spikes = cleanSpikes();
  spikes.S2.oopifAttach = {
    status: 'not-observed',
    error: 'target never attached',
  };
  spikes.S2.cost = { sampleErrors: [{ error: 'sample failed' }] };
  assert.deepEqual(collectExecutionFailures(spikes), [
    { path: 'S2.oopifAttach', detail: 'target never attached' },
    { path: 'S2.cost.sampleErrors', detail: 'sample failed' },
  ]);
});

test('qualification ignores raw evidence and bounds failure summaries', () => {
  const spikes = {
    S1: {
      rawCommands: [{ kind: 'case-error', error: 'observation' }],
      evidence: { errors: ['observation'] },
      findings: Array.from({ length: 60 }, () => ({
        kind: 'case-error',
        error: 'x'.repeat(400),
      })),
    },
  };
  const failures = collectExecutionFailures(spikes);
  assert.equal(failures.length, 50);
  assert.equal(failures[0].path, 'S1.findings[0]');
  assert.equal(failures[0].detail.length, 300);
});
