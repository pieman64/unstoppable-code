import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCodeGraphReadService } from '@canopy/code-graph/host/read-service';
import { createCodeGraphReadServiceWorker } from '@canopy/code-graph/host/read-worker';
import { createWorkerCodeGraphReadAdapter } from '../worker-code-graph-read-adapter';
import {
  readWorktreeCodeGraph,
  validateWorktreeCodeGraphLanguages,
} from '../../code-graph/graph-reads';
import { installCodeGraphReadDispatcherForTests } from '../../__tests__/helpers/code-graph-read-dispatcher';

/*
 * The Claude orientation and steering hooks run on the tool-use path. Their
 * graph reads cross `worker.codeGraph.*` on the desktop dispatcher, and the
 * hop itself must stay within the hooks' budget: at most 5 ms at p95 per read
 * beside the read host's own time (CAN-4150). The read host is stubbed here,
 * so this measures exactly what the worker interface adds: validation of the
 * request and result, the adapter and the service's resolution.
 */

const BUDGET_P95_MS = 5;
/** The best of a few rounds, so a burst of contention from other suites cannot fail it. */
const ROUNDS = 5;
const SAMPLES = 400;
const WARMUP = 50;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length * 0.95)] ?? Number.POSITIVE_INFINITY;
}

async function measure(read: () => Promise<unknown>): Promise<number> {
  for (let index = 0; index < WARMUP; index += 1) await read();
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    await read();
    samples.push(performance.now() - started);
  }
  return p95(samples);
}

describe('worker.codeGraph reads on the hook path', () => {
  let root: string;
  let uninstall: () => void;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'worker-code-graph-latency-'));
    const service = createCodeGraphReadService({
      scheduler: {
        run: () =>
          Promise.resolve({
            ok: true,
            result: {
              kind: 'fingerprint-metadata',
              value: {
                fingerprint: 'fingerprint',
                schemaVersion: 5,
                extractorVersion: 7,
                completed: true,
                lastBuildAt: '1001',
              },
            },
          }),
      },
      dbPath: () => path.join(root, 'graph.db'),
      hasGraph: () => true,
      buildState: () => 'idle',
      worktreeRoot: () => root,
      repositories: () => Promise.resolve([{ repoId: 'repo', rootPath: root }]),
      resourcesDir: () => root,
      now: () => new Date(0),
    });
    uninstall = installCodeGraphReadDispatcherForTests(
      createWorkerCodeGraphReadAdapter(() =>
        Promise.resolve(createCodeGraphReadServiceWorker(service)),
      ),
    );
  });

  afterAll(() => {
    uninstall();
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the orientation build stamp within the hop budget', async () => {
    const scope = { projectId: 'project', worktreeId: 'worktree' };
    let elapsed = Number.POSITIVE_INFINITY;
    for (let round = 0; round < ROUNDS && elapsed >= BUDGET_P95_MS; round += 1)
      elapsed = Math.min(
        elapsed,
        await measure(() =>
          readWorktreeCodeGraph(scope, 'fingerprint-metadata', {
            kind: 'build-stamp',
          }),
        ),
      );
    expect(elapsed).toBeLessThan(BUDGET_P95_MS);
  });

  it('validates the steering languages within the hop budget', async () => {
    const scope = { projectId: 'project', worktreeId: 'worktree' };
    // No config: the worker answers after one failed lookup, so this measures
    // the hop. Reading a present config is the same file work the hook did
    // before, covered by the adapter and steering suites.
    await expect(validateWorktreeCodeGraphLanguages(scope)).resolves.toEqual({
      config: 'absent',
      languages: [],
      diagnostics: [],
    });
    let elapsed = Number.POSITIVE_INFINITY;
    for (let round = 0; round < ROUNDS && elapsed >= BUDGET_P95_MS; round += 1)
      elapsed = Math.min(
        elapsed,
        await measure(() => validateWorktreeCodeGraphLanguages(scope)),
      );
    expect(elapsed).toBeLessThan(BUDGET_P95_MS);
  });
});
