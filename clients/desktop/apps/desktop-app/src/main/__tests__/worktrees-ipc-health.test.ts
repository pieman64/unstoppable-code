import type * as DestructiveRecovery from '../lib/w5-destructive-recovery';
// This suite controls the legacy filesystem. Durable lifecycle evidence is
// exercised with real files and workers in w5-destructive-recovery.test.ts.
jest.mock('../lib/w5-destructive-recovery', () => ({
  ...jest.requireActual<typeof DestructiveRecovery>(
    '../lib/w5-destructive-recovery',
  ),
  readDestructiveRecovery: jest.fn(() => Promise.resolve(null)),
  assertNoDestructiveRecovery: jest.fn(() => Promise.resolve()),
  assertNoLegacyArchiveRecovery: jest.fn(() => Promise.resolve()),
  refuseInterruptedArchiveJournal: jest.fn(() => Promise.resolve()),
  findCompletedDestructiveArchive: jest.fn(() => Promise.resolve(null)),
  reportDestructiveRecovery: jest.fn(() => Promise.resolve([])),
  withDestructiveLifecycle: (
    _input: unknown,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
  destructiveStep: (
    _phase: string,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
  destructiveCall: (
    _phase: string,
    work: (...args: unknown[]) => Promise<unknown>,
    ...args: unknown[]
  ): Promise<unknown> => work(...args),
  hasDestructiveLifecycle: (): boolean => false,
  assertDestructiveRowIdentity: (): void => {},
  acknowledgeArchiveCaptureRefusal: (): void => {},
  protectDestructivePath: (): Promise<void> => Promise.resolve(),
  markDestructiveCleanupRequired: (): void => {},
  destructiveCleanup: (
    _phase: string,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
}));
jest.mock('../lib/git', () => ({
  checkoutBranch: jest.fn(),
  createBranchAndCheckout: jest.fn(),
  getDiffStats: jest.fn(),
  isBranchNameAvailable: jest.fn(),
  listBranches: jest.fn(),
  renameBranch: jest.fn(),
  validateBranchName: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getWorkspaceWorktreeRepoDir: jest.fn(),
}));

jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/worktrees/${projectId}/${worktreeId}`,
  ),
}));

jest.mock('../lib/worktree-chat-turn', () => ({
  scheduleBranchNaming: jest.fn(),
}));

jest.mock('../lib/code-graph-scheduler', () => ({
  nudgeCodeGraphRefreshAfterDiffStats: jest.fn(),
}));

jest.mock('../lib/validation', () => ({
  validateAbsolutePath: jest.fn(),
  validateId: jest.fn(),
}));

jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(),
}));

jest.mock('../lib/worktree-service', () => ({
  aggregateMultiRepoDiffStats: jest.fn(),
  archiveSingleRepoWorktree: jest.fn(),
  createSingleRepoWorktree: jest.fn(),
  getWorktreeStats: jest.fn(),
}));

jest.mock('../lib/worktree-health', () => ({
  retryWorktreeHealthCheck: jest.fn(),
}));

jest.mock('../services/worktree-diff-stats-cache', () => ({
  invalidateWorktreeDiffStats: jest.fn(),
  primeWorktreeDiffStats: jest.fn(),
  refreshWorktreeDiffStats: jest.fn(() => Promise.resolve()),
  removeCachedWorktreeDiffStats: jest.fn(),
}));

jest.mock('../lib/worktree-live-cleanup', () => ({
  cleanupLiveWorktreeState: jest.fn(),
  purgeLiveWorktreeObservabilityData: jest.fn(),
}));

jest.mock('../lib/project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  updateWorkspaceWorktree: jest.fn(),
  // The archive boundary (CAN-3811) checks the project kind and that the
  // worktree still exists before archiving.
  readWorkspaceConfigDetailed: jest.fn(() =>
    Promise.resolve({
      config: { version: 1, type: 'single-repo', repoPath: '/repo', repos: [] },
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: false,
    }),
  ),
  readWorkspaceWorktrees: jest.fn(() =>
    Promise.resolve([
      {
        id: 'wt-archive',
        branchName: 'branch-archive',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ]),
  ),
  isWorkspaceWorktreeRecentlyRemoved: jest.fn(() => false),
}));
jest.mock('../lib/archived-containers', () => ({
  listArchivedContainerManifestsStrict: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../lib/worktree-update', () => ({
  moveWorktree: jest.fn(),
  updateWorktree: jest.fn(),
}));

jest.mock('../lib/desktop-telemetry', () => ({
  recordWorktreeCrudTelemetry: jest.fn(),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

import {
  IPC_CHANNELS,
  type DiffStatsBatchRequest,
  type DiffStatsBatchResponseItem,
  type ScheduleTaskBranchNamingRequest,
  type WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import { setDelegationActivity } from '../agents/delegation/activity';
import { registerIpcHandler } from '../ipc/register';
import { registerWorktreeHandlers } from '../ipc/worktrees';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { scheduleBranchNaming } from '../lib/worktree-chat-turn';
import {
  archiveSingleRepoWorktree,
  getWorktreeStats,
} from '../lib/worktree-service';
import { validateId } from '../lib/validation';
import { recordWorktreeCrudTelemetry } from '../lib/desktop-telemetry';
import { moveWorktree, updateWorktree } from '../lib/worktree-update';
import {
  acquireSplitDestinationWorktreeClaim,
  acquireSplitLock,
  releaseSplitDestinationWorktreeClaim,
  releaseSplitLock,
  SplitLockError,
} from '../services/split-lock-service';
import {
  invalidateWorktreeDiffStats,
  primeWorktreeDiffStats,
  refreshWorktreeDiffStats,
} from '../services/worktree-diff-stats-cache';

type BatchHandler = (
  event: unknown,
  request: DiffStatsBatchRequest,
) => Promise<DiffStatsBatchResponseItem[]>;

type ScheduleTaskBranchNamingHandler = (
  event: unknown,
  request: ScheduleTaskBranchNamingRequest,
) => void;

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedGetWorktreeStats = jest.mocked(getWorktreeStats);
const mockedArchiveSingleRepoWorktree = jest.mocked(archiveSingleRepoWorktree);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedScheduleBranchNaming = jest.mocked(scheduleBranchNaming);
const mockedValidateId = jest.mocked(validateId);
const mockedMoveWorktree = jest.mocked(moveWorktree);
const mockedUpdateWorktree = jest.mocked(updateWorktree);
const mockedRecordWorktreeCrudTelemetry = jest.mocked(
  recordWorktreeCrudTelemetry,
);
const mockedInvalidateWorktreeDiffStats = jest.mocked(
  invalidateWorktreeDiffStats,
);
const mockedPrimeWorktreeDiffStats = jest.mocked(primeWorktreeDiffStats);
const mockedRefreshWorktreeDiffStats = jest.mocked(refreshWorktreeDiffStats);

type RegisteredHandler = (event: unknown, request: unknown) => Promise<unknown>;

function getRegisteredHandler(channel: string): RegisteredHandler {
  registerWorktreeHandlers(() => null);
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registered]) => registered === channel,
  );
  const handler = call?.[1];
  if (typeof handler !== 'function') {
    throw new Error(`${channel} handler was not registered`);
  }
  return (event, request): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, [event, request]));
}

function getBatchHandler(): BatchHandler {
  registerWorktreeHandlers(() => null);
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'worktree:diff-stats-batch',
  );
  if (!call) {
    throw new Error('worktree:diff-stats-batch handler was not registered');
  }
  const handler = call[1];
  if (typeof handler !== 'function') {
    throw new Error('worktree:diff-stats-batch handler is not callable');
  }

  const typedHandler = handler as (
    event: unknown,
    request: DiffStatsBatchRequest,
  ) => Promise<DiffStatsBatchResponseItem[]>;
  return (event, request): Promise<DiffStatsBatchResponseItem[]> =>
    Promise.resolve(typedHandler(event, request));
}

type ArchiveHandler = (event: unknown, request: unknown) => Promise<unknown>;

function getArchiveHandler(): ArchiveHandler {
  registerWorktreeHandlers(() => null);
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.worktreeArchive,
  );
  if (!call) {
    throw new Error('worktree:archive handler was not registered');
  }
  const handler = call[1];
  if (typeof handler !== 'function') {
    throw new Error('worktree:archive handler is not callable');
  }
  const typed = handler as ArchiveHandler;
  return (event, request): Promise<unknown> =>
    Promise.resolve(typed(event, request));
}

function getScheduleTaskBranchNamingHandler(): ScheduleTaskBranchNamingHandler {
  registerWorktreeHandlers(() => null);
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.worktreeScheduleTaskBranchNaming,
  );
  if (!call) {
    throw new Error('worktree:schedule-task-branch-naming was not registered');
  }
  const handler = call[1];
  if (typeof handler !== 'function') {
    throw new Error(
      'worktree:schedule-task-branch-naming handler is not callable',
    );
  }

  return handler as ScheduleTaskBranchNamingHandler;
}

describe('worktree IPC health handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a broken worktree item without rejecting the batch', async () => {
    const issue: WorktreeHealthIssue = {
      status: 'broken',
      code: 'invalid-git-worktree',
      message:
        'Git metadata for this worktree is incomplete or points to a missing location.',
      checkedAt: '2026-04-22T00:00:00.000Z',
      worktreePath: '/worktrees/project-1/wt-1',
    };
    mockedGetWorktreeStats.mockResolvedValue({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      insertions: 0,
      deletions: 0,
      healthIssue: issue,
    });
    const handler = getBatchHandler();

    await expect(
      handler(
        {},
        {
          worktrees: [{ projectId: 'project-1', worktreeId: 'wt-1' }],
        },
      ),
    ).resolves.toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        insertions: 0,
        deletions: 0,
        healthIssue: issue,
      },
    ]);
  });

  it('awaits item stats inside the per-item catch', async () => {
    mockedGetWorktreeStats
      .mockResolvedValueOnce({
        projectId: 'project-1',
        worktreeId: 'wt-ok',
        insertions: 3,
        deletions: 1,
      })
      .mockRejectedValueOnce(new Error('stale worktree'));
    const handler = getBatchHandler();

    await expect(
      handler(
        {},
        {
          worktrees: [
            { projectId: 'project-1', worktreeId: 'wt-ok' },
            { projectId: 'project-1', worktreeId: 'wt-bad' },
          ],
        },
      ),
    ).resolves.toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'wt-ok',
        insertions: 3,
        deletions: 1,
      },
      {
        projectId: 'project-1',
        worktreeId: 'wt-bad',
        insertions: 0,
        deletions: 0,
      },
    ]);
    expect(mockedPrimeWorktreeDiffStats.mock.calls).toEqual([
      ['project-1', 'wt-ok', { insertions: 3, deletions: 1 }],
    ]);
    expect(mockedInvalidateWorktreeDiffStats).not.toHaveBeenCalled();
    expect(mockedRefreshWorktreeDiffStats).not.toHaveBeenCalled();
  });

  it('routes diff-only batch items through the lightweight cached path', async () => {
    mockedRefreshWorktreeDiffStats.mockResolvedValueOnce({
      insertions: 8,
      deletions: 3,
      refreshedAt: 123,
      generation: 4,
    });
    const handler = getBatchHandler();

    await expect(
      handler(
        {},
        {
          worktrees: [
            {
              projectId: 'project-1',
              worktreeId: 'wt-background',
              mode: 'diff_only',
            },
          ],
          source: 'renderer-global-poll',
        },
      ),
    ).resolves.toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'wt-background',
        insertions: 8,
        deletions: 3,
        mode: 'diff_only',
      },
    ]);
    expect(mockedRefreshWorktreeDiffStats).toHaveBeenCalledWith(
      'project-1',
      'wt-background',
    );
    expect(mockedGetWorktreeStats).not.toHaveBeenCalled();
    expect(mockedPrimeWorktreeDiffStats).not.toHaveBeenCalled();
  });

  it('preserves diff-only mode when the lightweight batch path fails', async () => {
    mockedRefreshWorktreeDiffStats.mockRejectedValueOnce(
      new Error('diff unavailable'),
    );
    const handler = getBatchHandler();

    await expect(
      handler(
        {},
        {
          worktrees: [
            {
              projectId: 'project-1',
              worktreeId: 'wt-background',
              mode: 'diff_only',
            },
          ],
        },
      ),
    ).resolves.toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'wt-background',
        insertions: 0,
        deletions: 0,
        mode: 'diff_only',
      },
    ]);
  });

  it('processes large diff-stat batches one worktree at a time', async () => {
    const resolvers: Array<() => void> = [];
    mockedGetWorktreeStats.mockImplementation(
      (projectId, worktreeId) =>
        new Promise((resolve) => {
          resolvers.push(() =>
            resolve({
              projectId,
              worktreeId,
              insertions: 0,
              deletions: 0,
            }),
          );
        }),
    );
    const handler = getBatchHandler();
    const pending = handler(
      {},
      {
        worktrees: ['wt-1', 'wt-2', 'wt-3'].map((worktreeId) => ({
          projectId: 'project-1',
          worktreeId,
        })),
      },
    );

    await Promise.resolve();
    expect(mockedGetWorktreeStats).toHaveBeenCalledTimes(1);
    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedGetWorktreeStats).toHaveBeenCalledTimes(2);
    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedGetWorktreeStats).toHaveBeenCalledTimes(3);
    resolvers.shift()?.();

    await expect(pending).resolves.toHaveLength(3);
  });

  it('schedules task branch naming from the worktree root for selected child repos', () => {
    const handler = getScheduleTaskBranchNamingHandler();

    handler(
      {},
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        selectedRepoId: 'frontend',
        text: 'rename from forked chat context',
      },
    );

    expect(mockedValidateId).toHaveBeenCalledWith('frontend', 'selectedRepoId');
    expect(mockedResolveWorktreeCwd.mock.calls[0]).toEqual([
      'project-1',
      'wt-1',
    ]);
    expect(mockedScheduleBranchNaming).toHaveBeenCalledTimes(1);
    const scheduled = mockedScheduleBranchNaming.mock.calls[0]?.[0];
    expect(scheduled).toMatchObject({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      text: 'rename from forked chat context',
      cwd: '/worktrees/project-1/wt-1',
    });
    // The rename is recorded and announced through the IPC's window.
    expect(typeof scheduled?.getWindow).toBe('function');
  });

  describe('worktreeArchive split-lock guard', () => {
    const WS = 'proj-archive';
    const WT = 'wt-archive';
    const OTHER_WT = 'wt-archive-other';

    afterEach(() => {
      releaseSplitLock(WS, WT);
      releaseSplitLock(WS, OTHER_WT);
      releaseSplitDestinationWorktreeClaim(WS, WT);
    });

    it('refuses with SplitLockError and does NOT archive while the worktree is split-locked', async () => {
      const handler = getArchiveHandler();
      acquireSplitLock(WS, WT);

      await expect(
        handler({}, { projectId: WS, worktreeId: WT, repoPath: '/repo' }),
      ).rejects.toBeInstanceOf(SplitLockError);
      expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
    });

    it('archives normally when unlocked', async () => {
      const handler = getArchiveHandler();
      mockedArchiveSingleRepoWorktree.mockResolvedValue({
        success: true,
      } as never);

      await handler({}, { projectId: WS, worktreeId: WT, repoPath: '/repo' });
      expect(mockedArchiveSingleRepoWorktree).toHaveBeenCalledTimes(1);
    });

    it('forwards a destructive chat deletion request to the worktree service', async () => {
      const handler = getArchiveHandler();
      mockedArchiveSingleRepoWorktree.mockResolvedValue({
        success: true,
      } as never);

      await handler(
        {},
        {
          projectId: WS,
          worktreeId: WT,
          repoPath: '/repo',
          deleteWithoutRetentionIfMissing: true,
        },
      );

      expect(mockedArchiveSingleRepoWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ deleteWithoutRetentionIfMissing: true }),
      );
    });

    it('refuses to archive a destination claimed by an active split', async () => {
      const handler = getArchiveHandler();
      acquireSplitDestinationWorktreeClaim(WS, WT);

      await expect(
        handler({}, { projectId: WS, worktreeId: WT, repoPath: '/repo' }),
      ).rejects.toBeInstanceOf(SplitLockError);
      expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
    });

    it('refuses to archive while a chat in the worktree has live delegates', async () => {
      const handler = getArchiveHandler();
      setDelegationActivity('archive-owner', `${WS}/${WT}/chat-a`, 0, 1);
      try {
        await expect(
          handler({}, { projectId: WS, worktreeId: WT, repoPath: '/repo' }),
        ).rejects.toThrow('Delegates are still running here. Stop them first.');
      } finally {
        setDelegationActivity('archive-owner', `${WS}/${WT}/chat-a`, 0);
      }
      expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
    });

    it('archives while only another worktree has live delegates', async () => {
      const handler = getArchiveHandler();
      mockedArchiveSingleRepoWorktree.mockResolvedValue({
        success: true,
      } as never);
      setDelegationActivity('archive-owner', `${WS}/${OTHER_WT}/chat-a`, 1);
      try {
        await handler({}, { projectId: WS, worktreeId: WT, repoPath: '/repo' });
      } finally {
        setDelegationActivity('archive-owner', `${WS}/${OTHER_WT}/chat-a`, 0);
      }
      expect(mockedArchiveSingleRepoWorktree).toHaveBeenCalledTimes(1);
    });

    it('archives when a DIFFERENT worktree is split-locked', async () => {
      const handler = getArchiveHandler();
      acquireSplitLock(WS, OTHER_WT);
      mockedArchiveSingleRepoWorktree.mockResolvedValue({
        success: true,
      } as never);

      await handler({}, { projectId: WS, worktreeId: WT, repoPath: '/repo' });
      expect(mockedArchiveSingleRepoWorktree).toHaveBeenCalledTimes(1);
    });
  });
});

describe('worktree metadata IPC adapters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUpdateWorktree.mockResolvedValue({
      worktree: {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-09-16T00:00:00.000Z',
      },
      changed: true,
    });
  });

  it.each([
    {
      channel: IPC_CHANNELS.worktreeSetPinned,
      request: { projectId: 'project-1', worktreeId: 'wt-1', pinned: true },
      patch: { pinned: true },
      telemetrySource: null,
    },
    {
      channel: IPC_CHANNELS.worktreeSetHidden,
      request: { projectId: 'project-1', worktreeId: 'wt-1', hidden: false },
      patch: { hidden: false },
      telemetrySource: 'hidden',
    },
    {
      channel: IPC_CHANNELS.worktreeSetLabel,
      request: { projectId: 'project-1', worktreeId: 'wt-1', label: ' Mine ' },
      patch: { label: ' Mine ' },
      telemetrySource: 'label',
    },
    {
      channel: IPC_CHANNELS.worktreeSetLabel,
      request: { projectId: 'project-1', worktreeId: 'wt-1' },
      patch: { label: null },
      telemetrySource: 'label',
    },
    {
      channel: IPC_CHANNELS.worktreeSetBranchGrouping,
      request: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        override: null,
      },
      patch: { branchGroupingOverride: null },
      telemetrySource: 'branch-grouping',
    },
  ])(
    '$channel sends the typed patch $patch to the update boundary',
    async ({ channel, request, patch, telemetrySource }) => {
      await getRegisteredHandler(channel)({}, request);

      expect(mockedValidateId).toHaveBeenCalledWith('project-1', 'projectId');
      expect(mockedUpdateWorktree.mock.calls).toEqual([
        [{ workspaceId: 'project-1', worktreeId: 'wt-1', patch }],
      ]);
      expect(mockedRecordWorktreeCrudTelemetry.mock.calls).toEqual(
        telemetrySource === null
          ? []
          : [
              [
                {
                  action: 'update',
                  workspaceId: 'project-1',
                  source: telemetrySource,
                },
              ],
            ],
      );
    },
  );

  it('sends the grouping order with the override in one update', async () => {
    await getRegisteredHandler(IPC_CHANNELS.worktreeSetBranchGrouping)(
      {},
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        override: 'ungroup',
        worktreeOrder: ['wt-2', 'wt-1'],
      },
    );

    expect(mockedUpdateWorktree.mock.calls).toEqual([
      [
        {
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          patch: { branchGroupingOverride: 'ungroup' },
          worktreeOrder: ['wt-2', 'wt-1'],
        },
      ],
    ]);
  });

  it('records no telemetry when the boundary refuses the update', async () => {
    mockedUpdateWorktree.mockRejectedValueOnce(
      new Error('Worktree wt-1 not found in project project-1'),
    );

    await expect(
      getRegisteredHandler(IPC_CHANNELS.worktreeSetHidden)(
        {},
        { projectId: 'project-1', worktreeId: 'wt-1', hidden: true },
      ),
    ).rejects.toThrow('Worktree wt-1 not found in project project-1');
    expect(mockedRecordWorktreeCrudTelemetry).not.toHaveBeenCalled();
  });

  it('moves a worktree through the boundary and refreshes both rows', async () => {
    mockedMoveWorktree.mockResolvedValueOnce(undefined);

    await getRegisteredHandler(IPC_CHANNELS.worktreeReorder)(
      {},
      {
        workspaceId: 'project-1',
        activeWorktreeId: 'wt-2',
        overWorktreeId: 'wt-1',
      },
    );

    expect(mockedMoveWorktree.mock.calls).toEqual([
      [
        {
          workspaceId: 'project-1',
          activeWorktreeId: 'wt-2',
          overWorktreeId: 'wt-1',
        },
      ],
    ]);
    expect(mockedInvalidateWorktreeDiffStats.mock.calls).toEqual([
      ['project-1', 'wt-2'],
      ['project-1', 'wt-1'],
    ]);
  });
});
