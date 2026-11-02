import { createHash } from 'node:crypto';
import type {
  PlanCommentThread,
  TrackedPlanData,
  TrackedPlanShareState,
} from '@canopy/desktop-shared/types';
import {
  buildSharedPlanSnapshotInput,
  stableStringify,
  type SharedPlanDetail,
  type SharedPlanRepositoryRef,
} from '@canopy/protocol/plans';

type ShareStateArgument =
  | TrackedPlanShareState
  | undefined
  | ((
      current: TrackedPlanShareState | undefined,
    ) => TrackedPlanShareState | undefined);

type SetTrackedPlanShareStateMock = (
  projectId: string,
  worktreeId: string,
  planId: string,
  share: ShareStateArgument,
) => Promise<TrackedPlanData | null>;

const mockSetTrackedPlanShareState: jest.MockedFunction<SetTrackedPlanShareStateMock> =
  jest.fn();

jest.mock('../plans/canopy-server-client', () => ({
  createSharedPlan: jest.fn(),
  updateSharedPlan: jest.fn(),
  getSharedPlan: jest.fn(),
}));

interface CapturedSubscription {
  remoteId: string;
  onSignal: CreatePlanRealtimeSubscriptionOptions['onSignal'];
  stop: jest.Mock;
}

const capturedSubscriptions: CapturedSubscription[] = [];

const mockCreatePlanRealtimeSubscription: jest.MockedFunction<
  (options: CreatePlanRealtimeSubscriptionOptions) => PlanRealtimeSubscription
> = jest.fn((options) => {
  const stop = jest.fn();
  capturedSubscriptions.push({
    remoteId: options.remoteId,
    onSignal: options.onSignal,
    stop,
  });
  return { stop };
});

jest.mock('../plans/plan-realtime-subscription', () => ({
  createPlanRealtimeSubscription: (
    options: CreatePlanRealtimeSubscriptionOptions,
  ): PlanRealtimeSubscription => mockCreatePlanRealtimeSubscription(options),
}));

jest.mock('../lib/plan-persistence', () => ({
  getTrackedPlan: jest.fn(),
  listTrackedPlans: jest.fn(),
  get setTrackedPlanShareState(): typeof mockSetTrackedPlanShareState {
    return mockSetTrackedPlanShareState;
  },
  applyRemoteSharedPlanComments: jest.fn(),
}));

jest.mock('../lib/plan-share-repos', () => ({
  buildSharedPlanRepositoryRefs: jest.fn(),
}));

jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

const mockLogMainProcessError = jest.fn();

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: (...args: unknown[]): void => {
    mockLogMainProcessError(...args);
  },
}));

import { setImmediate as realSetImmediate } from 'node:timers';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  CreatePlanRealtimeSubscriptionOptions,
  PlanRealtimeSubscription,
} from '../plans/plan-realtime-subscription';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  createSharedPlan,
  updateSharedPlan,
  getSharedPlan,
} from '../plans/canopy-server-client';
import {
  getTrackedPlan,
  listTrackedPlans,
  applyRemoteSharedPlanComments,
} from '../lib/plan-persistence';
import { buildSharedPlanRepositoryRefs } from '../lib/plan-share-repos';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { sendToWindow } from '../lib/window-send';
import {
  initializeSharedPlanSync,
  initializeSharedPlanStartup,
  queueSharedPlanSync,
  queueSharedPlanSyncForAllTrackedPlans,
  shareTrackedPlan,
  startAllPlanRealtimeSubscriptions,
  syncPlanRealtimeSubscription,
} from '../lib/shared-plan-sync';

const mockedCreateSharedPlan = jest.mocked(createSharedPlan);
const mockedUpdateSharedPlan = jest.mocked(updateSharedPlan);
const mockedGetTrackedPlan = jest.mocked(getTrackedPlan);
const mockedListTrackedPlans = jest.mocked(listTrackedPlans);
const mockedSetTrackedPlanShareState = mockSetTrackedPlanShareState;
const mockedBuildSharedPlanRepositoryRefs = jest.mocked(
  buildSharedPlanRepositoryRefs,
);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedGetSharedPlan = jest.mocked(getSharedPlan);
const mockedApplyRemoteSharedPlanComments = jest.mocked(
  applyRemoteSharedPlanComments,
);

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: 'project-a',
    worktreeId: 'wt-1',
    source: 'claude',
    title: 'Plan One',
    content: 'Do the work',
    reviewStatus: 'pending',
    createdAt: '2026-06-09T12:00:00.000Z',
    updatedAt: '2026-06-09T12:05:00.000Z',
    latestRevisionNumber: 3,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function makeRemote(
  overrides: Partial<SharedPlanDetail> = {},
): SharedPlanDetail {
  const shareScope = overrides.shareScope ?? 'private';
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Plan One',
    content: 'Do the work',
    contentHash: 'content-hash',
    diagramsHash: 'diagram-hash',
    snapshotHash: 'server-snapshot',
    localRevisionNumber: 3,
    remoteRevisionNumber: 1,
    repositories: [],
    shareScope,
    owner:
      shareScope === 'team'
        ? {
            type: 'team',
            id: '22222222-2222-4222-8222-222222222222',
            name: 'Team',
            organization: { id: 'org-1', name: 'Org' },
          }
        : shareScope === 'organization'
          ? {
              type: 'organization',
              id: '33333333-3333-4333-8333-333333333333',
              name: 'Org',
            }
          : { type: 'user', id: 'user-1', name: 'Owner' },
    createdBy: { id: 'user-1', name: 'Owner', email: 'owner@example.test' },
    createdAt: '2026-06-09T12:06:00.000Z',
    updatedAt: '2026-06-09T12:06:00.000Z',
    canUpdate: true,
    canDelete: true,
    ...overrides,
    commentThreads: overrides.commentThreads ?? [],
  };
}

