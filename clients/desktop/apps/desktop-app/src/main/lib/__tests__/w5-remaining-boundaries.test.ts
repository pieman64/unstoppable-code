import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import * as git from '../git';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
import { existsSync } from 'node:fs';
import { archiveWorktree, deleteWorktree } from '../worktree-archive';
import { deleteWorkspace } from '../workspace-deletion';
import { reserveWorkspaceTargetRuntimeStart } from '../workspace-target-exclusion';
jest.mock('../auto-archive-teardown', () => ({
  runAutoArchiveTeardown: jest.fn(() => Promise.resolve()),
}));
import {
  LiveDelegationsError,
  setDelegationActivity,
} from '../../agents/delegation/activity';
import {
  SplitLockError,
  acquireSplitDestinationWorktreeClaim,
  releaseSplitDestinationWorktreeClaim,
} from '../../services/split-lock-service';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() => Promise.resolve('retirement')),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalScope: jest.fn(() => Promise.resolve()),
    commitLocalScopeCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalScopeFence: jest.fn(() => Promise.resolve()),
    cancelLocalWorkspace: jest.fn(() => Promise.resolve()),
    commitLocalWorkspaceCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalWorkspaceFence: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorkspaceDocs: jest.fn(() => Promise.resolve()),
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
}));
// Same real worker/filesystem harness as part 4, with production command callers.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
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
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5RevisionConflictError,
} from '../w5-commit-log-file-store';
import { ownsW5RepositoryLock } from '../w5-repository-locks';
import { nodeW5FileStore } from '../w5-file-store';
import { reorderWorkspaces } from '../workspace-metadata';
import { updateWorktree, moveWorktree } from '../worktree-update';
import { renameWorktreeBranch } from '../worktree-branch-rename';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  readWorkspaceWorktrees,
  markWorkspaceWorktreeRecentlyRemoved,
  setBeforeProjectPluginDefaultsChangeHandler,
} from '../workspace-persistence';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
const originalWatcherFactory = jest
  .mocked(getAppAdvisorWatcherService)
  .getMockImplementation();

