import type * as DestructiveRecovery from '../w5-destructive-recovery';
// This suite controls the legacy filesystem. Durable lifecycle evidence is
// exercised with real files and workers in w5-destructive-recovery.test.ts.
jest.mock('../w5-destructive-recovery', () => ({
  ...jest.requireActual<typeof DestructiveRecovery>(
    '../w5-destructive-recovery',
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
import type {
  ArchivedContainerManifest,
  WorkspaceConfigFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { setDelegationActivity } from '../../agents/delegation/activity';
import { access } from 'node:fs/promises';
import { listArchivedContainerManifests } from '../archived-containers';
import { recordWorktreeCrudTelemetry } from '../desktop-telemetry';
import { queueTrackedGitHubWorktreeSync } from '../post-archive-sync';
import {
  isWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
} from '../workspace-persistence';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
} from '../worktree-service';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from '../worktree-live-cleanup';
import {
  assertNotSplitDestinationWorktreeClaimed,
  assertNotSplitLocked,
} from '../../services/split-lock-service';
import { runAutoArchiveTeardown } from '../auto-archive-teardown';
import {
  assertWorkspaceTargetRuntimeStartAllowed,
  reserveWorkspaceTargetRuntimeStart,
  resetWorkspaceTargetExclusionsForTests,
} from '../workspace-target-exclusion';
import {
  archiveWorkspaceWorktrees,
  archiveWorktree,
  WorktreeArchiveRefusedError,
} from '../worktree-archive';

jest.mock('../worktree-service', () => ({
  archiveSingleRepoWorktree: jest.fn(),
  archiveMultiRepoWorktree: jest.fn(),
}));
jest.mock('../workspace-persistence', () => ({
  readWorkspaceConfigDetailed: jest.fn(),
  readWorkspaceWorktrees: jest.fn(),
  isWorkspaceWorktreeRecentlyRemoved: jest.fn(() => false),
}));
jest.mock('../archived-containers', () => ({
  listArchivedContainerManifests: jest.fn(() => Promise.resolve([])),
}));
jest.mock('node:fs/promises', () => ({ access: jest.fn() }));
jest.mock('../paths', () => ({
  getWorkspaceWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string): string =>
      `/data/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
jest.mock('../worktree-live-cleanup', () => ({
  cleanupLiveWorktreeState: jest.fn(),
  purgeLiveWorktreeObservabilityData: jest.fn(),
}));
jest.mock('../auto-archive-teardown', () => ({
  runAutoArchiveTeardown: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../services/split-lock-service', () => ({
  assertNotSplitLocked: jest.fn(),
  assertNotSplitDestinationWorktreeClaimed: jest.fn(),
}));

const mockedArchiveSingle = jest.mocked(archiveSingleRepoWorktree);
const mockedArchiveMulti = jest.mocked(archiveMultiRepoWorktree);
const mockedReadConfig = jest.mocked(readWorkspaceConfigDetailed);
const mockedReadWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedRecentlyRemoved = jest.mocked(isWorkspaceWorktreeRecentlyRemoved);
const mockedListManifests = jest.mocked(listArchivedContainerManifests);
const mockedAccess = jest.mocked(access);
const mockedTelemetry = jest.mocked(recordWorktreeCrudTelemetry);
const mockedGitHubSync = jest.mocked(queueTrackedGitHubWorktreeSync);
const mockedSplitLocked = jest.mocked(assertNotSplitLocked);
const mockedSplitClaimed = jest.mocked(
  assertNotSplitDestinationWorktreeClaimed,
);

const mockedTeardown = jest.mocked(runAutoArchiveTeardown);

const CREATED_AT = '2026-10-01T00:00:00.000Z';

function config(
  type: WorkspaceConfigFile['type'],
  authority: 'ok' | 'unreadable' = 'ok',
): Awaited<ReturnType<typeof readWorkspaceConfigDetailed>> {
  return {
    config: {
      version: 1,
      type,
      repoPath: type === 'single-repo' ? '/repos/app' : undefined,
      repos: [],
    },
    authority,
    ownerMalformed: false,
    memoryMalformed: false,
  };
}

function row(id: string): WorktreeData {
  return { id, branchName: `branch-${id}`, createdAt: CREATED_AT };
}

function retainedArchive(worktreeId: string): ArchivedContainerManifest {
  return {
    version: 2,
    id: 'archive-1',
    projectId: 'ws-1',
    kind: 'worktree',
    name: 'Archived',
    createdAt: CREATED_AT,
    archivedAt: '2026-10-02T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2026-10-09T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
    workspaceType: 'single-repo',
    originalWorktree: row(worktreeId),
    gitState: { version: 1, diffFormatVersion: 1, repositories: [] },
    gitChanges: {
      status: 'complete',
      capturedAt: '2026-10-02T00:00:00.000Z',
      fileCount: 0,
      insertions: 0,
      deletions: 0,
      repositories: [],
    },
    pullRequestMetadata: {
      capturedAt: '2026-10-02T00:00:00.000Z',
      repositories: [],
    },
  };
}

describe('worktree archive boundary (CAN-3811)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedReadWorktrees.mockResolvedValue([row('wt-1')]);
    mockedRecentlyRemoved.mockReturnValue(false);
    mockedListManifests.mockResolvedValue([]);
    // No checkout on disk unless a test says otherwise.
    mockedAccess.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockedArchiveSingle.mockResolvedValue({ success: true, warnings: ['w'] });
    mockedArchiveMulti.mockResolvedValue({ success: true, warnings: [] });
  });

  it('archives a single-repo worktree with live cleanup and reports it', async () => {
    await expect(
      archiveWorktree({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        source: 'single_repo',
        expectedCreatedAt: CREATED_AT,
        deleteBranch: true,
        lockAfterArchive: true,
        repoPath: '/repos/app',
        remainingWorktreeOrder: ['wt-2'],
        expectedRemainingWorktreeOrder: ['wt-2'],
      }),
    ).resolves.toEqual({
      status: 'archived',
      success: true,
      warnings: ['w'],
    });

    expect(mockedArchiveSingle).toHaveBeenCalledWith({
      sourceAdmission: 'required',
      w5Commit: { operation: 'core.worktree.archive' },
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      expectedCreatedAt: CREATED_AT,
      deleteBranch: true,
      lockAfterArchive: true,
      repoPath: '/repos/app',
      remainingWorktreeOrder: ['wt-2'],
      expectedRemainingWorktreeOrder: ['wt-2'],
      observabilityMode: 'live-service',
      liveServices: {
        cleanupLiveState: cleanupLiveWorktreeState,
        purgeObservabilityData: purgeLiveWorktreeObservabilityData,
      },
    });
    expect(mockedArchiveMulti).not.toHaveBeenCalled();
    expect(mockedGitHubSync).toHaveBeenCalledTimes(1);
    expect(mockedTelemetry).toHaveBeenCalledWith({
      action: 'archive',
      workspaceId: 'ws-1',
      source: 'single_repo',
    });
  });

  it('dispatches by the persisted project kind', async () => {
    mockedReadConfig.mockResolvedValue(config('multi-repo'));

    await archiveWorktree({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      source: 'portal',
    });

    expect(mockedArchiveMulti).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', worktreeId: 'wt-1' }),
    );
    expect(mockedArchiveSingle).not.toHaveBeenCalled();
  });

  it('refuses a Cowork project before any effect', async () => {
    mockedReadConfig.mockResolvedValue(config('cowork'));

    await expect(
      archiveWorktree({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        source: 'portal',
      }),
    ).rejects.toMatchObject({
      name: 'WorktreeArchiveRefusedError',
      reason: 'unsupported-workspace',
      message: 'Cannot archive a worktree in a cowork project.',
    });
    expect(mockedArchiveSingle).not.toHaveBeenCalled();
    expect(mockedArchiveMulti).not.toHaveBeenCalled();
  });

  it('refuses a caller that expects another project kind', async () => {
    mockedReadConfig.mockResolvedValue(config('multi-repo'));

    await expect(
      archiveWorktree({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        source: 'single_repo',
        expectedKind: 'single-repo',
      }),
    ).rejects.toMatchObject({ reason: 'kind-mismatch' });
    expect(mockedArchiveMulti).not.toHaveBeenCalled();
  });

  it('lets the caller channel decide the kind when the config is unreadable', async () => {
    // An unreadable config reads as the default multi-repo config.
    mockedReadConfig.mockResolvedValue(config('multi-repo', 'unreadable'));

    await archiveWorktree({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      source: 'single_repo',
      expectedKind: 'single-repo',
    });

    expect(mockedArchiveSingle).toHaveBeenCalled();
    expect(mockedArchiveMulti).not.toHaveBeenCalled();
  });

  it('runs the split and delegation safeguards before any effect', async () => {
    mockedSplitLocked.mockImplementationOnce(() => {
      throw new Error('split in progress');
    });
    await expect(
      archiveWorktree({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        source: 'portal',
      }),
    ).rejects.toThrow('split in progress');
    expect(mockedSplitLocked).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      'archiving the worktree',
    );

    mockedSplitClaimed.mockImplementationOnce(() => {
      throw new Error('split destination');
    });
    await expect(
      archiveWorktree({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        source: 'portal',
      }),
    ).rejects.toThrow('split destination');

    setDelegationActivity('archive-owner', 'ws-1/wt-1/chat-a', 1);
    try {
      await expect(
        archiveWorktree({
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          source: 'portal',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    } finally {
      setDelegationActivity('archive-owner', 'ws-1/wt-1/chat-a', 0);
    }
    expect(mockedArchiveSingle).not.toHaveBeenCalled();
  });

  it('rejects a malformed id or order entry before reading anything', async () => {
    await expect(
      archiveWorktree({
        workspaceId: 'ws-1',
        worktreeId: 'Bad Id!',
        source: 'portal',
      }),
    ).rejects.toThrow();
    await expect(
      archiveWorktree({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        source: 'portal',
        remainingWorktreeOrder: ['../escape'],
      }),
    ).rejects.toThrow();
    expect(mockedReadConfig).not.toHaveBeenCalled();
  });

  describe('a repeat of a completed archive (CAN-3799 B5)', () => {
    beforeEach(() => {
      mockedReadWorktrees.mockResolvedValue([]);
    });

    it('succeeds with no new effect when a retained archive holds the worktree', async () => {
      mockedListManifests.mockResolvedValue([retainedArchive('wt-1')]);

      await expect(
        archiveWorktree({
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          source: 'portal',
        }),
      ).resolves.toEqual({
        status: 'already-archived',
        success: true,
        warnings: [],
      });
      expect(mockedArchiveSingle).not.toHaveBeenCalled();
      expect(mockedTelemetry).not.toHaveBeenCalled();
    });

    it('succeeds with no new effect after a deletion without retention', async () => {
      mockedRecentlyRemoved.mockReturnValue(true);

      await expect(
        archiveWorktree({
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          source: 'portal',
          expectedCreatedAt: CREATED_AT,
        }),
      ).resolves.toMatchObject({ status: 'already-archived' });
      expect(mockedRecentlyRemoved).toHaveBeenCalledWith(
        'ws-1',
        'wt-1',
        CREATED_AT,
      );
      expect(mockedArchiveSingle).not.toHaveBeenCalled();
    });

    it('does not treat the retained archive of another incarnation as this one', async () => {
      mockedListManifests.mockResolvedValue([retainedArchive('wt-1')]);

      await expect(
        archiveWorktree({
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          source: 'portal',
          expectedCreatedAt: '2026-10-05T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({ reason: 'not-found' });
    });

    it('runs the archive lifecycle when the row is gone but the checkout remains', async () => {
      // A needs-repair rollback removes the row (leaving a removal tombstone)
      // but keeps the checkout; cancelling the repair must still tear it down.
      mockedRecentlyRemoved.mockReturnValue(true);
      mockedAccess.mockResolvedValue(undefined);
      mockedReadConfig.mockResolvedValue(config('multi-repo'));

      await expect(
        archiveWorktree({
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          source: 'multi_repo',
        }),
      ).resolves.toMatchObject({ status: 'archived' });
      expect(mockedAccess).toHaveBeenCalledWith(
        '/data/workspaces/ws-1/worktrees/wt-1',
      );
      expect(mockedArchiveMulti).toHaveBeenCalled();
    });

    it('resolves a retry for an archived incarnation before the live-worktree guards', async () => {
      // Incarnation A was archived; B now uses the same id and has a live
      // delegate. A retry for A has no effect, so B's guards must not refuse it.
      mockedReadWorktrees.mockResolvedValue([
        { ...row('wt-1'), createdAt: '2026-10-05T00:00:00.000Z' },
      ]);
      mockedListManifests.mockResolvedValue([retainedArchive('wt-1')]);
      setDelegationActivity('archive-owner', 'ws-1/wt-1/chat-b', 1);
      try {
        await expect(
          archiveWorktree({
            workspaceId: 'ws-1',
            worktreeId: 'wt-1',
            source: 'portal',
            expectedCreatedAt: CREATED_AT,
          }),
        ).resolves.toMatchObject({ status: 'already-archived' });
      } finally {
        setDelegationActivity('archive-owner', 'ws-1/wt-1/chat-b', 0);
      }
      expect(mockedSplitLocked).not.toHaveBeenCalled();
      expect(mockedArchiveSingle).not.toHaveBeenCalled();
    });

    it('refuses an unknown worktree as not found', async () => {
      const result = archiveWorktree({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        source: 'portal',
      });

      await expect(result).rejects.toBeInstanceOf(WorktreeArchiveRefusedError);
      await expect(result).rejects.toMatchObject({
        reason: 'not-found',
        message: 'Worktree not found.',
      });
      expect(mockedArchiveSingle).not.toHaveBeenCalled();
    });
  });

  describe('archiving the worktrees of a deleted project (CAN-3799 B2)', () => {
    afterEach(() => {
      resetWorkspaceTargetExclusionsForTests();
    });

    it('archives every listed worktree with its teardown scripts', async () => {
      mockedReadConfig.mockResolvedValue(config('multi-repo'));
      mockedReadWorktrees.mockResolvedValue([row('wt-1'), row('wt-2')]);
      const runtimeStarts: string[] = [];
      const tryRuntimeStart = (when: string, worktreeId: string): void => {
        try {
          assertWorkspaceTargetRuntimeStartAllowed('ws-1', worktreeId);
          runtimeStarts.push(`${when}: allowed`);
        } catch {
          runtimeStarts.push(`${when}: refused`);
        }
      };
      mockedTeardown.mockImplementation((_workspaceId, worktreeId) => {
        tryRuntimeStart('teardown', worktreeId);
        return Promise.resolve();
      });
      mockedArchiveMulti.mockImplementation(async (options) => {
        tryRuntimeStart('archive', options.worktreeId);
        await options.runAutoArchiveTeardown?.();
        return { success: true, warnings: [] };
      });

      await archiveWorkspaceWorktrees('ws-1', 'multi-repo');

      for (const worktreeId of ['wt-1', 'wt-2']) {
        expect(mockedArchiveMulti).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceId: 'ws-1',
            worktreeId,
            expectedCreatedAt: CREATED_AT,
            observabilityMode: 'live-service',
          }),
        );
      }
      expect(mockedArchiveMulti).toHaveBeenCalledTimes(2);
      expect(mockedTeardown.mock.calls).toEqual([
        ['ws-1', 'wt-1', true, 'Project deletion'],
        ['ws-1', 'wt-2', true, 'Project deletion'],
      ]);
      // The lease keeps other runtimes out while its teardown scripts run.
      expect(runtimeStarts).toEqual([
        'archive: refused',
        'teardown: allowed',
        'archive: refused',
        'teardown: allowed',
      ]);
      expect(mockedTelemetry).toHaveBeenCalledWith({
        action: 'archive',
        workspaceId: 'ws-1',
        source: 'workspace_delete',
      });
    });

    it('refuses a worktree that is starting a runtime before any effect', async () => {
      mockedReadWorktrees.mockResolvedValue([row('wt-1')]);
      const release = reserveWorkspaceTargetRuntimeStart('ws-1', 'wt-1');

      try {
        await expect(
          archiveWorkspaceWorktrees('ws-1', 'single-repo'),
        ).rejects.toMatchObject({
          name: 'WorktreeArchiveRefusedError',
          reason: 'busy',
          message: 'A worktree is busy. Retry after it finishes.',
        });
      } finally {
        release();
      }
      expect(mockedArchiveSingle).not.toHaveBeenCalled();
      expect(mockedTeardown).not.toHaveBeenCalled();
    });

    it('stops at the first worktree whose archive fails', async () => {
      mockedReadWorktrees.mockResolvedValue([row('wt-1'), row('wt-2')]);
      mockedArchiveSingle.mockRejectedValueOnce(
        new Error('Project deletion teardown failed: exit 1'),
      );

      await expect(
        archiveWorkspaceWorktrees('ws-1', 'single-repo'),
      ).rejects.toThrow('Project deletion teardown failed: exit 1');

      expect(mockedArchiveSingle).toHaveBeenCalledTimes(1);
    });

    it('skips a worktree that left the list after it was read', async () => {
      mockedReadWorktrees
        .mockResolvedValueOnce([row('wt-1'), row('wt-2')])
        .mockResolvedValue([row('wt-2')]);

      await archiveWorkspaceWorktrees('ws-1', 'single-repo');

      expect(mockedArchiveSingle).toHaveBeenCalledTimes(1);
      expect(mockedArchiveSingle).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: 'wt-2' }),
      );
    });
  });
});
