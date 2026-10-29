import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readLaunchArtifact } from './compare.mjs';
import { finalizeResult } from './results.mjs';
import { failedPerformanceScenario } from './scenario-failure-diagnostics.mjs';
import { settlePerformanceScenario } from './smoke-acceptance.mjs';

const closeFailure = new Error('process tree is still alive');
const failClose = async () => {
  throw closeFailure;
};

test('cleanup rejection after a measured record fails the scenario but keeps its evidence', async () => {
  const record = await settlePerformanceScenario(
    'loaded-ui',
    async (closeScenario) => {
      try {
        return {
          name: 'loaded-ui',
          status: 'ok',
          tasks: [{ name: 'open', status: 'ok' }],
          monitoring: { valid: true },
        };
      } finally {
        await closeScenario(failClose);
      }
    },
  );
  assert.equal(record.status, 'error');
  assert.deepEqual(record.tasks, [{ name: 'open', status: 'ok' }]);
  assert.deepEqual(record.monitoring, { valid: true });
  assert.match(record.cleanupError, /Failed to close loaded-ui/);
  assert.match(record.cleanupError, /process tree is still alive/);
  assert.match(record.error, /Failed to close loaded-ui/);
});

test('cleanup rejection after an unresponsive record keeps the original reason', async () => {
  const record = await settlePerformanceScenario(
    'loaded-ui',
    async (closeScenario) => {
      try {
        return { status: 'unresponsive', error: 'Renderer paint timed out' };
      } finally {
        await closeScenario(failClose);
      }
    },
  );
  assert.equal(record.status, 'error');
  assert.match(record.error, /Renderer paint timed out/);
  assert.match(record.error, /Failed to close loaded-ui/);
});

test('cleanup rejection does not replace a workload error or its performance details', async () => {
  const workloadError = new Error('workload failed');
  workloadError.performanceDetails = {
    tasks: [{ name: 'open', status: 'error' }],
    monitoring: { valid: true },
  };
  let thrown;
  try {
    await settlePerformanceScenario('loaded-ui', async (closeScenario) => {
      try {
        throw workloadError;
      } finally {
        await closeScenario(failClose);
      }
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, workloadError);
  assert.equal(thrown.cleanupError.cause, closeFailure);
  const published = failedPerformanceScenario('loaded-ui', 10, thrown);
  assert.deepEqual(published.tasks, [{ name: 'open', status: 'error' }]);
  assert.deepEqual(published.monitoring, { valid: true });
  assert.match(published.error, /workload failed/);
  assert.match(published.cleanupError, /Failed to close loaded-ui/);
  assert.match(published.cleanupError, /process tree is still alive/);
});

test('cleanup rejection after a primitive rejection reports both failures', async () => {
  await assert.rejects(
    settlePerformanceScenario('loaded-ui', async (closeScenario) => {
      try {
        throw 'original rejection';
      } finally {
        await closeScenario(failClose);
      }
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], 'original rejection');
      assert.equal(error.errors[1].cause, closeFailure);
      return true;
    },
  );
});

test('successful cleanup leaves the scenario outcome unchanged', async () => {
  const record = { status: 'unresponsive', tasks: [] };
  assert.equal(
    await settlePerformanceScenario('loaded-ui', async (closeScenario) => {
      await closeScenario(async () => undefined);
      return record;
    }),
    record,
  );
  const workloadError = new Error('workload failed');
  await assert.rejects(
    settlePerformanceScenario('loaded-ui', async (closeScenario) => {
      await closeScenario(async () => undefined);
      throw workloadError;
    }),
    (error) => error === workloadError && !('cleanupError' in error),
  );
});

function artifact(start, load = 2) {
  return finalizeResult({
    schemaVersion: 2,
    suite: 'desktop-app-performance',
    profile: 'smoke',
    benchmarkKind: 'e2e-relative',
    acceptancePolicy: 'local-smoke-v1',
    startedAt: '2026-10-09T00:00:00.000Z',
    completedAt: '2026-10-09T00:01:00.000Z',
    requestedScenarios: ['loaded-ui'],
    environment: { hostname: 'test-host' },
    config: {},
    repeat: {
      count: 7,
      interleaved: { order: 'abba', runId: 'same-batch', warmup: 1 },
    },
    scenarios: Array.from({ length: 7 }, (_, sample) => ({
      name: 'loaded-ui',
      status: 'unresponsive',
      sample,
      durationMs: start + sample,
      tasks: [],
      responsiveness: {
        passed: false,
        violations: [
          { metric: 'renderer.frame_delay.max_ms', value: 180, budgetMs: 100 },
        ],
      },
      hostMeasurement: {
        version: 1,
        platform: 'darwin',
        logicalCpuCount: 8,
        intervalMs: 1000,
        errors: [],
        samples: [
          { elapsedMs: 0, loadAverage: [load, load, load] },
          { elapsedMs: 1000, loadAverage: [load, load, load] },
        ],
      },
    })),
  });
}

test('comparison CLI distinguishes accepted, regressed, and inconclusive evidence', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-smoke-policy-'));
  try {
    const baselinePath = path.join(dir, 'baseline.json');
    const candidatePath = path.join(dir, 'candidate.json');
    writeFileSync(baselinePath, JSON.stringify(artifact(500)));
    for (const [candidate, code, verdict] of [
      [artifact(500), 0, 'PASS'],
      [artifact(900), 1, 'FAIL'],
      [artifact(900, 9), 2, 'INCONCLUSIVE'],
    ]) {
      writeFileSync(candidatePath, JSON.stringify(candidate));
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./compare.mjs', import.meta.url)),
          baselinePath,
          candidatePath,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(child.status, code, child.stderr + child.stdout);
      assert.match(
        child.stdout,
        new RegExp(`\\[perf\\] ${verdict}: workload=pass`),
      );
      assert.match(child.stdout, /absolute latency=exceeded/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nonzero child exit cannot be hidden by a completed local smoke artifact', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-smoke-exit-'));
  const output = path.join(dir, 'result.json');
  try {
    assert.throws(
      () =>
        readLaunchArtifact(
          output,
          () => {
            writeFileSync(output, JSON.stringify(artifact(500)));
            return { status: 1 };
          },
          'sample',
        ),
      /exit 1/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