beforeEach(() => {
  if (!originalWatcherFactory)
    throw new Error('Watcher fixture factory missing');
  jest
    .mocked(getAppAdvisorWatcherService)
    .mockImplementation(originalWatcherFactory);
  ({ dir, root, repo } = createW5BoundaryFixture(
    (createdAt) => [
      { id: 'one', branchName: 'old', createdAt },
      { id: 'two', branchName: 'second', createdAt },
    ],
    ['b'],
  ));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'old',
    join(root, 'a', 'worktrees', 'one'),
  ]);
  jest.clearAllMocks();
});
afterEach(async () => {
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const boundaries = [
  'workspace-reorder',
  'update',
  'reorder',
  'rename',
] as const;
function invoke(
  kind: (typeof boundaries)[number],
  expectedRevision?: number,
  idempotencyKey?: string,
  changed = false,
): Promise<unknown> {
  const options = { expectedRevision, idempotencyKey };
  switch (kind) {
    case 'workspace-reorder':
      return reorderWorkspaces({
        ...options,
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'a',
        overWorkspaceId: changed ? 'missing' : 'b',
      });
    case 'update':
      return updateWorktree({
        ...options,
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: changed ? 'Other' : 'Edited' },
      });
    case 'reorder':
      return moveWorktree({
        ...options,
        workspaceId: 'a',
        activeWorktreeId: 'one',
        overWorktreeId: changed ? 'one' : 'two',
      });
    case 'rename':
      return renameWorktreeBranch({
        ...options,
        source: 'desktop',
        workspaceId: 'a',
        worktreeId: 'one',
        newBranchName: changed ? 'other' : 'renamed',
      });
  }
}
function images(): string[] {
  return ['index.json', 'a/workspace.json', 'a/worktrees.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}
it.each(boundaries)(
  '%s refuses stale revisions without canonical writes or Git effects',
  async (kind) => {
    const before = images();
    await expect(invoke(kind, 99)).rejects.toBeInstanceOf(
      W5RevisionConflictError,
    );
    expect(images()).toEqual(before);
    expect(
      execFileSync(
        'git',
        ['-C', join(root, 'a', 'worktrees', 'one'), 'branch', '--show-current'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('old');
  },
);
it.each(boundaries)(
  '%s replays the final outcome without another effect and refuses parameter reuse',
  async (kind) => {
    const commits = jest.spyOn(host, 'commit');
    const first = await invoke(kind, 0, 'key');
    const before = images();
    const count = commits.mock.calls.length;
    expect(await invoke(kind, 999, 'key')).toEqual(first);
    expect(commits).toHaveBeenCalledTimes(count);
    expect(images()).toEqual(before);
    await expect(invoke(kind, undefined, 'key', true)).rejects.toMatchObject({
      reason: 'key-reused',
    });
  },
);
it('rename failure after Git requires recovery and does not rename twice', async () => {
  jest
    .spyOn(host, 'commit')
    .mockRejectedValueOnce(new Error('decision unavailable'));
  await expect(invoke('rename', undefined, 'key')).rejects.toThrow(
    'decision unavailable',
  );
  expect(
    execFileSync(
      'git',
      ['-C', join(root, 'a', 'worktrees', 'one'), 'branch', '--show-current'],
      { encoding: 'utf8' },
    ).trim(),
  ).toBe('renamed');
  await expect(invoke('rename', undefined, 'key')).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});

it('workspace deletion refuses a stale revision before effects', async () => {
  const options = { expectedRevision: 99 };
  const before = images();
  await expect(
    deleteWorkspace({
      ...options,
      workspaceId: 'a',
      source: 'shared_container_fork',
    }),
  ).rejects.toBeInstanceOf(W5RevisionConflictError);
  expect(images()).toEqual(before);
});
it('workspace deletion commits only its index entry once and replays after removal', async () => {
  const other = ['workspace.json', 'worktrees.json'].map((file) =>
    readFileSync(join(root, 'b', file), 'utf8'),
  );
  const commits = jest.spyOn(host, 'commit');
  const options = { expectedRevision: 0, idempotencyKey: 'delete-key' };
  const request = {
    ...options,
    workspaceId: 'a',
    source: 'shared_container_fork' as const,
  };
  const first = await deleteWorkspace(request);
  expect(existsSync(join(root, 'a'))).toBe(false);
  expect(
    ['workspace.json', 'worktrees.json'].map((file) =>
      readFileSync(join(root, 'b', file), 'utf8'),
    ),
  ).toEqual(other);
  expect(
    commits.mock.calls.filter(([call]) =>
      call.files.some((file) => file.path.endsWith('index.json')),
    ),
  ).toHaveLength(1);
  const count = commits.mock.calls.length;
  expect(await deleteWorkspace(request)).toEqual(first);
  expect(commits).toHaveBeenCalledTimes(count);
  await expect(
    deleteWorkspace({ ...request, singleRepoProject: true }),
  ).rejects.toMatchObject({ reason: 'key-reused' });
});
it('workspace delete failure after directory removal leaves recovery required', async () => {
  const error = new Error('watcher commit failed');
  const watcher = getAppAdvisorWatcherService();
  jest
    .spyOn(watcher, 'commitLocalWorkspaceCancellation')
    .mockRejectedValue(error);
  jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
  const options = { idempotencyKey: 'delete-key' };
  const request = {
    ...options,
    workspaceId: 'a',
    source: 'shared_container_fork' as const,
  };
  await expect(deleteWorkspace(request)).rejects.toBe(error);
  expect(existsSync(join(root, 'a'))).toBe(false);
  await expect(deleteWorkspace(request)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});
it('archive refuses a stale first-transition revision', async () => {
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'remove',
    '--force',
    join(root, 'a', 'worktrees', 'one'),
  ]);
  const options = { expectedRevision: 99 };
  const before = images();
  await expect(
    archiveWorktree({
      ...options,
      workspaceId: 'a',
      worktreeId: 'one',
      source: 'single_repo',
      deleteWithoutRetentionIfMissing: true,
    }),
  ).rejects.toBeInstanceOf(W5RevisionConflictError);
  expect(images()).toEqual(before);
});

it('archive removes its canonical row in one decision; repeat ignores the stale revision', async () => {
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'remove',
    '--force',
    join(root, 'a', 'worktrees', 'one'),
  ]);
  const commits = jest.spyOn(host, 'commit');
  const first = await archiveWorktree({
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo',
    deleteWithoutRetentionIfMissing: true,
    expectedRevision: 0,
  });
  expect(first.success).toBe(true);
  expect(
    commits.mock.calls.filter(
      ([call]) =>
        call.operation === 'core.worktree.archive' && call.files.length > 0,
    ),
  ).toHaveLength(1);
  const count = commits.mock.calls.length;
  expect(
    await archiveWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      source: 'single_repo',
      deleteWithoutRetentionIfMissing: true,
      expectedRevision: 0,
    }),
  ).toMatchObject({ status: 'already-archived', success: true });
  expect(commits).toHaveBeenCalledTimes(count);
});
it('worktree delete checks revisions, replays and refuses parameter reuse', async () => {
  const request = {
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo' as const,
    idempotencyKey: 'key',
  };
  const before = images();
  await expect(
    deleteWorktree({ ...request, expectedRevision: 99 }),
  ).rejects.toBeInstanceOf(W5RevisionConflictError);
  expect(images()).toEqual(before);
  const first = await deleteWorktree(request);
  const commits = jest.spyOn(host, 'commit');
  expect(await deleteWorktree({ ...request, expectedRevision: 999 })).toEqual(
    first,
  );
  expect(commits).not.toHaveBeenCalled();
  await expect(
    deleteWorktree({ ...request, deleteBranch: true }),
  ).rejects.toMatchObject({ reason: 'key-reused' });
});

it('a keyed delete refused because teardown is busy releases its key', async () => {
  const request = {
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo' as const,
    teardownOperation: 'Worktree deletion',
    idempotencyKey: 'busy-key',
  };
  const release = reserveWorkspaceTargetRuntimeStart('a', 'one');
  await expect(deleteWorktree(request)).rejects.toMatchObject({
    reason: 'busy',
  });
  release();
  expect(await deleteWorktree(request)).toMatchObject({ success: true });
  expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
});
it('keyed deletes refused for live delegates or a split claim release their key', async () => {
  const worktreeRequest = {
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo' as const,
    idempotencyKey: 'worktree-key',
  };
  setDelegationActivity('owner', 'a/one/chat', 1);
  await expect(deleteWorktree(worktreeRequest)).rejects.toBeInstanceOf(
    LiveDelegationsError,
  );
  setDelegationActivity('owner', 'a/one/chat', 0);
  acquireSplitDestinationWorktreeClaim('a', 'one');
  await expect(deleteWorktree(worktreeRequest)).rejects.toBeInstanceOf(
    SplitLockError,
  );
  releaseSplitDestinationWorktreeClaim('a', 'one');
  expect(await deleteWorktree(worktreeRequest)).toMatchObject({
    success: true,
  });

  const workspaceRequest = {
    workspaceId: 'a',
    source: 'shared_container_fork' as const,
    idempotencyKey: 'workspace-key',
  };
  setDelegationActivity('owner', 'a/two/chat', 1);
  await expect(deleteWorkspace(workspaceRequest)).rejects.toBeInstanceOf(
    LiveDelegationsError,
  );
  setDelegationActivity('owner', 'a/two/chat', 0);
  acquireSplitDestinationWorktreeClaim('a', 'two');
  await expect(deleteWorkspace(workspaceRequest)).rejects.toThrow(
    'being split',
  );
  releaseSplitDestinationWorktreeClaim('a', 'two');
  await deleteWorkspace(workspaceRequest);
  expect(existsSync(join(root, 'a'))).toBe(false);
});
it('worktree delete failure after checkout removal requires recovery with no second effect', async () => {
  jest
    .spyOn(host, 'commit')
    .mockRejectedValueOnce(new Error('decision unavailable'));
  const request = {
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo' as const,
    idempotencyKey: 'key',
  };
  await expect(deleteWorktree(request)).rejects.toThrow('decision unavailable');
  expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
  await expect(deleteWorktree(request)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});
it('worktree delete final watcher failure cannot earn a successful receipt', async () => {
  const watcher = getAppAdvisorWatcherService();
  jest
    .spyOn(watcher, 'commitLocalScopeCancellation')
    .mockRejectedValue(new Error('watcher failed'));
  jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
  const request = {
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo' as const,
    idempotencyKey: 'key',
  };
  await expect(deleteWorktree(request)).rejects.toThrow('watcher failed');
  expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
    'two',
  ]);
  await expect(deleteWorktree(request)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});

it('rename runs Git without a repository lock', async () => {
  const original = git.renameBranch;
  jest.spyOn(git, 'renameBranch').mockImplementation(async (...args) => {
    expect(ownsW5RepositoryLock()).toBe(false);
    await original(...args);
  });
  await invoke('rename');
});

it.each(boundaries)(
  '%s makes exactly one canonical decision without a key',
  async (kind) => {
    const commits = jest.spyOn(host, 'commit');
    await invoke(kind);
    const writes = commits.mock.calls.filter(([call]) => call.files.length > 0);
    expect(writes).toHaveLength(1);
    if (kind === 'workspace-reorder')
      expect(writes[0]?.[0].files).toHaveLength(2);
  },
);
it.each(boundaries)(
  '%s releases a refused stale keyed attempt before effects',
  async (kind) => {
    await expect(invoke(kind, 99, 'key')).rejects.toBeInstanceOf(
      W5RevisionConflictError,
    );
    await invoke(kind, 0, 'key');
  },
);

it.each(['update', 'reorder', 'rename'] as const)(
  '%s publishes notifications only after canonical application',
  async (kind) => {
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementation(async (request) => {
      expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
      return commit(request);
    });
    await invoke(kind);
    expect(notifyPortalStructureChanged).toHaveBeenCalled();
  },
);

it('a stale archive cannot persist read-time removal cleanup for another row', async () => {
  const other = (await readWorkspaceWorktrees('a')).find(
    (row) => row.id === 'two',
  );
  if (!other) throw new Error('fixture row missing');
  markWorkspaceWorktreeRecentlyRemoved('a', other.id, other.createdAt);
  const before = images();
  await expect(
    archiveWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      source: 'single_repo',
      expectedRevision: 99,
    }),
  ).rejects.toBeInstanceOf(W5RevisionConflictError);
  expect(images()).toEqual(before);
});

