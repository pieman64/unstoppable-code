import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  withW5Commit,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { schedulePortalStructuralSync } from '../../portal/portal-structural-sync';
import { getWorkspaceWorktreesFilePath } from '../paths';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  clearWorktreesSelfWriteTracking,
  updateWorkspaceWorktree,
  wasRecentWorktreesSelfWrite,
} from '../workspace-persistence';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: 'wt-1', branchName: 'dev-mole', createdAt },
  ]));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  clearWorktreesSelfWriteTracking('a');
});
afterEach(async () => {
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function rename(branchName: string): Promise<boolean> {
  return updateWorkspaceWorktree('a', 'wt-1', (row) => ({
    ...row,
    branchName,
  }));
}

function listImage(): string {
  return readFileSync(join(root, 'a', 'worktrees.json'), 'utf8');
}

/** Whether the list counts as a self-write while the worker applies it. */
function observeDuringCommit(): () => boolean[] {
  const observed: boolean[] = [];
  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementation((request) => {
    observed.push(wasRecentWorktreesSelfWrite('a'));
    return commit(request);
  });
  return () => observed;
}

it('counts a list write as a self-write while the worker applies it', async () => {
  const observed = observeDuringCommit();
  expect(wasRecentWorktreesSelfWrite('a')).toBe(false);

  await rename('canopy/mock-branch');

  expect(observed()).toEqual([true]);
  expect(wasRecentWorktreesSelfWrite('a')).toBe(true);
  expect(listImage()).toContain('canopy/mock-branch');
});

it('counts a staged list write as a self-write until its scope applies', async () => {
  const observed = observeDuringCommit();
  let whileStaged: boolean | undefined;

  await withW5Commit(
    {
      operation: 'test.self-write',
      locks: [{ kind: 'list', path: getWorkspaceWorktreesFilePath('a') }],
    },
    async () => {
      await rename('canopy/mock-branch');
      whileStaged = wasRecentWorktreesSelfWrite('a');
    },
  );

  expect(whileStaged).toBe(true);
  expect(observed()).toEqual([true]);
  expect(wasRecentWorktreesSelfWrite('a')).toBe(true);
});

it('commits a staged list write once when its post-commit notification fails', async () => {
  const observed = observeDuringCommit();
  jest.mocked(schedulePortalStructuralSync).mockImplementationOnce(() => {
    throw new Error('notification failed');
  });

  await expect(
    withW5Commit(
      {
        operation: 'test.self-write-notification',
        locks: [{ kind: 'list', path: getWorkspaceWorktreesFilePath('a') }],
      },
      () => rename('canopy/mock-branch'),
    ),
  ).rejects.toThrow('notification failed');

  expect(observed()).toEqual([true]);
  expect(listImage()).toContain('canopy/mock-branch');
  expect(wasRecentWorktreesSelfWrite('a')).toBe(true);
});

it('stops counting a staged list write once its scope aborts', async () => {
  const before = listImage();
  const failure = new Error('abort');

  await expect(
    withW5Commit(
      {
        operation: 'test.self-write-abort',
        locks: [{ kind: 'list', path: getWorkspaceWorktreesFilePath('a') }],
      },
      async () => {
        await rename('canopy/mock-branch');
        throw failure;
      },
    ),
  ).rejects.toBe(failure);

  expect(wasRecentWorktreesSelfWrite('a')).toBe(false);
  expect(listImage()).toBe(before);
});

it('stops counting a list write the worker refuses', async () => {
  jest
    .spyOn(host, 'commit')
    .mockRejectedValueOnce(new Error('worker unavailable'));

  await expect(rename('canopy/mock-branch')).rejects.toThrow(
    'worker unavailable',
  );

  expect(wasRecentWorktreesSelfWrite('a')).toBe(false);
});