function resolveUpdatedPlan(
  plan: TrackedPlanData,
  share: ShareStateArgument,
): Promise<TrackedPlanData> {
  const nextShare = typeof share === 'function' ? share(plan.share) : share;
  return Promise.resolve({
    ...plan,
    ...(nextShare ? { share: nextShare } : {}),
  });
}

function expectShareStateUpdateAt(
  callIndex: number,
  current: TrackedPlanShareState | undefined,
  expected: Partial<TrackedPlanShareState>,
): void {
  const calls = mockedSetTrackedPlanShareState.mock.calls;
  const normalizedIndex = callIndex < 0 ? calls.length + callIndex : callIndex;
  const call = calls[normalizedIndex];
  if (!call) {
    throw new Error(`Expected setTrackedPlanShareState call ${callIndex}`);
  }
  expect([call[0], call[1], call[2]]).toEqual(['project-a', 'wt-1', 'plan-1']);
  const shareArg = call[3];
  const nextShare =
    typeof shareArg === 'function' ? shareArg(current) : shareArg;
  expect(nextShare).toEqual(expect.objectContaining(expected));
}

describe('shared plan sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedSubscriptions.length = 0;
    initializeSharedPlanSync({ getWindow: () => null });
    mockedBuildSharedPlanRepositoryRefs.mockResolvedValue([
      {
        repoId: '__single_repo__',
        repoName: 'Project A',
        remoteUrl: 'https://github.com/acme/repo.git',
        branch: 'feature',
        commitSha: 'abc123',
        defaultBranch: 'main',
      },
    ]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a remote shared plan and persists returned share metadata', async () => {
    const plan = makePlan();
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedCreateSharedPlan.mockResolvedValue(makeRemote());
    mockedSetTrackedPlanShareState.mockImplementation(
      (_projectId, _worktreeId, _planId, share) =>
        resolveUpdatedPlan(plan, share),
    );

    const updated = await shareTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      shareScope: 'private',
    });

    expect(mockedCreateSharedPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        clientLocalPlanId: 'plan-1',
        workspaceLocalId: 'project-a',
        worktreeLocalId: 'wt-1',
        localRevisionNumber: 3,
        localCreatedAt: plan.createdAt,
        localUpdatedAt: plan.updatedAt,
        shareScope: 'private',
        repositories: [
          expect.objectContaining({
            remoteUrl: 'https://github.com/acme/repo.git',
          }),
        ],
      }),
    );
    expect(mockedSetTrackedPlanShareState).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
      'plan-1',
      expect.objectContaining({
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        syncStatus: 'synced',
        lastSyncedRemoteRevisionNumber: 1,
        lastSyncedSnapshotHash: 'server-snapshot',
      }),
    );
    expect(updated?.share?.remoteId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(mockedSendToWindow).toHaveBeenLastCalledWith(
      null,
      IPC_CHANNELS.trackedPlansUpdated,
      {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        plan: updated,
      },
    );
  });

  it('marks initial share pending and queues sync when local content changes during create', async () => {
    jest.useFakeTimers();
    const plan = makePlan();
    const latest = makePlan({
      content: 'Do newer work',
      latestRevisionNumber: 4,
      updatedAt: '2026-06-09T12:07:00.000Z',
    });
    let persistedPlan = latest;
    mockedGetTrackedPlan
      .mockResolvedValueOnce(plan)
      .mockImplementation(() => Promise.resolve(persistedPlan));
    mockedCreateSharedPlan.mockResolvedValue(makeRemote());
    mockedUpdateSharedPlan.mockResolvedValue(
      makeRemote({
        content: latest.content,
        localRevisionNumber: latest.latestRevisionNumber,
        remoteRevisionNumber: 2,
        snapshotHash: 'updated-server-snapshot',
      }),
    );
    mockedSetTrackedPlanShareState.mockImplementation(
      (_projectId, _worktreeId, _planId, share) => {
        const nextShare =
          typeof share === 'function' ? share(persistedPlan.share) : share;
        persistedPlan = {
          ...persistedPlan,
          ...(nextShare ? { share: nextShare } : {}),
        };
        return Promise.resolve(persistedPlan);
      },
    );

    const updated = await shareTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      shareScope: 'private',
    });

    expect(updated?.content).toBe('Do newer work');
    expect(updated?.share).toMatchObject({
      remoteId: '11111111-1111-4111-8111-111111111111',
      syncStatus: 'pending',
      lastSyncedSnapshotHash: 'server-snapshot',
    });
    expect(mockedUpdateSharedPlan).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);

    expect(mockedUpdateSharedPlan).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({
        content: 'Do newer work',
        localRevisionNumber: 4,
        expectedSnapshotHash: 'server-snapshot',
      }),
    );
  });

  it('rejects a missing organization target before writing share state', async () => {
    const plan = makePlan({
      share: {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'private',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'server-snapshot',
      },
    });
    mockedGetTrackedPlan.mockResolvedValue(plan);

    await expect(
      shareTrackedPlan({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        planId: 'plan-1',
        shareScope: 'organization',
      }),
    ).rejects.toThrow(/organizationId/);

    expect(mockedSetTrackedPlanShareState).not.toHaveBeenCalled();
    expect(mockedCreateSharedPlan).not.toHaveBeenCalled();
    expect(mockedUpdateSharedPlan).not.toHaveBeenCalled();
  });

  it('sends the expected snapshot hash when syncing an existing shared plan', async () => {
    jest.useFakeTimers();
    const plan = makePlan({
      content: 'Updated work',
      share: {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'team',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'previous-server-snapshot',
      },
    });
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedUpdateSharedPlan.mockResolvedValue(
      makeRemote({
        content: plan.content,
        snapshotHash: 'next-server-snapshot',
        remoteRevisionNumber: 2,
      }),
    );
    mockedSetTrackedPlanShareState.mockImplementation(
      (_projectId, _worktreeId, _planId, share) =>
        resolveUpdatedPlan(plan, share),
    );

    queueSharedPlanSync(plan, 'plan');
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockedUpdateSharedPlan).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({
        expectedSnapshotHash: 'previous-server-snapshot',
      }),
    );
    expect(mockedSetTrackedPlanShareState).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
      'plan-1',
      expect.objectContaining({ syncStatus: 'synced' }),
    );
  });

  it('does not push background edits to a private-only share', async () => {
    // A legacy private-only copy is hidden from everyone else and the UI treats
    // the plan as unshared, so edits stay local until it is shared for real.
    jest.useFakeTimers();
    const plan = makePlan({
      share: {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'private',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'previous-server-snapshot',
      },
    });

    queueSharedPlanSync(plan, 'plan');
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockedSetTrackedPlanShareState).not.toHaveBeenCalled();
    expect(mockedUpdateSharedPlan).not.toHaveBeenCalled();
  });

  it('marks queued sync pending without rolling back current sync metadata', () => {
    jest.useFakeTimers();
    const plan = makePlan({
      share: {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'team',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'stale-server-snapshot',
        lastSyncedRemoteRevisionNumber: 1,
        lastSyncError: 'previous error',
      },
    });
    const staleShare = plan.share;
    if (!staleShare) {
      throw new Error('Expected test plan share state');
    }
    const currentShare: TrackedPlanShareState = {
      ...staleShare,
      lastSyncedSnapshotHash: 'new-server-snapshot',
      lastSyncedRemoteRevisionNumber: 2,
    };

    queueSharedPlanSync(plan, 'plan');

    expectShareStateUpdateAt(0, currentShare, {
      syncStatus: 'pending',
      lastSyncError: undefined,
      lastSyncedSnapshotHash: 'new-server-snapshot',
      lastSyncedRemoteRevisionNumber: 2,
    });
  });

  it('clears queued sync timers when reinitialized', async () => {
    jest.useFakeTimers();
    const plan = makePlan({
      share: {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'team',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'previous-server-snapshot',
      },
    });

    queueSharedPlanSync(plan, 'plan');
    initializeSharedPlanSync({ getWindow: () => null });
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockedGetTrackedPlan).not.toHaveBeenCalled();
    expect(mockedUpdateSharedPlan).not.toHaveBeenCalled();
  });

  it('updates instead of creating when retrying an already shared plan', async () => {
    const plan = makePlan({
      content: 'Updated work',
      share: {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'team',
        syncStatus: 'error',
        lastSyncError: 'offline',
        lastSyncedSnapshotHash: 'previous-server-snapshot',
      },
    });
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedUpdateSharedPlan.mockResolvedValue(
      makeRemote({
        content: plan.content,
        snapshotHash: 'next-server-snapshot',
        remoteRevisionNumber: 2,
      }),
    );
    mockedSetTrackedPlanShareState.mockImplementation(
      (_projectId, _worktreeId, _planId, share) =>
        resolveUpdatedPlan(plan, share),
    );

    const updated = await shareTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      shareScope: 'private',
    });

    expect(mockedCreateSharedPlan).not.toHaveBeenCalled();
    expect(mockedUpdateSharedPlan).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({
        expectedSnapshotHash: 'previous-server-snapshot',
      }),
    );
    expect(updated?.share?.syncStatus).toBe('synced');
  });

  it('creates a replacement when moving a private share to a team', async () => {
    const plan = makePlan({
      share: {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'private',
        syncStatus: 'error',
        lastSyncError: 'offline',
        lastSyncedSnapshotHash: 'previous-server-snapshot',
      },
    });
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedCreateSharedPlan.mockResolvedValue(
      makeRemote({
        id: '44444444-4444-4444-8444-444444444444',
        shareScope: 'team',
        snapshotHash: 'next-server-snapshot',
        remoteRevisionNumber: 2,
      }),
    );
    mockedSetTrackedPlanShareState.mockImplementation(
      (_projectId, _worktreeId, _planId, share) =>
        resolveUpdatedPlan(plan, share),
    );

    const updated = await shareTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      shareScope: 'team',
      teamId: '22222222-2222-4222-8222-222222222222',
    });

    expect(mockedUpdateSharedPlan).not.toHaveBeenCalled();
    expect(mockedCreateSharedPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        shareScope: 'team',
        teamId: '22222222-2222-4222-8222-222222222222',
      }),
    );
    expect(updated?.share).toEqual(
      expect.objectContaining({
        remoteId: '44444444-4444-4444-8444-444444444444',
        shareScope: 'team',
        teamId: '22222222-2222-4222-8222-222222222222',
        syncStatus: 'synced',
      }),
    );
  });

  it('does not recreate a missing remote when retrying an already shared plan', async () => {
    const plan = makePlan({
      share: {
        serverId: 'canopy-cloud',
        remoteId: 'missing-remote',
        shareScope: 'team',
        teamId: '22222222-2222-4222-8222-222222222222',
        syncStatus: 'error',
        lastSyncError: 'not found',
        lastSyncedSnapshotHash: 'previous-server-snapshot',
      },
    });
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedUpdateSharedPlan.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    mockedSetTrackedPlanShareState.mockImplementation(
      (_projectId, _worktreeId, _planId, share) =>
        resolveUpdatedPlan(plan, share),
    );

    await expect(
      shareTrackedPlan({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        planId: 'plan-1',
      }),
    ).rejects.toMatchObject({
      message: 'HTTP 404: Not found',
    });

    expect(mockedCreateSharedPlan).not.toHaveBeenCalled();
    expectShareStateUpdateAt(-1, plan.share, {
      remoteId: 'missing-remote',
      syncStatus: 'error',
      lastSyncError: 'HTTP 404: Not found',
    });
  });

  it('queues synced shared plans at startup so dirty snapshots are detected', async () => {
    jest.useFakeTimers();
    const plan = makePlan({
      content: 'Locally changed before shutdown',
      share: {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'team',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'previous-server-snapshot',
      },
    });
    const worktree = {
      id: 'wt-1',
      name: 'Worktree',
      branchName: 'main',
      createdAt: '2026-06-09T12:00:00.000Z',
      path: '/tmp/wt-1',
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/tmp/project-a',
          color: 'blue',
          worktrees: [worktree],
          collapsed: false,
          order: 0,
        },
      ],
    });
    mockedListTrackedPlans.mockResolvedValue([plan]);
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedUpdateSharedPlan.mockResolvedValue(
      makeRemote({
        content: plan.content,
        snapshotHash: 'next-server-snapshot',
        remoteRevisionNumber: 2,
      }),
    );
    mockedSetTrackedPlanShareState.mockImplementation(
      (_projectId, _worktreeId, _planId, share) =>
        resolveUpdatedPlan(plan, share),
    );

    await queueSharedPlanSyncForAllTrackedPlans();
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockedUpdateSharedPlan).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({
        expectedSnapshotHash: 'previous-server-snapshot',
      }),
    );
  });

  it('enumerates startup plan storage once and fans one inventory to sync and realtime', async () => {
    jest.useFakeTimers();
    const remoteId = '11111111-1111-4111-8111-111111111111';
    const first = makePlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      share: {
        serverId: 'canopy-cloud',
        remoteId,
        shareScope: 'team',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'first-snapshot',
      },
    });
    const second = makePlan({
      id: 'plan-2',
      projectId: 'project-b',
      worktreeId: 'wt-2',
      share: {
        serverId: 'canopy-cloud',
        remoteId,
        shareScope: 'team',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'second-snapshot',
      },
    });
    const firstWorktree = {
      id: 'wt-1',
      name: 'One',
      branchName: 'main',
      createdAt: '2026-06-09T12:00:00.000Z',
      path: '/tmp/wt-1',
    };
    const secondWorktree = {
      id: 'wt-2',
      name: 'Two',
      branchName: 'main',
      createdAt: '2026-06-09T12:00:00.000Z',
      path: '/tmp/wt-2',
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/tmp/project-a',
          color: 'blue',
          worktrees: [firstWorktree],
          collapsed: false,
          order: 0,
        },
        {
          type: 'single-repo',
          id: 'project-b',
          name: 'Project B',
          repoPath: '/tmp/project-b',
          color: 'green',
          worktrees: [secondWorktree],
          collapsed: false,
          order: 1,
        },
      ],
    });
    mockedListTrackedPlans.mockImplementation((projectId) =>
      Promise.resolve(projectId === 'project-a' ? [first] : [second]),
    );

    await initializeSharedPlanStartup();

    expect(mockedReadAllSidebarItems).toHaveBeenCalledTimes(1);
    expect(mockedListTrackedPlans).toHaveBeenCalledTimes(2);
    expect(mockedListTrackedPlans).toHaveBeenNthCalledWith(
      1,
      'project-a',
      'wt-1',
    );
    expect(mockedListTrackedPlans).toHaveBeenNthCalledWith(
      2,
      'project-b',
      'wt-2',
    );
    expect(mockCreatePlanRealtimeSubscription).toHaveBeenCalledTimes(1);
    expect(mockedSetTrackedPlanShareState).toHaveBeenCalledTimes(2);
  });

  it('does not retry or recreate a shared plan after a 404 update', async () => {
    jest.useFakeTimers();
    const plan = makePlan({
      share: {
        serverId: 'canopy-cloud',
        remoteId: 'missing-remote',
        shareScope: 'team',
        teamId: '22222222-2222-4222-8222-222222222222',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'previous-server-snapshot',
      },
    });
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedUpdateSharedPlan.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    mockedSetTrackedPlanShareState.mockImplementation(
      (_projectId, _worktreeId, _planId, share) =>
        resolveUpdatedPlan(plan, share),
    );

    queueSharedPlanSync(plan, 'plan');
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockedCreateSharedPlan).not.toHaveBeenCalled();
    expectShareStateUpdateAt(-1, plan.share, {
      syncStatus: 'error',
      lastSyncError: 'HTTP 404: Not found',
    });

    mockedUpdateSharedPlan.mockClear();
    mockedCreateSharedPlan.mockClear();
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockedUpdateSharedPlan).not.toHaveBeenCalled();
    expect(mockedCreateSharedPlan).not.toHaveBeenCalled();
  });

  it('does not retry deterministic update HTTP client errors', async () => {
    jest.useFakeTimers();
    const plan = makePlan({
      share: {
        serverId: 'canopy-cloud',
        remoteId: 'remote-1',
        shareScope: 'team',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'previous-server-snapshot',
      },
    });
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedUpdateSharedPlan.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Forbidden', 403),
    );
    mockedSetTrackedPlanShareState.mockImplementation(
      (_projectId, _worktreeId, _planId, share) =>
        resolveUpdatedPlan(plan, share),
    );

    queueSharedPlanSync(plan, 'plan');
    await jest.advanceTimersByTimeAsync(1000);

    expectShareStateUpdateAt(-1, plan.share, {
      syncStatus: 'error',
      lastSyncError: 'HTTP 403: Forbidden',
    });

    mockedUpdateSharedPlan.mockClear();
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockedUpdateSharedPlan).not.toHaveBeenCalled();
  });

  it.each([
    'cloud-not-configured',
    'missing-api-key',
    'unsupported-capability',
  ] as const)('does not retry non-retryable cloud error %s', async (code) => {
    jest.useFakeTimers();
    const plan = makePlan({
      share: {
        serverId: 'canopy-cloud',
        remoteId: 'remote-1',
        shareScope: 'team',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'previous-server-snapshot',
      },
    });
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedUpdateSharedPlan.mockRejectedValue(
      new CanopyCloudClientError(code, 'Cloud setup is incomplete.'),
    );
    mockedSetTrackedPlanShareState.mockImplementation(
      (_projectId, _worktreeId, _planId, share) =>
        resolveUpdatedPlan(plan, share),
    );

    queueSharedPlanSync(plan, 'plan');
    await jest.advanceTimersByTimeAsync(1000);

    expectShareStateUpdateAt(-1, plan.share, {
      syncStatus: 'error',
      lastSyncError: 'Cloud setup is incomplete.',
    });

    mockedUpdateSharedPlan.mockClear();
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockedUpdateSharedPlan).not.toHaveBeenCalled();
  });

  describe('first-share realtime enrollment (D-A)', () => {
    function flushMicrotasks(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve));
    }

    it('enrolls a realtime subscription when a plan is shared to a team for the first time', async () => {
      const plan = makePlan();
      let persistedPlan = plan;
      mockedGetTrackedPlan.mockImplementation(() =>
        Promise.resolve(persistedPlan),
      );
      const remote = makeRemote({ shareScope: 'team' });
      mockedCreateSharedPlan.mockResolvedValue(remote);
      mockedApplyRemoteSharedPlanComments.mockResolvedValue(null);
      mockedSetTrackedPlanShareState.mockImplementation(
        (_projectId, _worktreeId, _planId, share) => {
          const nextShare =
            typeof share === 'function' ? share(persistedPlan.share) : share;
          persistedPlan = {
            ...persistedPlan,
            ...(nextShare ? { share: nextShare } : {}),
          };
          return Promise.resolve(persistedPlan);
        },
      );

      await shareTrackedPlan({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        planId: 'plan-1',
        shareScope: 'team',
        teamId: '22222222-2222-4222-8222-222222222222',
      });

      expect(capturedSubscriptions).toHaveLength(1);
      expect(capturedSubscriptions[0]?.remoteId).toBe(remote.id);

      mockedGetSharedPlan.mockClear();
      mockedGetSharedPlan.mockResolvedValue(remote);
      capturedSubscriptions[0]?.onSignal({ planId: remote.id, revision: 2 });
      await flushMicrotasks();

      expect(mockedGetSharedPlan).toHaveBeenCalledWith(remote.id);
    });

    it('enrolls a realtime subscription for the pending branch when local content changed during create', async () => {
      jest.useFakeTimers();
      const plan = makePlan();
      const latest = makePlan({
        content: 'Do newer work',
        latestRevisionNumber: 4,
        updatedAt: '2026-06-09T12:07:00.000Z',
      });
      let persistedPlan = latest;
      mockedGetTrackedPlan
        .mockResolvedValueOnce(plan)
        .mockImplementation(() => Promise.resolve(persistedPlan));
      const remote = makeRemote();
      mockedCreateSharedPlan.mockResolvedValue(remote);
      mockedApplyRemoteSharedPlanComments.mockResolvedValue(null);
      mockedSetTrackedPlanShareState.mockImplementation(
        (_projectId, _worktreeId, _planId, share) => {
          const nextShare =
            typeof share === 'function' ? share(persistedPlan.share) : share;
          persistedPlan = {
            ...persistedPlan,
            ...(nextShare ? { share: nextShare } : {}),
          };
          return Promise.resolve(persistedPlan);
        },
      );

      const updated = await shareTrackedPlan({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        planId: 'plan-1',
        shareScope: 'private',
      });

      expect(updated?.share?.syncStatus).toBe('pending');
      expect(capturedSubscriptions).toHaveLength(1);
      expect(capturedSubscriptions[0]?.remoteId).toBe(remote.id);
    });

    it('moves the tuple realtime subscription when a private share is replaced by a team share under a new remote id', async () => {
      const plan = makePlan({
        share: {
          serverId: 'canopy-cloud',
          remoteId: '11111111-1111-4111-8111-111111111111',
          shareScope: 'private',
          syncStatus: 'error',
          lastSyncError: 'offline',
          lastSyncedSnapshotHash: 'previous-server-snapshot',
        },
      });
      mockedGetTrackedPlan.mockResolvedValue(plan);
      mockedApplyRemoteSharedPlanComments.mockResolvedValue(null);

      // Seed a pre-existing realtime subscription for the plan's current
      // (private) remote id, as startup/the plan-share listener would.
      syncPlanRealtimeSubscription(plan);
      expect(capturedSubscriptions).toHaveLength(1);
      const oldSubscription = capturedSubscriptions[0];
      if (!oldSubscription) {
        throw new Error('Expected a seeded realtime subscription');
      }

      mockedCreateSharedPlan.mockResolvedValue(
        makeRemote({
          id: '44444444-4444-4444-8444-444444444444',
          shareScope: 'team',
          snapshotHash: 'next-server-snapshot',
          remoteRevisionNumber: 2,
        }),
      );
      mockedSetTrackedPlanShareState.mockImplementation(
        (_projectId, _worktreeId, _planId, share) =>
          resolveUpdatedPlan(plan, share),
      );

      await shareTrackedPlan({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        planId: 'plan-1',
        shareScope: 'team',
        teamId: '22222222-2222-4222-8222-222222222222',
      });

      expect(oldSubscription.stop).toHaveBeenCalledTimes(1);
      expect(capturedSubscriptions).toHaveLength(2);
      expect(capturedSubscriptions[1]?.remoteId).toBe(
        '44444444-4444-4444-8444-444444444444',
      );
    });

    it('SC11: opens no second subscription when a first share lands on a remote id that already has a bucket', async () => {
      const remoteId = '11111111-1111-4111-8111-111111111111';
      const planA = makePlan({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        id: 'plan-1',
        share: {
          serverId: 'canopy-cloud',
          remoteId,
          shareScope: 'team',
          syncStatus: 'synced',
          lastSyncedSnapshotHash: 'server-snapshot',
        },
      });
      // planB is a different tuple that is about to be first-shared onto the
      // SAME remote plan id planA is already subscribed to.
      const planB = makePlan({
        projectId: 'project-b',
        worktreeId: 'wt-2',
        id: 'plan-2',
      });

      syncPlanRealtimeSubscription(planA);
      expect(capturedSubscriptions).toHaveLength(1);

      mockedGetTrackedPlan.mockResolvedValue(planB);
      mockedApplyRemoteSharedPlanComments.mockResolvedValue(null);
      mockedCreateSharedPlan.mockResolvedValue(
        makeRemote({ id: remoteId, shareScope: 'team' }),
      );
      mockedSetTrackedPlanShareState.mockImplementation(
        (_projectId, _worktreeId, _planId, share) =>
          resolveUpdatedPlan(planB, share),
      );

      await shareTrackedPlan({
        projectId: 'project-b',
        worktreeId: 'wt-2',
        planId: 'plan-2',
        shareScope: 'team',
        teamId: '22222222-2222-4222-8222-222222222222',
      });

      expect(capturedSubscriptions).toHaveLength(1);
      expect(mockCreatePlanRealtimeSubscription).toHaveBeenCalledTimes(1);
    });

    it('SC7 unit analog: pushes an agent reply and resolution on an unchanged snapshot without staged/submittedToChat keys', async () => {
      jest.useFakeTimers();
      const repositories: SharedPlanRepositoryRef[] = [
        {
          repoId: '__single_repo__',
          repoName: 'Project A',
          remoteUrl: 'https://github.com/acme/repo.git',
          branch: 'feature',
          commitSha: 'abc123',
          defaultBranch: 'main',
        },
      ];
      function sha256Hex(input: string): string {
        return createHash('sha256').update(input).digest('hex');
      }
      function computeExpectedSnapshotHash(
        planForHash: TrackedPlanData,
      ): string {
        const contentHash = sha256Hex(planForHash.content);
        const diagramsHash = sha256Hex(
          stableStringify(planForHash.diagrams ?? null),
        );
        const repositoriesHash = sha256Hex(stableStringify(repositories));
        return sha256Hex(
          buildSharedPlanSnapshotInput({
            contentHash,
            diagramsHash,
            repositoriesHash,
            title: planForHash.title,
            source: planForHash.source,
            reviewStatus: planForHash.reviewStatus,
            localRevisionNumber: planForHash.latestRevisionNumber,
          }),
        );
      }

      const share: TrackedPlanShareState = {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'team',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'placeholder',
      };
      const expectedHash = computeExpectedSnapshotHash(makePlan({ share }));
      const commentThread: PlanCommentThread = {
        id: 'thread-1',
        status: 'resolved',
        createdAt: '2026-06-09T12:00:00.000Z',
        anchor: { quote: 'Some text' },
        anchorState: 'matched',
        comments: [
          {
            id: 'comment-1',
            author: 'remote',
            remoteAuthor: { userId: 'user-2', displayName: 'Ada Lovelace' },
            body: 'What about X?',
            createdAt: '2026-06-09T12:01:00.000Z',
            submittedToChat: true,
          },
          {
            id: 'comment-2',
            author: 'agent',
            body: 'Addressed X.',
            createdAt: '2026-06-09T12:02:00.000Z',
          },
        ],
      };
      const plan = makePlan({
        commentThreads: [commentThread],
        share: { ...share, lastSyncedSnapshotHash: expectedHash },
      });

      mockedGetTrackedPlan.mockResolvedValue(plan);
      mockedBuildSharedPlanRepositoryRefs.mockResolvedValue(repositories);
      mockedUpdateSharedPlan.mockResolvedValue(
        makeRemote({ id: share.remoteId, shareScope: 'team' }),
      );
      mockedApplyRemoteSharedPlanComments.mockResolvedValue(null);
      mockedSetTrackedPlanShareState.mockImplementation(
        (_projectId, _worktreeId, _planId, s) => resolveUpdatedPlan(plan, s),
      );

      queueSharedPlanSync(plan, 'plan');
      await jest.advanceTimersByTimeAsync(1000);

      const call = mockedUpdateSharedPlan.mock.calls.find(
        ([remoteId]) => remoteId === share.remoteId,
      );
      if (!call) {
        throw new Error('Expected updateSharedPlan to have been called');
      }
      const payload = call[1];
      expect(payload.expectedSnapshotHash).toBe(expectedHash);
      const wireThreads = payload.commentThreads ?? [];
      expect(wireThreads).toHaveLength(1);
      const wireThread = wireThreads[0];
      if (!wireThread) {
        throw new Error('Expected a wire comment thread in the payload');
      }
      expect(wireThread).toMatchObject({ id: 'thread-1', status: 'resolved' });

      const agentComment = wireThread.comments.find(
        (comment) => comment.id === 'comment-2',
      );
      if (!agentComment) {
        throw new Error('Expected the agent comment on the wire thread');
      }
      expect(agentComment).toMatchObject({
        author: 'agent',
        body: 'Addressed X.',
      });
      expect(agentComment).not.toHaveProperty('staged');
      expect(agentComment).not.toHaveProperty('submittedToChat');

      const remoteComment = wireThread.comments.find(
        (comment) => comment.id === 'comment-1',
      );
      if (!remoteComment) {
        throw new Error('Expected the remote comment on the wire thread');
      }
      expect(remoteComment).not.toHaveProperty('staged');
      expect(remoteComment).not.toHaveProperty('submittedToChat');
    });
  });

  describe('plan realtime subscription dedup', () => {
    const remoteId = '11111111-1111-4111-8111-111111111111';

    function sharedPlan(overrides: Partial<TrackedPlanData>): TrackedPlanData {
      return makePlan({
        share: {
          serverId: 'canopy-cloud',
          remoteId,
          shareScope: 'private',
          syncStatus: 'synced',
          lastSyncedSnapshotHash: 'server-snapshot',
        },
        ...overrides,
      });
    }

    const planA = sharedPlan({ worktreeId: 'wt-1', id: 'plan-1' });
    const planB = sharedPlan({ worktreeId: 'wt-2', id: 'plan-2' });

    function flushMicrotasks(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve));
    }

    beforeEach(() => {
      const firstWorktree = {
        id: 'wt-1',
        name: 'Worktree 1',
        branchName: 'main',
        createdAt: '2026-06-09T12:00:00.000Z',
        path: '/tmp/wt-1',
      };
      const secondWorktree = {
        id: 'wt-2',
        name: 'Worktree 2',
        branchName: 'main',
        createdAt: '2026-06-09T12:00:00.000Z',
        path: '/tmp/wt-2',
      };
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Project A',
            repoPath: '/tmp/project-a',
            color: 'blue',
            worktrees: [firstWorktree, secondWorktree],
            collapsed: false,
            order: 0,
          },
        ],
      });
      mockedListTrackedPlans.mockImplementation((_projectId, worktreeId) =>
        Promise.resolve(worktreeId === 'wt-1' ? [planA] : [planB]),
      );
      mockedGetSharedPlan.mockResolvedValue(makeRemote({ id: remoteId }));
      mockedApplyRemoteSharedPlanComments.mockResolvedValue(null);
    });

    it('opens one shared subscription for two tuples on one remote plan', async () => {
      await startAllPlanRealtimeSubscriptions();

      expect(mockCreatePlanRealtimeSubscription).toHaveBeenCalledTimes(1);
      expect(capturedSubscriptions).toHaveLength(1);
      expect(capturedSubscriptions[0]?.remoteId).toBe(remoteId);
    });

    it('fans a single signal out to every tuple sharing the remote plan', async () => {
      await startAllPlanRealtimeSubscriptions();

      mockedGetTrackedPlan.mockImplementation((_projectId, worktreeId) =>
        Promise.resolve(worktreeId === 'wt-1' ? planA : planB),
      );
      mockedGetTrackedPlan.mockClear();

      capturedSubscriptions[0]?.onSignal({ planId: remoteId, revision: 2 });
      await flushMicrotasks();

      const worktreeArgs = mockedGetTrackedPlan.mock.calls.map(
        (call) => call[1],
      );
      expect(worktreeArgs).toContain('wt-1');
      expect(worktreeArgs).toContain('wt-2');
      expect(mockedGetSharedPlan).toHaveBeenCalled();
    });

    it('stops the shared subscription only after the last tuple unshares', async () => {
      await startAllPlanRealtimeSubscriptions();
      const subscription = capturedSubscriptions[0];
      if (!subscription) {
        throw new Error('Expected a shared subscription to be created');
      }

      syncPlanRealtimeSubscription({ ...planA, share: undefined });
      expect(subscription.stop).not.toHaveBeenCalled();

      syncPlanRealtimeSubscription({ ...planB, share: undefined });
      expect(subscription.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('detached persistence failures', () => {
    /**
     * Let the real event loop turn so Node reports any rejection nobody
     * handled while the test is still running; Jest fails the test with that
     * rejection. Uses the real `setImmediate` because the fake-timer tests
     * replace the global one.
     */
    async function settleEventLoop(): Promise<void> {
      for (let turn = 0; turn < 3; turn += 1) {
        await new Promise<void>((resolve) => {
          realSetImmediate(resolve);
        });
      }
    }

    function teamSharedPlan(): TrackedPlanData {
      return makePlan({
        share: {
          serverId: 'canopy-cloud',
          remoteId: '11111111-1111-4111-8111-111111111111',
          shareScope: 'team',
          syncStatus: 'synced',
          lastSyncedSnapshotHash: 'previous-server-snapshot',
        },
      });
    }

    afterEach(() => {
      // Drop any debounce timer a test left behind.
      initializeSharedPlanSync({ getWindow: () => null });
    });

    it('logs a failed pending-status write instead of leaking an unhandled rejection', async () => {
      const writeError = new Error('plans file is read-only');
      mockedSetTrackedPlanShareState.mockRejectedValue(writeError);

      expect(() => {
        queueSharedPlanSync(teamSharedPlan(), 'plan');
      }).not.toThrow();
      await settleEventLoop();

      expect(mockLogMainProcessError).toHaveBeenCalledWith(
        expect.stringContaining('plan-1'),
        writeError,
      );
    });

    it('logs a failed background sync run instead of leaking an unhandled rejection', async () => {
      jest.useFakeTimers();
      const plan = teamSharedPlan();
      const readError = new Error('plans file is unreadable');
      mockedSetTrackedPlanShareState.mockImplementation(
        (_projectId, _worktreeId, _planId, share) =>
          resolveUpdatedPlan(plan, share),
      );
      mockedGetTrackedPlan.mockRejectedValue(readError);

      queueSharedPlanSync(plan, 'plan');
      await jest.advanceTimersByTimeAsync(1000);
      await settleEventLoop();

      expect(mockedGetTrackedPlan).toHaveBeenCalled();
      expect(mockLogMainProcessError).toHaveBeenCalledWith(
        expect.stringContaining('plan-1'),
        readError,
      );
    });

    it('logs a failed error-status write after a failed push instead of leaking an unhandled rejection', async () => {
      jest.useFakeTimers();
      const plan = teamSharedPlan();
      const statusError = new Error('plans file is read-only');
      mockedGetTrackedPlan.mockResolvedValue(plan);
      mockedUpdateSharedPlan.mockRejectedValue(
        new CanopyCloudClientError('http-error', 'Server error', 500),
      );
      mockedSetTrackedPlanShareState.mockImplementation(
        (_projectId, _worktreeId, _planId, share) => {
          const nextShare =
            typeof share === 'function' ? share(plan.share) : share;
          return nextShare?.syncStatus === 'error'
            ? Promise.reject(statusError)
            : resolveUpdatedPlan(plan, share);
        },
      );

      queueSharedPlanSync(plan, 'plan');
      await jest.advanceTimersByTimeAsync(1000);
      await settleEventLoop();

      expect(mockedUpdateSharedPlan).toHaveBeenCalled();
      expect(mockLogMainProcessError).toHaveBeenCalledWith(
        expect.stringContaining('plan-1'),
        statusError,
      );
    });
  });
});