it('worktree deletion rechecks the caller revision at the canonical decision after Git removal', async () => {
  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementation(async (request) => {
    if (
      request.operation === 'core.worktree.delete' &&
      request.files.length > 0
    ) {
      await commit({
        operation: 'test.concurrent-edit',
        outcome: null,
        files: [],
        advance: [{ kind: 'worktree', workspaceId: 'a', worktreeId: 'one' }],
      });
    }
    return commit(request);
  });
  const request = {
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo' as const,
    expectedRevision: 0,
    idempotencyKey: 'key',
  };
  await expect(deleteWorktree(request)).rejects.toBeInstanceOf(
    W5RevisionConflictError,
  );
  expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
  // The refused decision leaves no tombstone that a later read would persist.
  expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
    'one',
    'two',
  ]);
  await expect(deleteWorktree(request)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});
it('revisioned branch deletion accepts its own internal journal revisions', async () => {
  const commits = jest.spyOn(host, 'commit');
  const request = {
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo' as const,
    expectedRevision: 0,
    idempotencyKey: 'key',
    deleteBranch: true,
  };
  expect(await deleteWorktree(request)).toMatchObject({ success: true });
  const final = commits.mock.calls.find(
    ([call]) =>
      call.operation === 'core.worktree.delete' && call.files.length > 0,
  )?.[0];
  expect(final?.expectedRevisions).toEqual([
    {
      resource: { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' },
      revision: 1,
    },
  ]);
  expect(await deleteWorktree(request)).toMatchObject({ success: true });
});
