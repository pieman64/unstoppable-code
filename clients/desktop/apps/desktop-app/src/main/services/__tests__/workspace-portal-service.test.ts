import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
jest.mock('../sidebar-item-groups-service', () => ({
  projectSidebarItemGroups: jest.fn(() => Promise.resolve(undefined)),
}));
jest.mock('../../lib/sidebar-items', () => {
  const readAllSidebarItems = jest.fn<Promise<SidebarItemsFile>, []>();
  return {
    readAllSidebarItems,
    readAllSidebarItemsSnapshot: (): Promise<SidebarItemsSnapshot> =>
      readAllSidebarItems().then((file) => ({
        file,
        authority: 'ok',
        indexAuthority: 'ok',
        indexedWorkspaceIds: file.items.map((item) => item.id),
        workspaceReads: new Map(),
        storedFields: [],
      })),
  };
});

jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));

jest.mock('../worktree-diff-stats-cache', () => ({
  getCachedWorktreeDiffStats: jest.fn(),
}));

jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceWorktrees: jest.fn(),
}));

jest.mock('../worktree-runtime-status-service', () => ({
  getWorktreeRuntimeStatuses: jest.fn(() => Promise.resolve(new Map())),
}));

jest.mock('../project-avatar-cache', () => ({
  readProjectAvatarUrl: jest.fn(),
  retainProjectAvatarRepoPaths: jest.fn(),
}));

