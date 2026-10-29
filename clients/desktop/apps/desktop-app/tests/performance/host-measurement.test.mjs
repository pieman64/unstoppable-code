import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessHostMeasurement,
  startHostMeasurement,
} from './host-measurement.mjs';

function record(load = 2) {
  return {
    version: 1,
    platform: 'darwin',
    logicalCpuCount: 8,
    intervalMs: 1000,
    errors: [],
    samples: [
      { elapsedMs: 0, loadAverage: [load, load, load] },
      { elapsedMs: 1000, loadAverage: [load, load, load] },
    ],
  };
}

test('host admission uses per-CPU load and preserves the saturation boundary', () => {
  assert.equal(assessHostMeasurement(record(7.99)).status, 'valid');
  assert.equal(assessHostMeasurement(record(8)).status, 'contended');
  assert.equal(
    assessHostMeasurement({ ...record(8), logicalCpuCount: 16 }).status,
    'valid',
  );
  const midRun = record();
  midRun.samples.splice(1, 0, { elapsedMs: 500, loadAverage: [12, 2, 2] });
  assert.equal(assessHostMeasurement(midRun).status, 'contended');
});

test('missing, unsupported, malformed, and delayed host evidence is unknown', () => {
  for (const change of [
    (r) => {
      r.platform = 'win32';
    },
    (r) => {
      r.logicalCpuCount = 0;
    },
    (r) => {
      r.samples = [];
    },
    (r) => {
      r.samples[1] = null;
    },
    (r) => {
      r.samples[1].elapsedMs = 5001;
    },
    (r) => {
      r.samples[1].elapsedMs = -1;
    },
    (r) => {
      r.samples[1].loadAverage[0] = NaN;
    },
    (r) => {
      r.errors.push('probe failed');
    },
  ]) {
    const value = record();
    change(value);
    assert.equal(assessHostMeasurement(value).status, 'unknown');
  }
  assert.equal(assessHostMeasurement().status, 'unknown');
});

test('collector samples before, during and after the workload and stops its timer', () => {
  let time = 0;
  let tick;
  let cancelled;
  const timer = { unref() {} };
  const sampler = startHostMeasurement({
    platform: 'darwin',
    logicalCpuCount: 8,
    now: () => time,
    readLoad: () => [time / 1000, 1, 1],
    schedule: (callback, interval) => {
      tick = callback;
      assert.equal(interval, 1000);
      return timer;
    },
    cancel: (value) => {
      cancelled = value;
    },
  });
  time = 1000;
  tick();
  time = 1250;
  const captured = sampler.stop();
  assert.equal(cancelled, timer);
  assert.deepEqual(
    captured.samples.map((s) => s.elapsedMs),
    [0, 1000, 1250],
  );
  assert.deepEqual(
    captured.samples.map((s) => s.loadAverage[0]),
    [0, 1, 1.25],
  );
});

test('probe errors produce retained unknown evidence instead of escaping', () => {
  const sampler = startHostMeasurement({
    readLoad() {
      throw new Error('probe failed');
    },
  });
  const captured = sampler.stop();
  assert.equal(captured.errors.length, 2);
  assert.equal(assessHostMeasurement(captured).status, 'unknown');
});
