jest.mock('../lib/worktree-create-recovery', () => ({
  inspectWorktreeCreationRecovery: jest.fn(() => Promise.resolve([])),
}));
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
jest.mock('node:fs/promises', () => ({
  rm: jest.fn(() => Promise.resolve()),
  stat: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn(),
  listRegisteredWorktreePaths: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/data/${workspaceId}/${worktreeId}`,
  ),
  getWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/single/${workspaceId}/${worktreeId}`,
  ),
  getWorkspaceWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/multi/${workspaceId}/${worktreeId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string, repoId: string) =>
      `/multi/${workspaceId}/${worktreeId}/repos/${repoId}`,
  ),
  getWorkspaceWorktreeRootRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/multi/${workspaceId}/${worktreeId}/root`,
  ),
}));

jest.mock('../lib/project-reference-repo', () => ({
  resolveProjectReferenceRepoPath: jest.fn(),
}));

jest.mock('../lib/project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
}));

jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn(),
}));

jest.mock('../lib/workspace-worktree-runtime', () => ({
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  updateWorkspaceWorktree: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../lib/workspace-service', () => ({
  listWorkspaceItems: jest.fn(),
}));

jest.mock('../lib/worktree-service', () => ({
  archiveMultiRepoWorktree: jest.fn(() =>
    Promise.resolve({ success: true, warnings: [] }),
  ),
  archiveSingleRepoWorktree: jest.fn(() =>
    Promise.resolve({ success: true, warnings: [] }),
  ),
  rollbackPersistedReservation: jest.fn(() => Promise.resolve()),
  rollbackWorkspaceWorktree: jest.fn(() => Promise.resolve()),
}));

jest.mock('../lib/window-send', () => ({ sendToWindow: jest.fn() }));

import { statSync, type Stats } from 'node:fs';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { rm, stat } from 'node:fs/promises';
import { getCurrentBranch, listRegisteredWorktreePaths } from '../lib/git';
import { resolveProjectReferenceRepoPath } from '../lib/project-reference-repo';
import { startProjectWorktreePostCreateSetup } from '../lib/project-worktree-runtime';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';
import { updateWorkspaceWorktree } from '../lib/workspace-persistence';
import { listWorkspaceItems } from '../lib/workspace-service';
import { startWorkspaceWorktreePostCreateSetup } from '../lib/workspace-worktree-runtime';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  rollbackPersistedReservation,
  rollbackWorkspaceWorktree,
} from '../lib/worktree-service';
import { reconcileGitPendingWorktrees } from '../lib/worktree-boot-recovery';
import { sendToWindow } from '../lib/window-send';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';

const mockedRm = jest.mocked(rm);
const mockedStat = jest.mocked(stat);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedListRegisteredWorktreePaths = jest.mocked(
  listRegisteredWorktreePaths,
);
const mockedResolveProjectReferenceRepoPath = jest.mocked(
  resolveProjectReferenceRepoPath,
);
const mockedStartProjectWorktreePostCreateSetup = jest.mocked(
  startProjectWorktreePostCreateSetup,
);
const mockedResolveWorkspaceReferenceRepoPath = jest.mocked(
  resolveWorkspaceReferenceRepoPath,
);
const mockedUpdateWorkspaceWorktree = jest.mocked(updateWorkspaceWorktree);
const mockedListWorkspaceItems = jest.mocked(listWorkspaceItems);
const mockedStartWorkspaceWorktreePostCreateSetup = jest.mocked(
  startWorkspaceWorktreePostCreateSetup,
);
const mockedArchiveMultiRepoWorktree = jest.mocked(archiveMultiRepoWorktree);
const mockedArchiveSingleRepoWorktree = jest.mocked(archiveSingleRepoWorktree);
const mockedRollbackPersistedReservation = jest.mocked(
  rollbackPersistedReservation,
);
const mockedRollbackWorkspaceWorktree = jest.mocked(rollbackWorkspaceWorktree);

function existingPath(): Stats {
  return statSync(__filename);
}

describe('worktree boot recovery', () => {
  let stderrWriteSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    stderrWriteSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/refs/project-1');
    mockedResolveWorkspaceReferenceRepoPath.mockResolvedValue('/refs/ws-1');
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedStartProjectWorktreePostCreateSetup.mockResolvedValue();
    mockedStartWorkspaceWorktreePostCreateSetup.mockResolvedValue();
    // The persisted row is the one launch listed, unless a test replaces it.
    mockedUpdateWorkspaceWorktree.mockImplementation(
      async (workspaceId, worktreeId, updater) => {
        const listed =
          await mockedListWorkspaceItems.getMockImplementation()?.();
        const workspace = listed?.find((item) => item.id === workspaceId);
        const row =
          workspace && workspace.type !== 'cowork'
            ? workspace.worktrees.find((item) => item.id === worktreeId)
            : undefined;
        if (row) updater(row);
        return row !== undefined;
      },
    );
    mockedArchiveMultiRepoWorktree.mockResolvedValue({
      success: true,
      warnings: [],
    });
    mockedArchiveSingleRepoWorktree.mockResolvedValue({
      success: true,
      warnings: [],
    });
    mockedRollbackPersistedReservation.mockResolvedValue();
    mockedRollbackWorkspaceWorktree.mockResolvedValue();
    mockedRm.mockResolvedValue(undefined);
    mockedStat.mockRejectedValue(new Error('missing'));
    mockedListRegisteredWorktreePaths.mockResolvedValue(new Set<string>());
  });

  afterEach(() => {
    stderrWriteSpy.mockRestore();
  });

  it('promotes valid pending single-repo rows to git-ready', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'single-repo',
        id: 'project-1',
        name: 'Project 1',
        repoPath: '/repos/project-1',
        color: '#000000',
        worktrees: [
          {
            id: 'wt-ready',
            branchName: 'feature/test',
            createdAt: '2026-04-25T00:00:00.000Z',
            setupPhase: 'git-pending',
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);
    mockedStat.mockImplementation((path) => {
      if (path === '/single/project-1/wt-ready') {
        return Promise.resolve(existingPath());
      }
      return Promise.reject(new Error(`missing ${String(path)}`));
    });
    mockedListRegisteredWorktreePaths.mockResolvedValue(
      new Set(['/single/project-1/wt-ready']),
    );

    await reconcileGitPendingWorktrees();

    expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-ready',
      expect.any(Function),
    );
    const updateCallback = mockedUpdateWorkspaceWorktree.mock.calls[0]?.[2];
    if (!updateCallback) {
      throw new Error('Expected update callback to be provided');
    }
    expect(
      updateCallback({
        id: 'wt-ready',
        branchName: 'reserved-name',
        createdAt: '2026-04-25T00:00:00.000Z',
        setupPhase: 'git-pending',
      }),
    ).toEqual({
      id: 'wt-ready',
      branchName: 'feature/test',
      createdAt: '2026-04-25T00:00:00.000Z',
      setupPhase: 'git-ready',
    });
    expect(mockedStartProjectWorktreePostCreateSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'wt-ready',
        project: {
          repoPath: '/repos/project-1',
          scripts: undefined,
        },
      }),
    );
    expect(mockedRollbackPersistedReservation).not.toHaveBeenCalled();
    expect(mockedRollbackWorkspaceWorktree).not.toHaveBeenCalled();
    expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedArchiveMultiRepoWorktree).not.toHaveBeenCalled();
  });

  it('does not replay setup for a pending row replaced since launch read it', async () => {
    const listed: WorktreeData = {
      id: 'wt-ready',
      branchName: 'feature/test',
      createdAt: '2026-04-25T00:00:00.000Z',
      setupPhase: 'git-pending',
    };
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'single-repo',
        id: 'project-1',
        name: 'Project 1',
        repoPath: '/repos/project-1',
        color: '#000000',
        worktrees: [listed],
        collapsed: false,
        order: 0,
      },
    ]);
    mockedStat.mockResolvedValue(existingPath());
    mockedListRegisteredWorktreePaths.mockResolvedValue(
      new Set(['/single/project-1/wt-ready']),
    );
    const updated: WorktreeData[] = [];
    // The archive and recreate of the same id that ran after launch listed it.
    mockedUpdateWorkspaceWorktree.mockImplementation(
      (_workspaceId, _worktreeId, updater) => {
        updated.push(
          updater({ ...listed, createdAt: '2026-04-26T00:00:00.000Z' }),
        );
        return Promise.resolve(true);
      },
    );

    await reconcileGitPendingWorktrees();

    expect(updated).toEqual([
      { ...listed, createdAt: '2026-04-26T00:00:00.000Z' },
    ]);
    expect(mockedStartProjectWorktreePostCreateSetup).not.toHaveBeenCalled();
    expect(mockedRollbackPersistedReservation).not.toHaveBeenCalled();
  });

  it('leaves a registered checkout that has no row untouched (CAN-3799 B4)', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'single-repo',
        id: 'project-1',
        name: 'Project 1',
        repoPath: '/repos/project-1',
        color: '#000000',
        worktrees: [],
        collapsed: false,
        order: 0,
      },
    ]);
    mockedStat.mockResolvedValue(existingPath());
    mockedListRegisteredWorktreePaths.mockResolvedValue(
      new Set(['/single/project-1/wt-unrecorded']),
    );

    await reconcileGitPendingWorktrees();

    expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
    expect(mockedRollbackPersistedReservation).not.toHaveBeenCalled();
    expect(mockedRollbackWorkspaceWorktree).not.toHaveBeenCalled();
    expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
    // Reconciliation reads no Git state for a project without pending rows.
    expect(mockedListRegisteredWorktreePaths).not.toHaveBeenCalled();
  });

  it('removes orphaned single-repo pending rows', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'single-repo',
        id: 'project-1',
        name: 'Project 1',
        repoPath: '/repos/project-1',
        color: '#000000',
        worktrees: [
          {
            id: 'wt-orphan',
            branchName: 'feature/test',
            createdAt: '2026-04-25T00:00:00.000Z',
            setupPhase: 'git-pending',
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);

    await reconcileGitPendingWorktrees();

    expect(mockedRollbackPersistedReservation).toHaveBeenCalledWith(
      'project-1',
      'wt-orphan',
      '/data/project-1/wt-orphan',
    );
    expect(mockedRm).toHaveBeenCalledWith('/single/project-1/wt-orphan', {
      recursive: true,
      force: true,
    });
    expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedArchiveMultiRepoWorktree).not.toHaveBeenCalled();
  });

  it('archives stale single-repo rows whose worktree directory is already gone', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'single-repo',
        id: 'project-1',
        name: 'Project 1',
        repoPath: '/repos/project-1',
        color: '#000000',
        worktrees: [
          {
            id: 'wt-stale',
            branchName: 'feature/stale',
            createdAt: '2026-04-25T00:00:00.000Z',
            setupPhase: 'git-ready',
            healthIssue: {
              status: 'broken',
              code: 'missing-worktree-path',
              message: 'Worktree directory does not exist.',
              checkedAt: '2026-04-26T00:00:00.000Z',
              worktreePath: '/single/project-1/wt-stale',
            },
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);

    await reconcileGitPendingWorktrees();

    // Ready rows with intact chats honor the retention gate on recovery —
    // recovery must not force a hard delete of retained data.
    expect(mockedArchiveSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: 'project-1',
      worktreeId: 'wt-stale',
      repoPath: '/repos/project-1',
    });
    expect(mockedRollbackPersistedReservation).not.toHaveBeenCalled();
    expect(sendToWindow).toHaveBeenCalledWith(null, 'worktrees:file-changed', {
      workspaceId: 'project-1',
    });
  });

  it('archives stale multi-repo rows whose worktree directory is already gone', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'multi-repo',
        id: 'ws-1',
        name: 'Workspace 1',
        color: '#000000',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
          },
        ],
        worktrees: [
          {
            id: 'wt-stale',
            branchName: 'feature/stale',
            createdAt: '2026-04-25T00:00:00.000Z',
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);

    await reconcileGitPendingWorktrees();

    expect(mockedArchiveMultiRepoWorktree).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      worktreeId: 'wt-stale',
    });
    expect(mockedRollbackWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it('keeps non-pending rows whose worktree directory still exists', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'single-repo',
        id: 'project-1',
        name: 'Project 1',
        repoPath: '/repos/project-1',
        color: '#000000',
        worktrees: [
          {
            id: 'wt-present',
            branchName: 'feature/present',
            createdAt: '2026-04-25T00:00:00.000Z',
            setupPhase: 'git-ready',
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);
    mockedStat.mockImplementation((path) => {
      if (path === '/single/project-1/wt-present') {
        return Promise.resolve(existingPath());
      }
      return Promise.reject(new Error(`missing ${String(path)}`));
    });

    await reconcileGitPendingWorktrees();

    expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedArchiveMultiRepoWorktree).not.toHaveBeenCalled();
  });

  it('preserves durable split-recovery rows without a checkout', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'single-repo',
        id: 'project-1',
        name: 'Project 1',
        repoPath: '/repos/project-1',
        color: '#000000',
        worktrees: [
          {
            id: 'wt-split-recovery',
            branchName: 'feature/recovery',
            createdAt: '2026-04-25T00:00:00.000Z',
            splitRecoveryRequired: true,
            healthIssue: {
              status: 'broken',
              code: 'git-error',
              message: 'Destination data was retained for recovery.',
              checkedAt: '2026-04-26T00:00:00.000Z',
              worktreePath: '/single/project-1/wt-split-recovery',
            },
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);

    await reconcileGitPendingWorktrees();

    expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedRollbackPersistedReservation).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('exposes interrupted split reservations without reaping migrated data', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'single-repo',
        id: 'project-1',
        name: 'Project 1',
        repoPath: '/repos/project-1',
        color: '#000000',
        worktrees: [
          {
            id: 'wt-interrupted-split',
            branchName: 'feature/recovery',
            createdAt: '2026-08-07T00:00:00.000Z',
            hidden: true,
            setupPhase: 'git-pending',
            splitRecoveryRequired: true,
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);

    await reconcileGitPendingWorktrees();

    expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-interrupted-split',
      expect.any(Function),
    );
    const updateCallback = mockedUpdateWorkspaceWorktree.mock.calls[0]?.[2];
    if (!updateCallback) {
      throw new Error('Expected interrupted split recovery updater');
    }
    expect(
      updateCallback({
        id: 'wt-interrupted-split',
        branchName: 'feature/recovery',
        createdAt: '2026-08-07T00:00:00.000Z',
        hidden: true,
        setupPhase: 'git-pending',
        splitRecoveryRequired: true,
      }),
    ).toMatchObject({
      id: 'wt-interrupted-split',
      splitRecoveryRequired: true,
      healthIssue: {
        status: 'broken',
        code: 'git-error',
      },
    });
    expect(
      updateCallback({
        id: 'wt-interrupted-split',
        branchName: 'feature/recovery',
        createdAt: '2026-08-07T00:00:00.000Z',
        hidden: true,
        setupPhase: 'git-pending',
        splitRecoveryRequired: true,
      }),
    ).not.toHaveProperty('hidden');
    expect(mockedRollbackPersistedReservation).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('removes partial multi-repo pending rows via project rollback', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'multi-repo',
        id: 'ws-1',
        name: 'Workspace 1',
        color: '#000000',
        sourceRepoPath: '/repos/ws-1',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
          },
          {
            id: 'repo-b',
            name: 'Repo B',
            repoPath: '/repos/repo-b',
          },
        ],
        worktrees: [
          {
            id: 'wt-partial',
            branchName: 'feature/test',
            createdAt: '2026-04-25T00:00:00.000Z',
            setupPhase: 'git-pending',
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);
    mockedStat.mockImplementation((path) => {
      if (
        path === '/multi/ws-1/wt-partial/root' ||
        path === '/multi/ws-1/wt-partial/repos/repo-a'
      ) {
        return Promise.resolve(existingPath());
      }
      return Promise.reject(new Error(`missing ${String(path)}`));
    });
    mockedListRegisteredWorktreePaths.mockImplementation((repoPath) => {
      if (repoPath === '/refs/ws-1') {
        return Promise.resolve(new Set(['/multi/ws-1/wt-partial/root']));
      }
      if (repoPath === '/repos/repo-a') {
        return Promise.resolve(
          new Set(['/multi/ws-1/wt-partial/repos/repo-a']),
        );
      }
      return Promise.resolve(new Set<string>());
    });

    await reconcileGitPendingWorktrees();

    expect(mockedRollbackWorkspaceWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-partial',
      '/multi/ws-1/wt-partial',
      [
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/repo-b' },
      ],
      ['repo-a', 'repo-b'],
      '/refs/ws-1',
    );
    expect(mockedRollbackPersistedReservation).toHaveBeenCalledWith(
      'ws-1',
      'wt-partial',
      '/data/ws-1/wt-partial',
    );
  });

  it("continues reconciling later rows when one row's validation throws", async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'single-repo',
        id: 'project-1',
        name: 'Project 1',
        repoPath: '/repos/project-1',
        color: '#000000',
        worktrees: [
          {
            id: 'wt-fail',
            branchName: 'feature/fail',
            createdAt: '2026-04-25T00:00:00.000Z',
            setupPhase: 'git-pending',
          },
        ],
        collapsed: false,
        order: 0,
      },
      {
        type: 'single-repo',
        id: 'project-2',
        name: 'Project 2',
        repoPath: '/repos/project-2',
        color: '#111111',
        worktrees: [
          {
            id: 'wt-ready',
            branchName: 'feature/ready',
            createdAt: '2026-04-25T00:00:00.000Z',
            setupPhase: 'git-pending',
          },
        ],
        collapsed: false,
        order: 1,
      },
    ]);
    mockedResolveProjectReferenceRepoPath
      .mockRejectedValueOnce(new Error('broken reference'))
      .mockResolvedValueOnce('/refs/project-2');
    mockedStat.mockImplementation((path) => {
      if (path === '/single/project-2/wt-ready') {
        return Promise.resolve(existingPath());
      }
      return Promise.reject(new Error(`missing ${String(path)}`));
    });
    mockedListRegisteredWorktreePaths.mockResolvedValue(
      new Set(['/single/project-2/wt-ready']),
    );

    await reconcileGitPendingWorktrees();

    expect(stderrWriteSpy).toHaveBeenCalled();
    expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledWith(
      'project-2',
      'wt-ready',
      expect.any(Function),
    );
  });

  it('replays project post-create setup when a pending multi-repo row is recovered', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'multi-repo',
        id: 'ws-1',
        name: 'Workspace 1',
        color: '#000000',
        sourceRepoPath: '/repos/ws-1',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
          },
        ],
        worktrees: [
          {
            id: 'wt-ready',
            branchName: 'feature/test',
            createdAt: '2026-04-25T00:00:00.000Z',
            setupPhase: 'git-pending',
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);
    mockedStat.mockImplementation((path) => {
      if (
        path === '/multi/ws-1/wt-ready/root' ||
        path === '/multi/ws-1/wt-ready/repos/repo-a'
      ) {
        return Promise.resolve(existingPath());
      }
      return Promise.reject(new Error(`missing ${String(path)}`));
    });
    mockedListRegisteredWorktreePaths.mockImplementation((repoPath) => {
      if (repoPath === '/refs/ws-1') {
        return Promise.resolve(new Set(['/multi/ws-1/wt-ready/root']));
      }
      if (repoPath === '/repos/repo-a') {
        return Promise.resolve(new Set(['/multi/ws-1/wt-ready/repos/repo-a']));
      }
      return Promise.resolve(new Set<string>());
    });

    await reconcileGitPendingWorktrees();

    expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-ready',
      expect.any(Function),
    );
    const updateCallback = mockedUpdateWorkspaceWorktree.mock.calls[0]?.[2];
    if (!updateCallback) {
      throw new Error('Expected update callback to be provided');
    }
    expect(
      updateCallback({
        id: 'wt-ready',
        branchName: 'reserved-name',
        createdAt: '2026-04-25T00:00:00.000Z',
        setupPhase: 'git-pending',
      }),
    ).toEqual({
      id: 'wt-ready',
      branchName: 'feature/test',
      createdAt: '2026-04-25T00:00:00.000Z',
      setupPhase: 'git-ready',
    });
    expect(mockedStartWorkspaceWorktreePostCreateSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        worktreeId: 'wt-ready',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
          },
        ],
      }),
    );
  });

  it('tracks the held recovered single-repo post-create setup without awaiting it', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'single-repo',
        id: 'project-1',
        name: 'Project 1',
        repoPath: '/repos/project-1',
        color: '#000000',
        worktrees: [
          {
            id: 'wt-ready',
            branchName: 'feature/test',
            createdAt: '2026-04-25T00:00:00.000Z',
            setupPhase: 'git-pending',
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);
    mockedStat.mockImplementation((path) => {
      if (path === '/single/project-1/wt-ready') {
        return Promise.resolve(existingPath());
      }
      return Promise.reject(new Error(`missing ${String(path)}`));
    });
    mockedListRegisteredWorktreePaths.mockResolvedValue(
      new Set(['/single/project-1/wt-ready']),
    );
    let releaseSetup: (() => void) | undefined;
    let setupFinished = false;
    mockedStartProjectWorktreePostCreateSetup.mockImplementation(() =>
      new Promise<void>((resolve) => {
        releaseSetup = resolve;
      }).then(() => {
        setupFinished = true;
      }),
    );

    await reconcileGitPendingWorktrees();
    let settled = false;
    const settling = settleDetachedWork().then(() => {
      settled = true;
    });
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(mockedStartProjectWorktreePostCreateSetup).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releaseSetup?.();
    await settling;

    expect(settled).toBe(true);
    expect(setupFinished).toBe(true);
  });

  it('tracks the held recovered multi-repo post-create setup without awaiting it', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'multi-repo',
        id: 'ws-1',
        name: 'Workspace 1',
        color: '#000000',
        sourceRepoPath: '/repos/ws-1',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
          },
        ],
        worktrees: [
          {
            id: 'wt-ready',
            branchName: 'feature/test',
            createdAt: '2026-04-25T00:00:00.000Z',
            setupPhase: 'git-pending',
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);
    mockedStat.mockImplementation((path) => {
      if (
        path === '/multi/ws-1/wt-ready/root' ||
        path === '/multi/ws-1/wt-ready/repos/repo-a'
      ) {
        return Promise.resolve(existingPath());
      }
      return Promise.reject(new Error(`missing ${String(path)}`));
    });
    mockedListRegisteredWorktreePaths.mockImplementation((repoPath) => {
      if (repoPath === '/refs/ws-1') {
        return Promise.resolve(new Set(['/multi/ws-1/wt-ready/root']));
      }
      if (repoPath === '/repos/repo-a') {
        return Promise.resolve(new Set(['/multi/ws-1/wt-ready/repos/repo-a']));
      }
      return Promise.resolve(new Set<string>());
    });
    let releaseSetup: (() => void) | undefined;
    let setupFinished = false;
    mockedStartWorkspaceWorktreePostCreateSetup.mockImplementation(() =>
      new Promise<void>((resolve) => {
        releaseSetup = resolve;
      }).then(() => {
        setupFinished = true;
      }),
    );

    await reconcileGitPendingWorktrees();
    let settled = false;
    const settling = settleDetachedWork().then(() => {
      settled = true;
    });
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(mockedStartWorkspaceWorktreePostCreateSetup).toHaveBeenCalledTimes(
      1,
    );
    expect(settled).toBe(false);

    releaseSetup?.();
    await settling;

    expect(settled).toBe(true);
    expect(setupFinished).toBe(true);
  });

  it('promotes an interrupted root-only restore without requiring child repos', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'multi-repo',
        id: 'ws-1',
        name: 'Workspace 1',
        color: '#000000',
        sourceRepoPath: '/repos/ws-1',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
          },
        ],
        worktrees: [
          {
            id: 'wt-root-only',
            branchName: 'feature/root-only',
            createdAt: '2026-08-07T00:00:00.000Z',
            setupPhase: 'git-pending',
            includedRepoIds: [],
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);
    mockedStat.mockImplementation((path) =>
      path === '/multi/ws-1/wt-root-only/root'
        ? Promise.resolve(existingPath())
        : Promise.reject(new Error(`missing ${String(path)}`)),
    );
    mockedListRegisteredWorktreePaths.mockImplementation((repoPath) =>
      repoPath === '/refs/ws-1'
        ? Promise.resolve(new Set(['/multi/ws-1/wt-root-only/root']))
        : Promise.resolve(new Set<string>()),
    );

    await reconcileGitPendingWorktrees();

    expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-root-only',
      expect.any(Function),
    );
    expect(mockedRollbackWorkspaceWorktree).not.toHaveBeenCalled();
    expect(mockedStartWorkspaceWorktreePostCreateSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        worktreeId: 'wt-root-only',
        repos: [],
      }),
    );
  });
});