import { projectSidebarItemGroups } from '../sidebar-item-groups-service';
import type {
  PortalSessionShellState,
  SidebarItem,
  SidebarItemsFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { readPreferencesFile } from '../../lib/preferences-store';
import {
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
  spaceNotificationScopeKey,
} from '@canopy/desktop-shared/lib/space-notification-policy';
import { publishSpaceNotificationPolicy } from '../../lib/space-notification-gate';
import {
  readAllSidebarItems,
  type SidebarItemsSnapshot,
} from '../../lib/sidebar-items';
import * as w5FileStore from '../../lib/w5-commit-log-file-store';
import {
  assertOutsideW5ReadView,
  W5ReadViewWriteRefusedError,
} from '../../lib/w5-read-view';
import { getCachedWorktreeDiffStats } from '../worktree-diff-stats-cache';
import { readWorkspaceWorktrees } from '../../lib/workspace-persistence';
import {
  getWorktreeRuntimeStatuses,
  type WorktreeRuntimeStatus,
} from '../worktree-runtime-status-service';
import {
  readProjectAvatarUrl,
  retainProjectAvatarRepoPaths,
} from '../project-avatar-cache';
import {
  projectWorktreeSnapshot,
  getWorkspacePortalWorktreeEntity,
  listWorkspacePortalEntities,
} from '../workspace-portal-service';
import {
  clearSplitPrRuntimeProjection,
  setSplitPrRuntimeProjection,
} from '../split-pr-runtime-projection';
import { acquireSplitLock, releaseSplitLock } from '../split-lock-service';
import {
  markWorkspaceTargetRemovalPending,
  resetWorkspaceTargetExclusionsForTests,
} from '../../lib/workspace-target-exclusion';

const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedGetCachedWorktreeDiffStats = jest.mocked(
  getCachedWorktreeDiffStats,
);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedGetWorktreeRuntimeStatuses = jest.mocked(
  getWorktreeRuntimeStatuses,
);
const mockedReadProjectAvatarUrl = jest.mocked(readProjectAvatarUrl);
const mockedRetainProjectAvatarRepoPaths = jest.mocked(
  retainProjectAvatarRepoPaths,
);

function diffStatsResult(
  insertions: number,
  deletions: number,
): {
  insertions: number;
  deletions: number;
  refreshedAt: number;
  generation: number;
} {
  return { insertions, deletions, refreshedAt: 1, generation: 0 };
}

type PreferencesFixture = Awaited<ReturnType<typeof readPreferencesFile>>;

function partialPreferences(
  preferences: Partial<PreferencesFixture>,
): PreferencesFixture {
  // A partial fixture: these tests rely on unset preferences staying undefined.
  return preferences as PreferencesFixture;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('project portal service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetWorkspaceTargetExclusionsForTests();
    mockedGetWorktreeRuntimeStatuses.mockResolvedValue(new Map());
    mockedReadPreferencesFile.mockResolvedValue(
      partialPreferences({
        branchDisplayMappings: [],
      }),
    );
    // Default: no line changes. Individual tests override per worktree.
    mockedGetCachedWorktreeDiffStats.mockReturnValue(diffStatsResult(0, 0));
  });

  afterEach(() => {
    clearSplitPrRuntimeProjection('workspace-lock', 'worktree-lock');
    releaseSplitLock('workspace-lock', 'worktree-lock');
  });

  it('reads the sidebar in one workspace-discovering view, including the direct-store fallback', async () => {
    const readView = jest.spyOn(w5FileStore, 'runW5ReadView');
    mockedReadAllSidebarItems.mockImplementationOnce(() => {
      expect(assertOutsideW5ReadView).toThrow(W5ReadViewWriteRefusedError);
      return Promise.resolve({ version: 1, items: [] });
    });
    try {
      await expect(listWorkspacePortalEntities()).resolves.toEqual([]);
      expect(readView).toHaveBeenCalledTimes(1);
      expect(readView).toHaveBeenCalledWith(
        { files: [], discoverWorkspaces: true },
        expect.any(Function),
      );
      expect(assertOutsideW5ReadView).not.toThrow();
    } finally {
      readView.mockRestore();
    }
  });

  it('propagates sidebar read errors and closes the read view', async () => {
    const failure = new Error('Sidebar unavailable');
    mockedReadAllSidebarItems.mockImplementationOnce(() => {
      expect(assertOutsideW5ReadView).toThrow(W5ReadViewWriteRefusedError);
      return Promise.reject(failure);
    });
    await expect(listWorkspacePortalEntities()).rejects.toBe(failure);
    expect(assertOutsideW5ReadView).not.toThrow();
  });

  it.each([undefined, 'invalid', '2026-09-06T00:00:00Z'])(
    'projects durable activity with a creation fallback (%s)',
    (lastTouchedAt) => {
      const createdAt = '2026-09-05T00:00:00Z';
      const snapshot = projectWorktreeSnapshot({
        workspaceLocalId: 'workspace-a',
        worktree: {
          id: 'wt-1',
          branchName: 'feature/activity',
          status: 'active',
          createdAt,
          lastTouchedAt,
        },
        siblingWorktrees: [],
        projectType: 'single-repo',
      });
      expect(snapshot.lastActivityAt).toBe(
        lastTouchedAt && Number.isFinite(Date.parse(lastTouchedAt))
          ? lastTouchedAt
          : createdAt,
      );
    },
  );

  it('explicitly clears inactive merge progress in a fresh worktree snapshot', () => {
    expect(
      projectWorktreeSnapshot({
        workspaceLocalId: 'workspace-a',
        worktree: {
          id: 'wt-1',
          branchName: 'feature/merge',
          createdAt: '2026-09-05T00:00:00Z',
          status: 'active',
        },
        siblingWorktrees: [],
        projectType: 'single-repo',
      }),
    ).toEqual(
      expect.objectContaining({ mergingPr: false, mergePrPhase: null }),
    );
  });

  it.each([
    ['2026-09-04T00:00:00Z', '2026-09-06T00:00:00Z'],
    ['2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z'],
    ['invalid', '2026-09-06T00:00:00Z'],
  ])(
    'keeps the freshest durable or runtime activity (%s)',
    (runtimeActivityAt, expected) => {
      const snapshot = projectWorktreeSnapshot({
        workspaceLocalId: 'workspace-a',
        worktree: {
          id: 'wt-1',
          branchName: 'feature/activity',
          status: 'active',
          createdAt: '2026-09-05T00:00:00Z',
          lastTouchedAt: '2026-09-06T00:00:00Z',
        },
        siblingWorktrees: [],
        projectType: 'single-repo',
        runtimeStatus: { lastActivityAt: runtimeActivityAt },
      });
      expect(snapshot.lastActivityAt).toBe(expected);
    },
  );

  it('projects the registered notification space id for web and mobile', () => {
    const worktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/notify',
      createdAt: '2026-09-05T00:00:00Z',
      status: 'active',
    };
    const project = (): ReturnType<typeof projectWorktreeSnapshot> =>
      projectWorktreeSnapshot({
        workspaceLocalId: 'workspace-a',
        worktree,
        siblingWorktrees: [],
        projectType: 'single-repo',
      });
    expect(project()).not.toHaveProperty('notificationSpaceId');
    publishSpaceNotificationPolicy({
      ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
      accountKey: 'user-1',
      spaces: {
        [spaceNotificationScopeKey({
          projectId: 'workspace-a',
          worktreeId: 'wt-1',
        })]: {
          notificationSpaceId: 'space-1',
          revision: 0,
          override: null,
          transitions: [],
        },
      },
    });
    try {
      expect(project()).toEqual(
        expect.objectContaining({ notificationSpaceId: 'space-1' }),
      );
    } finally {
      publishSpaceNotificationPolicy(EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT);
    }
  });

  it('always derives the projected split lock from the lock service', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-lock',
        name: 'Workspace',
        color: '#000000',
        repoPath: '/repo',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'worktree-lock',
            branchName: 'feature/lock',
            createdAt: '2026-07-31T00:00:00.000Z',
            status: 'active',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });
    setSplitPrRuntimeProjection(
      'workspace-lock',
      'worktree-lock',
      'running',
      'Creating child PRs',
    );

    const unlocked = (
      await listWorkspacePortalEntities({
        workspaceLocalId: 'workspace-lock',
        worktreeLocalId: 'worktree-lock',
      })
    ).find((entity) => entity.entityType === 'worktree');
    expect(unlocked?.payload).toMatchObject({
      splitPrStatus: 'running',
      splitPrLocked: false,
    });

    acquireSplitLock('workspace-lock', 'worktree-lock');
    const locked = (
      await listWorkspacePortalEntities({
        workspaceLocalId: 'workspace-lock',
        worktreeLocalId: 'worktree-lock',
      })
    ).find((entity) => entity.entityType === 'worktree');
    expect(locked?.payload).toMatchObject({
      splitPrStatus: 'running',
      splitPrLocked: true,
    });
  });

  it('projects scoped worktree runtime status without setting busy', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'snake',
            branchName: 'feature/runtime',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
          {
            id: 'otter',
            branchName: 'feature/other',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });
    mockedGetWorktreeRuntimeStatuses.mockResolvedValue(
      new Map([
        [
          'workspace-1\0snake',
          {
            isStreaming: true,
            hasUnread: true,
            awaitingApproval: true,
            lastActivityAt: '2026-07-27T10:20:30.000Z',
            pipelineStatus: 'running',
            terminalStatus: 'running',
            scriptStatus: 'running',
            hookStatus: 'running',
            isRunningRun: true,
          },
        ],
      ]),
    );

    const entities = await listWorkspacePortalEntities({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    });
    const worktree = entities.find(
      (entity) =>
        entity.entityType === 'worktree' && entity.localId === 'snake',
    );

    const runtimeCall = mockedGetWorktreeRuntimeStatuses.mock.calls[0];
    expect(
      runtimeCall?.[0].map(({ workspaceId, worktree: item }) => ({
        workspaceId,
        worktreeId: item.id,
      })),
    ).toEqual([
      { workspaceId: 'workspace-1', worktreeId: 'snake' },
      { workspaceId: 'workspace-1', worktreeId: 'otter' },
    ]);
    expect(runtimeCall?.[1]).toEqual({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    });
    expect(worktree?.payload).toMatchObject({
      isStreaming: true,
      hasUnread: true,
      awaitingApproval: true,
      lastActivityAt: '2026-07-27T10:20:30.000Z',
      pipelineStatus: 'running',
      terminalStatus: 'running',
      scriptStatus: 'running',
      hookStatus: 'running',
      isRunningRun: true,
    });
    expect(worktree?.payload).not.toHaveProperty('busy');
    expect(entities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'worktree',
          localId: 'otter',
        }),
      ]),
    );
  });

  it('keeps desktop project and worktree snapshots in parity with portal entities', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        color: '#000000',
        repoPath: '/repo',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'child',
            branchName: 'feature/child',
            label: 'Child task',
            createdAt: '2026-07-30T00:00:00.000Z',
            status: 'active',
            hidden: true,
            setupPhase: 'git-pending',
            branchGroupingParentWorktreeId: 'parent',
            healthIssue: {
              status: 'broken',
              code: 'missing-worktree-path',
              message: 'missing checkout',
              checkedAt: '2026-07-30T00:00:00.000Z',
              worktreePath: '/worktrees/child',
            },
            lastKnownPrStatus: {
              repos: [{ repoId: 'repo-1', repoName: 'Repo', status: null }],
              lastCheckedAt: '2026-07-30T00:00:00.000Z',
            },
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });
    mockedGetCachedWorktreeDiffStats.mockReturnValue(diffStatsResult(9, 4));
    mockedGetWorktreeRuntimeStatuses.mockResolvedValue(
      new Map([
        [
          'workspace-1\0child',
          {
            isStreaming: true,
            hasUnread: true,
            awaitingApproval: true,
            pipelineStatus: 'paused',
            terminalStatus: 'running',
          },
        ],
      ]),
    );
    const workspaceSnapshots: PortalSessionShellState['workspaces'] = [];
    const snapshots: PortalSessionShellState['worktrees'] = [];

    const entities = await listWorkspacePortalEntities(undefined, {
      onWorkspace: (workspace): void => {
        workspaceSnapshots.push(workspace);
      },
      onWorktree: (worktree): void => {
        snapshots.push(worktree);
      },
    });
    const workspaceEntity = entities.find(
      (candidate) => candidate.entityType === 'workspace',
    );
    const worktreeEntity = entities.find(
      (candidate) => candidate.entityType === 'worktree',
    );

    expect(workspaceSnapshots).toHaveLength(1);
    const { localId: workspaceLocalId, ...workspacePayload } =
      workspaceSnapshots[0];
    expect(workspaceEntity).toMatchObject({
      localId: workspaceLocalId,
      payload: workspacePayload,
    });
    expect(snapshots).toHaveLength(1);
    const { localId, ...worktreePayload } = snapshots[0];
    expect(worktreeEntity).toMatchObject({
      localId,
      payload: {
        ...worktreePayload,
        worktreeLocalId: localId,
        branchName: worktreePayload.branch,
      },
    });
    expect(worktreeEntity?.payload).not.toHaveProperty('localId');
  });

  it('projects worktree branchName as the portal branch without falling back to the animal id label', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      partialPreferences({
        branchDisplayMappings: [
          {
            id: 'builtin-branch-type',
            label: 'Strip branch type',
            matcher: '',
            result: '',
            settings: { replaceHyphens: true, capitalize: true },
            enabled: true,
            builtin: true,
            examples: [],
            readonlyExampleCount: 0,
          },
        ],
      }),
    );

    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: false,
        order: 2,
        worktrees: [
          {
            id: 'snake',
            branchName: 'feature/portal-sync',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    });

    const worktree = entities.find(
      (entity) =>
        entity.entityType === 'worktree' && entity.localId === 'snake',
    );
    expect(worktree).toMatchObject({
      entityType: 'worktree',
      localId: 'snake',
      parentLocalId: 'workspace-1',
      payload: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        branch: 'feature/portal-sync',
        branchName: 'feature/portal-sync',
        status: 'active',
      },
    });
    // The desktop sidebar maps branches through the (builtin + user)
    // branch-display rules; the portal entity now carries the same
    // human-friendly label so the web rail matches the desktop.
    expect((worktree?.payload as { label?: string } | undefined)?.label).toBe(
      'Portal Sync',
    );
  });

  it('projects the persisted done lifecycle status used by the desktop sidebar', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: false,
        order: 1,
        worktrees: [
          {
            id: 'snake',
            branchName: 'feature/merged',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'done',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();
    const worktree = entities.find(
      (entity) => entity.entityType === 'worktree',
    );

    expect(worktree?.payload).toMatchObject({ status: 'done' });
  });

  it('keeps the multi-repo tracked-base-branch fallback on the entity payload', async () => {
    // `projectWorktreeSnapshot` resolves the base branch from
    // `trackedRepoBaseBranches` when the worktree has no top-level
    // `trackedBaseBranch`. `worktreeToPortalEntity` then re-assigned the raw
    // record field over it, so the resolved fallback was replaced with
    // `undefined` and the portal lost the breadcrumb for worktrees with no PR.
    // The fallback only applies to multi-repo workspaces, which is exactly
    // where the top-level `trackedBaseBranch` is absent.
    const items: SidebarItem[] = [
      {
        type: 'multi-repo',
        id: 'workspace-multi',
        name: 'Multi Workspace',
        color: '#000000',
        collapsed: false,
        order: 0,
        repos: [
          { id: 'repo-1', name: 'Repo One', repoPath: '/repos/repo-one' },
        ],
        worktrees: [
          {
            id: 'fallback-only',
            branchName: 'feature/child',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
            trackedRepoBaseBranches: { 'repo-1': 'develop' },
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();
    const worktree = entities.find(
      (entity) => entity.entityType === 'worktree',
    );

    expect(worktree?.payload).toMatchObject({
      trackedBaseBranch: 'develop',
    });
  });

  it('projects timestamped default worktree branches with the friendly portal label', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: false,
        order: 1,
        worktrees: [
          {
            id: 'snake',
            branchName: 'snake-1713571200123',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    });

    const worktree = entities.find(
      (entity) => entity.entityType === 'worktree',
    );
    expect(worktree?.payload).toMatchObject({
      branch: 'snake-1713571200123',
      branchName: 'snake-1713571200123',
      label: 'New worktree',
    });
  });

  it('surfaces sidebar order, collapse state, and paused hook keys on project and worktree entities', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: true,
        order: 3,
        worktrees: [
          {
            id: 'parent-worktree',
            branchName: 'feature/parent',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
          {
            id: 'snake',
            branchName: 'feature/portal-sync',
            branchGroupingParentWorktreeId: 'parent-worktree',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
            pausedHookKeys: ['hook-a', 'hook-b'],
            lastKnownPrStatus: {
              repos: [{ repoId: 'repo-1', repoName: 'Repo One', status: null }],
              lastCheckedAt: '2026-05-08T00:00:00.000Z',
            },
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();

    const workspace = entities.find(
      (entity) => entity.entityType === 'workspace',
    );
    expect(workspace?.payload).toMatchObject({
      order: 3,
      collapsed: true,
      repos: [],
    });

    const worktree = entities.find(
      (entity) =>
        entity.entityType === 'worktree' && entity.localId === 'snake',
    );
    expect(worktree?.payload).toMatchObject({
      branchGroupingParentWorktreeId: 'parent-worktree',
      pausedHookKeys: ['hook-a', 'hook-b'],
      lastKnownPrStatus: {
        repos: [{ repoId: 'repo-1', repoName: 'Repo One', status: null }],
        lastCheckedAt: '2026-05-08T00:00:00.000Z',
      },
    });
  });

  it.each([true, undefined])(
    'projects only known queue membership (%s) into the worktree shell state',
    async (inQueue) => {
      const items: SidebarItem[] = [
        {
          type: 'single-repo',
          id: 'workspace-1',
          name: 'Workspace',
          repoPath: '/repo',
          color: '#123456',
          collapsed: false,
          order: 0,
          worktrees: [
            {
              id: 'queued',
              branchName: 'feature/queued',
              createdAt: '2026-10-06T00:00:00.000Z',
              status: 'active',
              lastKnownPrStatus: {
                repos: [
                  {
                    repoId: 'repo-1',
                    repoName: 'Repo One',
                    status: {
                      prNumber: 42,
                      prUrl: 'https://github.com/acme/repo/pull/42',
                      state: 'open',
                      title: 'Queued PR',
                      checkStatus: 'passing',
                      checkDetails: [],
                      reviewStatus: 'approved',
                      reviewers: [],
                      hasConflicts: false,
                      commentCount: 0,
                      mergeQueue: {
                        required: true,
                        inQueue,
                        position: 2,
                        phase: 'awaiting_checks',
                      },
                      updatedAt: '2026-10-06T00:00:00.000Z',
                    },
                  },
                ],
                lastCheckedAt: '2026-10-06T00:00:00.000Z',
              },
            },
          ],
        },
      ];
      mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

      const entities = await listWorkspacePortalEntities();

      const worktree = entities.find(
        (entity) =>
          entity.entityType === 'worktree' && entity.localId === 'queued',
      );
      expect(worktree?.payload).toMatchObject({
        lastKnownPrStatus: {
          repos: [
            {
              repoId: 'repo-1',
              status: {
                prNumber: 42,
              },
            },
          ],
        },
      });
      const queueState = JSON.stringify(worktree?.payload);
      if (inQueue === true) {
        expect(queueState).toContain('\"inQueue\":true');
        expect(queueState).toContain('awaiting_checks');
      } else {
        expect(queueState).not.toContain('mergeQueue');
      }
    },
  );

  it('derives worktree grouping parents from tracked base branches and prefers a retained override', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'base',
            branchName: 'feature/base',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
          {
            id: 'retained-parent',
            branchName: 'feature/retained',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
          {
            id: 'derived-child',
            branchName: 'feature/derived-child',
            trackedBaseBranch: 'feature/base',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
          {
            id: 'retained-child',
            branchName: 'feature/retained-child',
            trackedBaseBranch: 'feature/base',
            branchGroupingParentWorktreeId: 'retained-parent',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
          {
            id: 'unmatched-child',
            branchName: 'feature/unmatched-child',
            trackedBaseBranch: 'feature/missing',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();
    const payloadById = new Map(
      entities
        .filter((entity) => entity.entityType === 'worktree')
        .map((entity) => [entity.localId, entity.payload]),
    );

    expect(payloadById.get('derived-child')).toMatchObject({
      branchGroupingParentWorktreeId: 'base',
    });
    expect(payloadById.get('retained-child')).toMatchObject({
      branchGroupingParentWorktreeId: 'retained-parent',
    });
    expect(payloadById.get('unmatched-child')).not.toHaveProperty(
      'branchGroupingParentWorktreeId',
    );
  });

  it('derives the grouping parent in the targeted worktree projector', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'parent',
        branchName: 'feature/parent',
        createdAt: '2026-05-08T00:00:00.000Z',
        status: 'active',
      },
      {
        id: 'child',
        branchName: 'feature/child',
        trackedBaseBranch: 'feature/parent',
        createdAt: '2026-05-08T00:00:00.000Z',
        status: 'active',
      },
    ]);

    const entity = await getWorkspacePortalWorktreeEntity(
      'workspace-1',
      'child',
      {},
    );

    expect(entity?.payload).toMatchObject({
      branchGroupingParentWorktreeId: 'parent',
    });
  });

  it('surfaces persisted setupPhase and leaves runtime-only badge fields undefined', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'snake',
            branchName: 'feature/portal-setup',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
            setupPhase: 'git-pending',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();

    const worktree = entities.find(
      (entity) => entity.entityType === 'worktree',
    );
    const payload = worktree?.payload as Record<string, unknown>;
    expect(payload.setupPhase).toBe('git-pending');
    // Runtime-only badges have no main-process source yet; they MUST stay
    // off the wire so the renderer's "field omitted → no badge" branch wins.
    expect(payload.pipelineStatus).toBeUndefined();
    expect(payload.terminalStatus).toBeUndefined();
    expect(payload.isStreaming).toBeUndefined();
    expect(payload.isRunningRun).toBeUndefined();
    expect(payload.isDiscovering).toBeUndefined();
    expect(payload.awaitingApproval).toBeUndefined();
    expect(payload.hasUnread).toBeUndefined();
    expect(payload.lastActivityAt).toBe('2026-05-08T00:00:00.000Z');
  });

  it('projects a deferred git failure message as the portal warning reason', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        color: '#000000',
        repoPath: '/repo',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'snake',
            branchName: 'feature/portal-setup',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
            setupPhase: 'git-ready',
            healthIssue: {
              status: 'broken',
              code: 'git-error',
              message: 'Worktree setup failed. Check the repository state.',
              checkedAt: '2026-05-08T00:00:01.000Z',
              worktreePath: '/worktrees/snake',
            },
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();

    expect(
      entities.find((entity) => entity.entityType === 'worktree')?.payload,
    ).toMatchObject({
      healthIssue: {
        status: 'broken',
        reason: 'Worktree setup failed. Check the repository state.',
      },
    });
  });

  it('projects worktree diffStats from the desktop diff-stat source', async () => {
    mockedGetCachedWorktreeDiffStats.mockReturnValue(diffStatsResult(42, 7));

    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'snake',
            branchName: 'feature/portal-diff',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();

    // The projector reads diff stats from the same source the desktop sidebar
    // batch uses, without a remote fetch round-trip.
    expect(mockedGetCachedWorktreeDiffStats).toHaveBeenCalledWith(
      'workspace-1',
      'snake',
    );
    const worktree = entities.find(
      (entity) => entity.entityType === 'worktree',
    );
    expect(worktree?.payload).toMatchObject({
      diffStats: { insertions: 42, deletions: 7 },
    });
  });

  it('skips subprocess-backed diff stats for the overview projection without changing entity order', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'snake',
            branchName: 'feature/portal-fast-overview',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
          {
            id: 'otter',
            branchName: 'feature/portal-order',
            createdAt: '2026-05-09T00:00:00.000Z',
            status: 'active',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities(undefined, {
      includeDiffStats: false,
    });

    expect(mockedGetCachedWorktreeDiffStats).not.toHaveBeenCalled();
    expect(
      entities.map((entity) => `${entity.entityType}:${entity.localId}`),
    ).toEqual(['workspace:workspace-1', 'worktree:snake', 'worktree:otter']);
  });

  it('omits diffStats when the diff-stat source throws', async () => {
    mockedGetCachedWorktreeDiffStats.mockReturnValue(undefined);

    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'snake',
            branchName: 'feature/portal-diff',
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();
    const worktree = entities.find(
      (entity) => entity.entityType === 'worktree',
    );
    expect(worktree?.payload).not.toHaveProperty('diffStats');
  });

  it('forwards persisted activitySectionOrder onto the project payload', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: '#123456',
        collapsed: false,
        order: 0,
        worktrees: [],
        activitySectionOrder: ['summary', 'changed-files', 'plans'],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();
    const workspace = entities.find(
      (entity) => entity.entityType === 'workspace',
    );
    expect(workspace?.payload).toMatchObject({
      activitySectionOrder: ['summary', 'changed-files', 'plans'],
    });
  });

  // CAN-3053 regression: the shared rail (desktop and portal alike) reads
  // project headers from this projection, so the GitHub owner avatar the
  // legacy desktop icon resolved in the renderer has to ride on the row.
  it('projects the cached GitHub owner avatar onto single-repo projects only', async () => {
    const avatarUrl = 'https://github.com/unstoppabledomains.png?size=32';
    mockedReadProjectAvatarUrl.mockImplementation((repoPath) =>
      repoPath === '/repos/canopy' ? avatarUrl : undefined,
    );
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'canopy',
        name: 'canopy',
        color: '#000000',
        repoPath: '/repos/canopy',
        collapsed: false,
        order: 0,
        worktrees: [],
      },
      {
        type: 'single-repo',
        id: 'gitlab-project',
        name: 'GitLab project',
        color: '#000000',
        repoPath: '/repos/gitlab-project',
        collapsed: false,
        order: 1,
        worktrees: [],
      },
      {
        type: 'multi-repo',
        id: 'suite',
        name: 'Suite',
        color: '#000000',
        collapsed: false,
        order: 2,
        repos: [{ id: 'repo-1', name: 'canopy', repoPath: '/repos/canopy' }],
        worktrees: [],
      },
      {
        type: 'cowork',
        id: 'notes',
        name: 'Notes',
        color: '#000000',
        collapsed: false,
        order: 3,
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();
    const payloadOf = (localId: string): unknown =>
      entities.find(
        (entity) =>
          entity.entityType === 'workspace' && entity.localId === localId,
      )?.payload;

    expect(payloadOf('canopy')).toMatchObject({ avatarUrl });
    expect(payloadOf('gitlab-project')).not.toHaveProperty('avatarUrl');
    expect(payloadOf('suite')).not.toHaveProperty('avatarUrl');
    expect(payloadOf('notes')).not.toHaveProperty('avatarUrl');
    expect(mockedReadProjectAvatarUrl).toHaveBeenCalledTimes(2);
  });

  // A deleted or renamed project must not keep its avatar entry forever: an
  // unscoped pass names every live single-repo project, so it prunes the rest.
  // A scoped pass sees one workspace and must never prune the others.
  it('prunes the avatar cache to the projects an unscoped pass names', async () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'canopy',
        name: 'canopy',
        color: '#000000',
        repoPath: '/repos/canopy',
        collapsed: false,
        order: 0,
        worktrees: [],
      },
      {
        type: 'single-repo',
        id: 'site',
        name: 'Site',
        color: '#000000',
        repoPath: '/repos/site',
        collapsed: false,
        order: 1,
        worktrees: [],
      },
      {
        type: 'cowork',
        id: 'notes',
        name: 'Notes',
        color: '#000000',
        collapsed: false,
        order: 2,
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    await listWorkspacePortalEntities();
    expect(mockedRetainProjectAvatarRepoPaths).toHaveBeenCalledTimes(1);
    expect(mockedRetainProjectAvatarRepoPaths).toHaveBeenCalledWith(
      new Set(['/repos/canopy', '/repos/site']),
    );

    mockedRetainProjectAvatarRepoPaths.mockClear();
    await listWorkspacePortalEntities({ workspaceLocalId: 'canopy' });
    expect(mockedRetainProjectAvatarRepoPaths).not.toHaveBeenCalled();
  });

  it('emits repo metadata for multi-repo projects', async () => {
    const items: SidebarItem[] = [
      {
        type: 'multi-repo',
        id: 'workspace-multi',
        name: 'Multi Workspace',
        color: '#abcdef',
        collapsed: false,
        order: 0,
        repos: [
          {
            id: 'repo-1',
            name: 'Repo One',
            repoPath: '/repos/repo-one',
          },
          {
            id: 'repo-2',
            name: 'Repo Two',
            repoPath: '/repos/repo-two',
          },
        ],
        worktrees: [],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();

    const workspace = entities.find(
      (entity) => entity.entityType === 'workspace',
    );
    expect(workspace?.payload).toMatchObject({
      repos: [
        { id: 'repo-1', name: 'Repo One', repoPath: '/repos/repo-one' },
        { id: 'repo-2', name: 'Repo Two', repoPath: '/repos/repo-two' },
      ],
    });
  });

  it('exposes the resolved multi-repo base branch on the worktree entity payload', async () => {
    const items: SidebarItem[] = [
      {
        type: 'multi-repo',
        id: 'workspace-multi',
        name: 'Multi Workspace',
        color: '#abcdef',
        collapsed: false,
        order: 0,
        repos: [
          { id: 'repo-1', name: 'Repo One', repoPath: '/repos/repo-one' },
        ],
        worktrees: [
          {
            id: 'multi-child',
            branchName: 'feature/multi-child',
            // Multi-repo worktrees carry their base per repo, so the flat
            // trackedBaseBranch field is absent — the entity payload must still
            // expose the value resolveTrackedBaseBranchFallback derives.
            trackedRepoBaseBranches: { 'repo-1': 'develop' },
            createdAt: '2026-05-08T00:00:00.000Z',
            status: 'active',
          },
        ],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();
    const worktree = entities.find(
      (entity) =>
        entity.entityType === 'worktree' && entity.localId === 'multi-child',
    );

    expect(worktree?.payload).toMatchObject({ trackedBaseBranch: 'develop' });
  });

  it('projects cowork projects without local paths or worktree entities', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      partialPreferences({
        branchDisplayMappings: [],
        worktreeFilterHiddenWorkspaceIds: ['cowork-hidden'],
      }),
    );

    const items: SidebarItem[] = [
      {
        type: 'cowork',
        id: 'cowork-hidden',
        name: 'Cowork Space',
        color: '#fedcba',
        collapsed: true,
        order: 4,
        externalPath: '/private/cowork-folder',
        alwaysShow: false,
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();

    expect(entities).toEqual([
      {
        entityType: 'workspace',
        localId: 'cowork-hidden',
        payload: {
          name: 'Cowork Space',
          type: 'cowork',
          itemSortMode: 'manual',
          // Desktop cowork is the repoless-AND-flat case; cloud is the
          // repoless-but-tree one, projected browser-side (REG-2819).
          layout: 'flat',
          color: '#fedcba',
          order: 4,
          collapsed: true,
          hidden: true,
          alwaysShow: false,
          archiveRetentionDays: 7,
          repos: [],
        },
      },
    ]);
    expect(mockedGetCachedWorktreeDiffStats).not.toHaveBeenCalled();
  });

  // REG-2819. This service is the ONE desktop-side workspace projector — it
  // feeds both the desktop's own shared sidebar and the remote-control wire —
  // so the layout axis has to be stamped here for every kind, not just cowork.
  // A row that reaches the browser without it falls back on the legacy default,
  // which is right for desktop but leaves the field carrying no real signal.
  it('stamps the layout axis on every project kind', async () => {
    const preferences = partialPreferences({
      branchDisplayMappings: [],
      worktreeFilterHiddenWorkspaceIds: [],
    });
    mockedReadPreferencesFile.mockResolvedValue(preferences);

    const items: SidebarItem[] = [
      {
        type: 'cowork',
        id: 'cowork',
        name: 'Cowork',
        color: '#000000',
        collapsed: false,
        order: 0,
      },
      {
        type: 'single-repo',
        id: 'single',
        name: 'Single',
        color: '#000000',
        collapsed: false,
        order: 1,
        repoPath: '/repos/one',
        worktrees: [],
      },
      {
        type: 'multi-repo',
        id: 'multi',
        name: 'Multi',
        color: '#000000',
        collapsed: false,
        order: 2,
        repos: [],
        worktrees: [],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();
    const payloadFor = (localId: string): unknown =>
      entities.find(
        (entity) =>
          entity.entityType === 'workspace' && entity.localId === localId,
      )?.payload;

    expect(payloadFor('cowork')).toHaveProperty('layout', 'flat');
    expect(payloadFor('single')).toHaveProperty('layout', 'tree');
    expect(payloadFor('multi')).toHaveProperty('layout', 'tree');
  });

  // CAN-3053: the child-row ordering mode drives the portal's worktree and
  // Work Entry (Chats section) order. Desktop resolves its manual default before projection.
  it('projects desktop manual defaults and explicit recency', async () => {
    const preferences = partialPreferences({
      branchDisplayMappings: [],
      worktreeFilterHiddenWorkspaceIds: [],
    });
    mockedReadPreferencesFile.mockResolvedValue(preferences);

    const items: SidebarItem[] = [
      {
        type: 'cowork',
        id: 'cowork-manual',
        name: 'Cowork manual',
        color: '#000000',
        collapsed: false,
        order: 0,
        itemSortMode: 'manual',
      },
      {
        type: 'cowork',
        id: 'cowork-recent',
        name: 'Cowork recent',
        color: '#000000',
        collapsed: false,
        order: 1,
        itemSortMode: 'last-updated',
      },
      {
        type: 'single-repo',
        id: 'single-manual',
        name: 'Single',
        color: '#000000',
        collapsed: false,
        order: 2,
        itemSortMode: 'manual',
        repoPath: '/repos/one',
        worktrees: [],
      },
      {
        type: 'multi-repo',
        id: 'multi-default',
        name: 'Multi',
        color: '#000000',
        collapsed: false,
        order: 3,
        repos: [],
        worktrees: [],
      },
      {
        type: 'multi-repo',
        id: 'multi-manual',
        name: 'Multi manual',
        color: '#000000',
        collapsed: false,
        order: 4,
        itemSortMode: 'manual',
        repos: [],
        worktrees: [],
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();
    const payloadFor = (localId: string): unknown =>
      entities.find(
        (entity) =>
          entity.entityType === 'workspace' && entity.localId === localId,
      )?.payload;

    expect(payloadFor('cowork-manual')).toHaveProperty(
      'itemSortMode',
      'manual',
    );
    expect(payloadFor('single-manual')).toHaveProperty(
      'itemSortMode',
      'manual',
    );
    expect(payloadFor('multi-manual')).toHaveProperty('itemSortMode', 'manual');
    expect(payloadFor('cowork-recent')).toHaveProperty(
      'itemSortMode',
      'last-updated',
    );
    expect(payloadFor('multi-default')).toHaveProperty(
      'itemSortMode',
      'manual',
    );

    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: items.map((item) => ({ ...item, itemSortMode: undefined })),
    });
    const defaults = await listWorkspacePortalEntities();
    for (const entity of defaults.filter(
      (entry) => entry.entityType === 'workspace',
    )) {
      expect(entity.payload).toHaveProperty('itemSortMode', 'manual');
    }
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: items.map((item) => ({ ...item, itemSortMode: 'last-updated' })),
    });
    const recency = await listWorkspacePortalEntities();
    for (const entity of recency.filter(
      (entry) => entry.entityType === 'workspace',
    )) {
      expect(entity.payload).toHaveProperty('itemSortMode', 'last-updated');
    }
  });

  it('projects configured and normalized deletion retention independently from Auto Delete', async () => {
    const items: SidebarItem[] = [
      {
        type: 'cowork',
        id: 'cowork',
        name: 'Cowork',
        color: '#000000',
        collapsed: false,
        order: 0,
        archiveRetentionDays: 21,
        autoArchiveDays: 5,
      },
      {
        type: 'single-repo',
        id: 'single',
        name: 'Single',
        color: '#000000',
        collapsed: false,
        order: 1,
        repoPath: '/repos/one',
        worktrees: [],
        archiveRetentionDays: null,
        autoArchiveDays: 7,
      },
      {
        type: 'multi-repo',
        id: 'multi',
        name: 'Multi',
        color: '#000000',
        collapsed: false,
        order: 2,
        repos: [],
        worktrees: [],
        archiveRetentionDays: 0,
        autoArchiveDays: 14,
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();

    expect(
      entities.find((entity) => entity.localId === 'cowork')?.payload,
    ).toMatchObject({ archiveRetentionDays: 21, autoArchiveDays: 5 });
    expect(
      entities.find((entity) => entity.localId === 'single')?.payload,
    ).toMatchObject({ archiveRetentionDays: 7, autoArchiveDays: 7 });
    expect(
      entities.find((entity) => entity.localId === 'multi')?.payload,
    ).toMatchObject({ archiveRetentionDays: 7, autoArchiveDays: 14 });
  });

  it('omits hidden from a cowork project absent from the hidden-ids set', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      partialPreferences({
        branchDisplayMappings: [],
        worktreeFilterHiddenWorkspaceIds: ['some-other-workspace'],
      }),
    );

    const items: SidebarItem[] = [
      {
        type: 'cowork',
        id: 'cowork-visible',
        name: 'Visible Cowork',
        color: '#123456',
        collapsed: false,
        order: 2,
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();

    expect(entities).toEqual([
      {
        entityType: 'workspace',
        localId: 'cowork-visible',
        payload: {
          name: 'Visible Cowork',
          type: 'cowork',
          itemSortMode: 'manual',
          layout: 'flat',
          color: '#123456',
          order: 2,
          collapsed: false,
          archiveRetentionDays: 7,
          repos: [],
        },
      },
    ]);
    const payload = entities[0]?.payload;
    expect(payload).not.toHaveProperty('hidden');
    expect(payload).not.toHaveProperty('alwaysShow');
  });

  it('projects the desktop sidebar visibility model (hidden + alwaysShow)', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      partialPreferences({
        branchDisplayMappings: [],
        worktreeFilterHiddenWorkspaceIds: ['workspace-hidden'],
      }),
    );

    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'workspace-hidden',
        name: 'User Hidden',
        repoPath: '/repo-a',
        color: '#123456',
        collapsed: false,
        order: 1,
        worktrees: [],
      },
      {
        type: 'multi-repo',
        id: 'workspace-temp',
        name: 'Adhoc Combine',
        color: '#654321',
        collapsed: false,
        order: 2,
        temporary: true,
        alwaysShow: false,
        repos: [],
        worktrees: [],
        // Still owns a retained container, so it stays listed.
        archivedContainerCount: 1,
      },
      {
        type: 'single-repo',
        id: 'workspace-normal',
        name: 'Normal',
        repoPath: '/repo-b',
        color: '#abcdef',
        collapsed: false,
        order: 3,
        worktrees: [],
      },
      {
        // A temporary workspace with no worktree and no retained container
        // is gone from every sidebar list, the same as the projects IPC.
        type: 'multi-repo',
        id: 'workspace-retired',
        name: 'Retired Combine',
        color: '#000000',
        collapsed: false,
        order: 4,
        temporary: true,
        alwaysShow: false,
        repos: [],
        worktrees: [],
      },
    ];
    const retired = items.find((item) => item.id === 'workspace-retired');
    if (!retired) throw new Error('Missing retired fixture');
    items.push(
      {
        ...retired,
        id: 'workspace-kept',
        alwaysShow: true,
        archivedContainerCount: 0,
      },
      { ...retired, id: 'workspace-absent', alwaysShow: undefined },
      { ...retired, id: 'workspace-kept-hidden', alwaysShow: true },
    );
    mockedReadPreferencesFile.mockResolvedValue(
      partialPreferences({
        branchDisplayMappings: [],
        worktreeFilterHiddenWorkspaceIds: [
          'workspace-hidden',
          'workspace-kept-hidden',
        ],
      }),
    );
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    const entities = await listWorkspacePortalEntities();
    const byId = new Map(
      entities
        .filter((entity) => entity.entityType === 'workspace')
        .map((entity) => [entity.localId, entity.payload]),
    );

    expect(byId.get('workspace-hidden')).toMatchObject({ hidden: true });
    expect(byId.get('workspace-temp')).toMatchObject({
      temporary: true,
      alwaysShow: false,
    });
    expect(byId.has('workspace-retired')).toBe(false);
    expect(byId.has('workspace-absent')).toBe(false);
    expect(byId.get('workspace-kept')).toMatchObject({ temporary: true });
    expect(byId.get('workspace-kept')).not.toHaveProperty('alwaysShow');
    expect(byId.get('workspace-kept-hidden')).toMatchObject({ hidden: true });
    const normal = byId.get('workspace-normal');
    expect(normal).not.toHaveProperty('hidden');
    expect(normal).not.toHaveProperty('alwaysShow');
  });

  describe('worktrees whose removal is in progress', () => {
    const removalWorktrees: WorktreeData[] = [
      {
        id: 'base',
        branchName: 'feature/base',
        createdAt: '2026-05-08T00:00:00.000Z',
        status: 'active',
      },
      {
        id: 'child',
        branchName: 'feature/child',
        trackedBaseBranch: 'feature/base',
        createdAt: '2026-05-08T00:00:00.000Z',
        status: 'active',
      },
      {
        id: 'other',
        branchName: 'feature/other',
        createdAt: '2026-05-08T00:00:00.000Z',
        status: 'active',
      },
    ];

    function seedRemovalWorkspace(
      type: 'single-repo' | 'multi-repo' = 'single-repo',
    ): void {
      const items: SidebarItem[] = [
        type === 'single-repo'
          ? {
              type,
              id: 'workspace-1',
              name: 'Workspace',
              color: '#000000',
              repoPath: '/repo',
              collapsed: false,
              order: 0,
              worktrees: removalWorktrees,
            }
          : {
              type,
              id: 'workspace-1',
              name: 'Workspace',
              color: '#000000',
              collapsed: false,
              order: 0,
              repos: [],
              worktrees: removalWorktrees,
            },
      ];
      mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });
      mockedReadWorkspaceWorktrees.mockResolvedValue(removalWorktrees);
    }

    async function listWorktreePayloads(): Promise<
      Map<string, Record<string, unknown>>
    > {
      const entities = await listWorkspacePortalEntities();
      return new Map(
        entities
          .filter((entity) => entity.entityType === 'worktree')
          .map((entity): [string, Record<string, unknown>] => {
            if (!isRecord(entity.payload)) {
              throw new Error(
                'Expected worktree portal payload to be a record.',
              );
            }
            return [entity.localId, entity.payload];
          }),
      );
    }

    it.each(['single-repo', 'multi-repo'] as const)(
      'leaves a pending %s worktree out of the list and out of its siblings',
      async (type) => {
        seedRemovalWorkspace(type);
        markWorkspaceTargetRemovalPending('workspace-1', 'base');

        const payloads = await listWorktreePayloads();

        expect(Array.from(payloads.keys())).toEqual(['child', 'other']);
        // The pending row was the grouping parent; a hidden parent must not
        // leave its child nested under a row no surface renders.
        expect(payloads.get('child')).not.toHaveProperty(
          'branchGroupingParentWorktreeId',
        );
        const [statusRequests] = mockedGetWorktreeRuntimeStatuses.mock.calls[0];
        expect(statusRequests.map((request) => request.worktree.id)).toEqual([
          'child',
          'other',
        ]);
        expect(mockedGetCachedWorktreeDiffStats).not.toHaveBeenCalledWith(
          'workspace-1',
          'base',
        );
      },
    );

    it('keeps the remaining rows in contiguous order, matching the targeted projector', async () => {
      seedRemovalWorkspace();
      markWorkspaceTargetRemovalPending('workspace-1', 'base');

      const payloads = await listWorktreePayloads();

      expect(payloads.get('child')).toMatchObject({ order: 0 });
      expect(payloads.get('other')).toMatchObject({ order: 1 });
      for (const worktreeId of ['child', 'other']) {
        const entity = await getWorkspacePortalWorktreeEntity(
          'workspace-1',
          worktreeId,
          {},
        );
        if (!isRecord(entity?.payload)) {
          throw new Error('Expected worktree portal payload to be a record.');
        }
        expect(entity.payload.order).toBe(payloads.get(worktreeId)?.order);
        expect(entity?.payload).not.toHaveProperty(
          'branchGroupingParentWorktreeId',
        );
      }
    });

    it('leaves out a worktree whose removal starts while the list is being built', async () => {
      seedRemovalWorkspace();
      // The removal starts during the last read the list waits on.
      mockedGetWorktreeRuntimeStatuses.mockImplementationOnce(() => {
        markWorkspaceTargetRemovalPending('workspace-1', 'base');
        return Promise.resolve(new Map<string, WorktreeRuntimeStatus>());
      });

      const payloads = await listWorktreePayloads();

      // Order and grouping come from the marks as they are when the rows are
      // projected, not as they were before the reads.
      expect(Array.from(payloads.keys())).toEqual(['child', 'other']);
      expect(payloads.get('child')).toMatchObject({ order: 0 });
      expect(payloads.get('child')).not.toHaveProperty(
        'branchGroupingParentWorktreeId',
      );
      expect(payloads.get('other')).toMatchObject({ order: 1 });
    });

    it('returns no targeted entity for a pending worktree', async () => {
      seedRemovalWorkspace();
      markWorkspaceTargetRemovalPending('workspace-1', 'child');

      await expect(
        getWorkspacePortalWorktreeEntity('workspace-1', 'child', {}),
      ).resolves.toBeNull();
    });

    it('restores the row once every mark is released', async () => {
      seedRemovalWorkspace();
      const first = markWorkspaceTargetRemovalPending('workspace-1', 'base');
      const second = markWorkspaceTargetRemovalPending('workspace-1', 'base');

      first();
      first();
      expect((await listWorktreePayloads()).has('base')).toBe(false);
      await expect(
        getWorkspacePortalWorktreeEntity('workspace-1', 'base', {}),
      ).resolves.toBeNull();

      second();
      const payloads = await listWorktreePayloads();
      expect(Array.from(payloads.keys())).toEqual(['base', 'child', 'other']);
      expect(payloads.get('child')).toMatchObject({
        order: 1,
        branchGroupingParentWorktreeId: 'base',
      });
      await expect(
        getWorkspacePortalWorktreeEntity('workspace-1', 'base', {}),
      ).resolves.toMatchObject({ localId: 'base' });
    });

    it('still lists a workspace whose every worktree is pending', async () => {
      const items: SidebarItem[] = [
        {
          type: 'multi-repo',
          id: 'workspace-temp',
          name: 'Temporary',
          color: '#000000',
          temporary: true,
          collapsed: false,
          order: 0,
          repos: [],
          worktrees: [removalWorktrees[0]],
        },
      ];
      mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });
      markWorkspaceTargetRemovalPending('workspace-temp', 'base');

      const entities = await listWorkspacePortalEntities();

      expect(
        entities.map((entity) => [entity.entityType, entity.localId]),
      ).toEqual([['workspace', 'workspace-temp']]);
    });
  });
});

it('projects optional per-workspace membership on the canonical workspace entity', async () => {
  const groups: SidebarItemGroup[] = [
    {
      id: 'grp-code',
      name: 'Code',
      color: 'neutral',
      collapsed: false,
      memberIds: ['wt-1'],
    },
  ];
  jest.mocked(projectSidebarItemGroups).mockResolvedValueOnce(groups);
  mockedReadAllSidebarItems.mockResolvedValue({
    version: 1,
    items: [
      {
        id: 'workspace-a',
        name: 'Code',
        type: 'single-repo',
        color: '#000000',
        repoPath: '/repo',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'wt-1',
            branchName: 'feature/test',
            createdAt: '2026-10-04T00:00:00Z',
          },
        ],
      },
    ],
  });
  const entities = await listWorkspacePortalEntities();
  expect(projectSidebarItemGroups).toHaveBeenCalledWith(
    { workspaceLocalId: 'workspace-a' },
    expect.objectContaining({
      worktrees: [expect.objectContaining({ id: 'wt-1' })],
    }),
  );
  expect(
    entities.find((entity) => entity.entityType === 'workspace')?.payload,
  ).toHaveProperty('itemGroups', groups);
});
