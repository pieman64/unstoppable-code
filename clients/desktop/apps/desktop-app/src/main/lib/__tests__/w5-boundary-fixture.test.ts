import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintW5File } from '@canopy/desktop-shared/node/w5-commit-log';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';

jest.setTimeout(60_000);
let dir: string;
let dbPath: string;
let host: W5CommitLogHost;

beforeEach(() => {
  const fixture = createW5BoundaryFixture();
  dir = fixture.dir;
  dbPath = join(dir, 'w5', 'commit-log.sqlite');
  host = new W5CommitLogHost({
    dbPath,
    root: fixture.root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await shutdownW5BoundaryHost(host, dbPath);
  rmSync(dir, { recursive: true, force: true });
});

it('can dispose a fixture whose lazy worker never started', async () => {
  await shutdownW5BoundaryHost(host, dbPath);
  expect(host.workersStarted).toBe(0);
  expect(host.runningWorkerCount).toBe(0);
});

it('waits for actual worker exit even when bounded host shutdown has returned', async () => {
  await host.recoveryReport();
  expect(host.runningWorkerCount).toBe(1);
  const shutdown = host.shutdown.bind(host);
  // Model the documented early return without waiting for a loaded runner.
  jest.spyOn(host, 'shutdown').mockResolvedValue(undefined);
  const finished = jest.fn();
  const closing = shutdownW5BoundaryHost(host, dbPath).then(finished);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).not.toHaveBeenCalled();
    expect(host.runningWorkerCount).toBe(1);
  } finally {
    await shutdown();
    await closing;
  }
  expect(finished).toHaveBeenCalledTimes(1);
  expect(host.runningWorkerCount).toBe(0);
});

it('does not wait for a live worker using another fixture log', async () => {
  const other = createW5BoundaryFixture();
  const otherDbPath = join(other.dir, 'w5', 'commit-log.sqlite');
  const otherHost = new W5CommitLogHost({
    dbPath: otherDbPath,
    root: other.root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  let closing: Promise<void> | undefined;
  try {
    await otherHost.recoveryReport();
    const finished = jest.fn();
    closing = shutdownW5BoundaryHost(host, dbPath).then(finished);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // No target worker was started, so only unrelated-log waiting can block.
    expect(finished).toHaveBeenCalledTimes(1);
    expect(host.workersStarted).toBe(0);
    expect(host.runningWorkerCount).toBe(0);
    expect(otherHost.runningWorkerCount).toBe(1);
    await expect(otherHost.recoveryReport()).resolves.toMatchObject({
      recoveryRequired: [],
    });
  } finally {
    await shutdownW5BoundaryHost(otherHost, otherDbPath);
    await closing;
    rmSync(other.dir, { recursive: true, force: true });
  }
});

it('preserves committed revisions and replay when reopening after writer exit', async () => {
  const indexPath = join(dir, 'data', 'workspaces', 'index.json');
  const contents = readFileSync(indexPath, 'utf8');
  const request = {
    operation: 'internal.repository.write',
    advance: [{ kind: 'workspaces' } as const],
    files: [
      {
        path: indexPath,
        contents,
        previousFingerprint: fingerprintW5File(contents),
      },
    ],
    receipt: {
      caller: 'fixture-test',
      operation: 'internal.repository.write',
      idempotencyKey: 'restart',
      fingerprint: 'restart-request',
    },
    outcome: { committed: true },
  };
  const committed = await host.commit(request);
  expect(committed).toMatchObject({
    status: 'applied',
    revisions: { workspaces: 1 },
  });
  const before = await host.recoveryReport();
  await shutdownW5BoundaryHost(host, dbPath);
  expect(host.runningWorkerCount).toBe(0);
  host = new W5CommitLogHost({
    dbPath,
    root: join(dir, 'data', 'workspaces'),
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  expect(await host.recoveryReport()).toEqual(before);
  await expect(host.commit(request)).resolves.toMatchObject({
    status: 'replayed',
    commitId: committed.commitId,
    outcome: { committed: true },
  });
  await expect(host.revision({ kind: 'workspaces' })).resolves.toBe(1);
  expect(readFileSync(indexPath, 'utf8')).toBe(contents);
  expect(host.workersStarted).toBe(1);
});
