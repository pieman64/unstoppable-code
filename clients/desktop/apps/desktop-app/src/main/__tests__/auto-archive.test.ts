jest.mock('../agents/session-manager', () => ({
  getAllActiveSessionInfos: jest.fn(() => []),
  subscribeChatSessionActivity: jest.fn(() => (): void => undefined),
}));
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({ list: jest.fn() })),
}));
jest.mock('../automations/service', () => ({
  getAutomationsService: jest.fn(() => ({ list: jest.fn() })),
}));
jest.mock('../services/worktree-runtime-status-service', () => ({
  getWorktreeRuntimeStatuses: jest.fn(),
}));
jest.mock('../services/split-lock-service', () => ({
  assertNotSplitDestinationWorktreeClaimed: jest.fn(),
  assertNotSplitLocked: jest.fn(),
  isSplitDestinationWorktreeClaimed: jest.fn(() => false),
  isSplitLocked: jest.fn(() => false),
}));
jest.mock('../lib/app-advisor-workspace', () => ({
  readAppAdvisorWorkspaceSettings: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries-file', () => ({
  readWorkEntriesFile: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  listWorkEntryChatSummaries: jest.fn(),
}));
jest.mock('../lib/work-entry-archive', () => ({ archiveWorkEntry: jest.fn() }));
jest.mock('../lib/worktree-live-cleanup', () => ({
  cleanupLiveWorktreeState: jest.fn(),
  purgeLiveWorktreeObservabilityData: jest.fn(),
}));
jest.mock('../lib/worktree-service', () => ({
  archiveMultiRepoWorktree: jest.fn(),
  archiveSingleRepoWorktree: jest.fn(),
}));
jest.mock('../lib/sidebar-items', () => ({ readAllSidebarItems: jest.fn() }));
jest.mock('../lib/workspace-activity', () => ({
  touchWorkspaceTarget: jest.fn(),
}));

import {
  IPC_CHANNELS,
  type AppAdvisorWatcherSummary,
  type AutomationsListResponse,
  type CoworkWorkEntriesFile,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import {
  LIVE_DELEGATES_REMOVAL_REFUSAL,
  LiveDelegationsError,
  setDelegationActivity,
} from '../agents/delegation/activity';
import { getWorktreeRuntimeStatuses } from '../services/worktree-runtime-status-service';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { readAppAdvisorWorkspaceSettings } from '../lib/app-advisor-workspace';
import { touchWorkspaceTarget } from '../lib/workspace-activity';
import {
  applyAutoArchive,
  collectActiveAutoArchiveTargetKeys,
  collectAutoArchiveCandidates,
  isAutoArchiveRuntimeBusy,
  startAutoArchiveScheduler,
  collectScheduledAutomationTargetKeys,
  collectWatcherTargetKeys,
  createActiveTargetActivityTracker,
  resolveCurrentAutoArchivePolicy,
  shouldTouchAutoArchiveTargetsForTerminalEvent,
  startDrainableAutoArchiveSweeps,
  type AutoArchiveDependencies,
} from '../lib/auto-archive';
import {
  assertWorkspaceTargetRuntimeStartAllowed,
  resetWorkspaceTargetExclusionsForTests,
  withWorkspaceTargetAutoArchiveLease,
  withWorkspaceTargetRuntimeStartReservation,
} from '../lib/workspace-target-exclusion';
import {
  isSplitDestinationWorktreeClaimed,
  isSplitLocked,
} from '../services/split-lock-service';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

afterEach(() => {
  resetWorkspaceTargetExclusionsForTests();
  jest.mocked(isSplitLocked).mockReset().mockReturnValue(false);
  jest
    .mocked(isSplitDestinationWorktreeClaimed)
    .mockReset()
    .mockReturnValue(false);
});

function workEntries(
  entries: CoworkWorkEntriesFile['entries'],
): CoworkWorkEntriesFile {
  return { version: 1, entries };
}

function createDependencies(): AutoArchiveDependencies {
  const sidebarItems: SidebarItem[] = [
    {
      type: 'single-repo',
      id: 'code-1',
      name: 'Code',
      repoPath: '/repo',
      color: '#fff',
      collapsed: false,
      order: 0,
      archiveRetentionDays: 30,
      autoArchiveDays: 7,
      autoArchiveDeleteBranch: true,
      worktrees: [
        {
          id: 'old-tree',
          branchName: 'feature/old',
          createdAt: '2026-07-01T00:00:00.000Z',
          lastTouchedAt: '2026-08-20T00:00:00.000Z',
        },
        {
          id: 'recent-tree',
          branchName: 'feature/recent',
          createdAt: '2026-08-31T00:00:00.000Z',
          lastTouchedAt: '2026-08-31T00:00:00.000Z',
        },
      ],
    },
    {
      type: 'cowork',
      id: 'cowork-1',
      name: 'Cowork',
      color: '#000',
      collapsed: false,
      order: 1,
      archiveRetentionDays: 30,
      autoArchiveDays: 7,
    },
  ];
  const entriesByWorkspace = new Map<string, CoworkWorkEntriesFile>([
    [
      'cowork-1',
      workEntries([
        {
          id: 'old-entry',
          title: 'Old entry',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastTouchedAt: '2026-08-20T00:00:00.000Z',
        },
      ]),
    ],
    ['app-advisor', workEntries([])],
  ]);
  return {
    listSidebarItems: jest.fn().mockResolvedValue(sidebarItems),
    readWorkEntries: jest.fn(async (workspaceId: string) =>
      Promise.resolve(entriesByWorkspace.get(workspaceId) ?? workEntries([])),
    ),
    listWorkEntryChatSummaries: jest.fn((workspaceId: string) => {
      const file = entriesByWorkspace.get(workspaceId) ?? workEntries([]);
      return file.entries.map((entry) => ({
        entryId: entry.id,
        chats: entry.summary?.chats ?? [],
      }));
    }),
    readAppAdvisorSettings: jest.fn().mockResolvedValue({
      version: 1,
      archiveRetentionDays: 30,
      autoArchiveDays: null,
    }),
    listWatchers: jest.fn().mockResolvedValue([]),
    listAutomations: jest.fn().mockResolvedValue({
      activities: [],
      recentRuns: [],
    } satisfies AutomationsListResponse),
    archive: jest.fn().mockResolvedValue(undefined),
    isRuntimeBusy: jest.fn().mockResolvedValue(false),
    touch: jest.fn().mockResolvedValue(undefined),
    onResult: jest.fn(),
  };
}

describe('Auto Delete', () => {
  it('drains an in-flight scheduler sweep and prevents later sweeps on stop', async () => {
    jest.useFakeTimers();
    let finishSweep: (() => void) | undefined;
    const sweep = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSweep = resolve;
        }),
    );
    const stop = startDrainableAutoArchiveSweeps({
      sweep,
      intervalMs: 100,
      onError: jest.fn(),
    });

    expect(sweep).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopPromise = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishSweep?.();
    await stopPromise;
    jest.advanceTimersByTime(200);

    expect(stopped).toBe(true);
    expect(sweep).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('persists completion time when an active target transitions to idle', async () => {
    const collectActiveTargetKeys = jest
      .fn<Set<string>, []>()
      .mockReturnValueOnce(new Set(['workspace-1\0worktree-1']))
      .mockReturnValueOnce(new Set());
    const touch = jest.fn().mockResolvedValue(undefined);
    const now = jest.fn().mockReturnValueOnce(100).mockReturnValueOnce(200);
    const refresh = createActiveTargetActivityTracker({
      collectActiveTargetKeys,
      touch,
      now,
    });

    refresh();
    refresh();
    await Promise.resolve();

    expect(touch).toHaveBeenLastCalledWith('workspace-1', 'worktree-1', 200);
  });

  it('ignores terminal output chunks when scheduling activity sweeps', () => {
    expect(
      shouldTouchAutoArchiveTargetsForTerminalEvent(
        IPC_CHANNELS.terminalOutput,
      ),
    ).toBe(false);
    expect(
      shouldTouchAutoArchiveTargetsForTerminalEvent(
        IPC_CHANNELS.terminalRunningChanged,
      ),
    ).toBe(true);
    expect(
      shouldTouchAutoArchiveTargetsForTerminalEvent(IPC_CHANNELS.terminalExit),
    ).toBe(true);
  });

  it('collects multi-repo and App Advisor targets without treating the legacy Advisor slot as a session', async () => {
    const candidates = await collectAutoArchiveCandidates({
      listSidebarItems: jest.fn().mockResolvedValue([
        {
          type: 'multi-repo',
          id: 'multi-1',
          name: 'Multi',
          color: '#fff',
          collapsed: false,
          order: 0,
          repos: [],
          worktrees: [
            {
              id: 'multi-tree',
              branchName: 'feature/multi',
              createdAt: '2026-08-01T00:00:00.000Z',
            },
          ],
          archiveRetentionDays: 30,
          autoArchiveDays: 10,
        },
      ] satisfies SidebarItem[]),
      readWorkEntries: jest.fn(async (workspaceId: string) =>
        Promise.resolve(
          workspaceId === 'app-advisor'
            ? workEntries([
                {
                  id: 'global',
                  createdAt: '2026-01-01T00:00:00.000Z',
                },
                {
                  id: 'advisor-entry',
                  title: 'Advisor session',
                  createdAt: '2026-08-01T00:00:00.000Z',
                },
              ])
            : workEntries([]),
        ),
      ),
      readAppAdvisorSettings: jest.fn().mockResolvedValue({
        version: 1,
        archiveRetentionDays: 30,
        autoArchiveDays: 5,
      }),
    });

    expect(candidates.map((candidate) => candidate.targetId)).toEqual([
      'multi-tree',
      'advisor-entry',
    ]);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'multi-repo',
          inactivityDays: 10,
        }),
        expect.objectContaining({
          surface: 'app-advisor',
          inactivityDays: 5,
        }),
      ]),
    );
  });

  it('deletes only targets whose durable last touch is beyond the inactivity window', async () => {
    const deps = createDependencies();
    const results = await applyAutoArchive(NOW, deps);

    expect(deps.archive).toHaveBeenCalledTimes(2);
    expect(
      jest
        .mocked(deps.archive)
        .mock.calls.map(([candidate]) => candidate.targetId),
    ).toEqual(['old-tree', 'old-entry']);
    expect(jest.mocked(deps.archive).mock.calls[0]?.[0]).toMatchObject({
      deleteBranch: true,
      inactivityDays: 7,
    });
    expect(results.map((result) => result.status)).toEqual([
      'success',
      'success',
    ]);
    expect(deps.onResult).toHaveBeenCalledTimes(2);
  });

  it('reports cleanup warnings without misclassifying a committed deletion as a retryable failure', async () => {
    const deps = createDependencies();
    jest
      .mocked(deps.archive)
      .mockResolvedValue({ warnings: ['Browser cleanup failed'] } as never);
    const results = await applyAutoArchive(NOW, deps);
    expect(results[0]).toMatchObject({
      status: 'success',
      warnings: ['Browser cleanup failed'],
    });
    expect(deps.onResult).toHaveBeenCalledWith(
      expect.objectContaining({ warnings: ['Browser cleanup failed'] }),
    );
  });

  it('isolates summary hydration failures to their workspace and reports them', async () => {
    const deps = createDependencies();
    jest
      .mocked(deps.listWorkEntryChatSummaries)
      .mockRejectedValue(new Error('Summary backfill denied'));
    const results = await applyAutoArchive(NOW, deps);
    expect(deps.archive).toHaveBeenCalledTimes(1);
    expect(deps.archive).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'old-tree' }),
    );
    expect(results).toEqual([
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({
        status: 'failure',
        error: 'Summary backfill denied',
      }),
    ]);
  });

  it('rejects a queued candidate when the current policy no longer makes it due', async () => {
    const deps = createDependencies();
    const [candidate] = await collectAutoArchiveCandidates(deps);
    if (!candidate) throw new Error('Missing Auto Delete candidate');
    const items = await deps.listSidebarItems();
    const workspace = items.find((item) => item.id === candidate.workspaceId);
    if (!workspace) throw new Error('Missing workspace fixture');
    workspace.autoArchiveDays = 30;
    jest.mocked(deps.listSidebarItems).mockResolvedValue(items);

    await expect(
      resolveCurrentAutoArchivePolicy(candidate, NOW, deps),
    ).rejects.toThrow('Auto Delete policy changed before deletion');
  });

  it('treats a policy revalidation race as a benign exclusion', async () => {
    const deps = createDependencies();
    jest.mocked(deps.archive).mockImplementation(async (candidate) => {
      if (candidate.targetId !== 'old-tree') return;
      const items = await deps.listSidebarItems();
      const workspace = items.find((item) => item.id === candidate.workspaceId);
      if (!workspace) throw new Error('Missing workspace fixture');
      workspace.autoArchiveDays = 30;
      jest.mocked(deps.listSidebarItems).mockResolvedValue(items);
      await resolveCurrentAutoArchivePolicy(candidate, NOW, deps);
    });

    const results = await applyAutoArchive(NOW, deps);

    expect(deps.touch).toHaveBeenCalledWith('code-1', 'old-tree', NOW);
    expect(
      results.map(({ candidate, status }) => ({
        targetId: candidate.targetId,
        status,
      })),
    ).toEqual([{ targetId: 'old-entry', status: 'success' }]);
  });

  it('does not delete a due target while runtime work is active and refreshes its touch', async () => {
    const deps = createDependencies();
    jest
      .mocked(deps.isRuntimeBusy)
      .mockImplementation(async (candidate) =>
        Promise.resolve(candidate.targetId === 'old-tree'),
      );

    await applyAutoArchive(NOW, deps);

    expect(deps.touch).toHaveBeenCalledWith('code-1', 'old-tree', NOW);
    expect(
      jest
        .mocked(deps.archive)
        .mock.calls.map(([candidate]) => candidate.targetId),
    ).toEqual(['old-entry']);
  });

  it('treats a target whose chats have live delegates as busy', async () => {
    const candidates = await collectAutoArchiveCandidates(createDependencies());
    const oldTree = candidates.find(
      (candidate) => candidate.targetId === 'old-tree',
    );
    if (!oldTree) throw new Error('old-tree candidate missing');
    jest.mocked(getWorktreeRuntimeStatuses).mockResolvedValue(new Map());

    await expect(isAutoArchiveRuntimeBusy(oldTree)).resolves.toBe(false);
    setDelegationActivity('auto-archive-busy', 'code-1/old-tree/chat-a', 0, 1);
    try {
      await expect(isAutoArchiveRuntimeBusy(oldTree)).resolves.toBe(true);
    } finally {
      setDelegationActivity('auto-archive-busy', 'code-1/old-tree/chat-a', 0);
    }
  });

  it('treats a live-delegate refusal during deletion as busy, not a failure', async () => {
    const deps = createDependencies();
    jest
      .mocked(deps.archive)
      .mockImplementation(async (candidate) =>
        candidate.targetId === 'old-entry'
          ? Promise.reject(
              new LiveDelegationsError(LIVE_DELEGATES_REMOVAL_REFUSAL),
            )
          : Promise.resolve(undefined),
      );

    const results = await applyAutoArchive(NOW, deps);

    expect(results.map((result) => result.candidate.targetId)).toEqual([
      'old-tree',
    ]);
    expect(deps.onResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failure' }),
    );
    expect(deps.touch).toHaveBeenCalledWith('cowork-1', 'old-entry', NOW);
  });

  it('counts chats with live delegates as active targets', () => {
    expect(collectActiveAutoArchiveTargetKeys().has('code-1\0old-tree')).toBe(
      false,
    );
    setDelegationActivity('auto-archive-active', 'code-1/old-tree/chat-a', 1);
    try {
      expect(collectActiveAutoArchiveTargetKeys().has('code-1\0old-tree')).toBe(
        true,
      );
    } finally {
      setDelegationActivity('auto-archive-active', 'code-1/old-tree/chat-a', 0);
    }
  });

  it('refreshes the inactivity clock when delegate activity changes', async () => {
    jest.mocked(readAllSidebarItems).mockResolvedValue({
      version: 1,
      items: [],
    });
    jest.mocked(readAppAdvisorWorkspaceSettings).mockResolvedValue({
      version: 1,
      archiveRetentionDays: 30,
      autoArchiveDays: null,
    });
    const touch = jest.mocked(touchWorkspaceTarget);
    touch.mockReset().mockResolvedValue(undefined);
    const scheduler = startAutoArchiveScheduler();
    try {
      touch.mockClear();
      setDelegationActivity('auto-archive-touch', 'code-1/old-tree/chat-a', 1);
      expect(touch).toHaveBeenCalledWith(
        'code-1',
        'old-tree',
        expect.any(Number),
      );
      touch.mockClear();
      setDelegationActivity('auto-archive-touch', 'code-1/old-tree/chat-a', 0);
      // The transition to idle stamps the completion time too.
      expect(touch).toHaveBeenCalledWith(
        'code-1',
        'old-tree',
        expect.any(Number),
      );

      scheduler.disposeActivitySubscriptions();
      touch.mockClear();
      setDelegationActivity('auto-archive-touch', 'code-1/old-tree/chat-a', 1);
      expect(touch).not.toHaveBeenCalled();
    } finally {
      setDelegationActivity('auto-archive-touch', 'code-1/old-tree/chat-a', 0);
      scheduler.disposeActivitySubscriptions();
      await scheduler.stopScheduling();
    }
  });

  it('treats split-protected worktrees as busy and refreshes their touch', async () => {
    const deps = createDependencies();
    jest
      .mocked(isSplitLocked)
      .mockImplementation(
        (workspaceId, worktreeId) =>
          workspaceId === 'code-1' && worktreeId === 'old-tree',
      );
    jest.mocked(isSplitDestinationWorktreeClaimed).mockReturnValue(false);

    const results = await applyAutoArchive(NOW, deps);

    expect(deps.touch).toHaveBeenCalledWith('code-1', 'old-tree', NOW);
    expect(
      jest
        .mocked(deps.archive)
        .mock.calls.map(([candidate]) => candidate.targetId),
    ).toEqual(['old-entry']);
    expect(results).toEqual([expect.objectContaining({ status: 'success' })]);
  });

  it('treats split destination claims as busy and refreshes their touch', async () => {
    const deps = createDependencies();
    jest.mocked(isSplitLocked).mockReturnValue(false);
    jest
      .mocked(isSplitDestinationWorktreeClaimed)
      .mockImplementation(
        (workspaceId, worktreeId) =>
          workspaceId === 'code-1' && worktreeId === 'old-tree',
      );

    await applyAutoArchive(NOW, deps);

    expect(deps.touch).toHaveBeenCalledWith('code-1', 'old-tree', NOW);
    expect(
      jest
        .mocked(deps.archive)
        .mock.calls.map(([candidate]) => candidate.targetId),
    ).toEqual(['old-entry']);
  });

  it('holds a target exclusion lease through the archive operation', async () => {
    const deps = createDependencies();
    jest.mocked(deps.archive).mockImplementation((candidate) => {
      expect(() =>
        assertWorkspaceTargetRuntimeStartAllowed(
          candidate.workspaceId,
          candidate.targetId,
        ),
      ).toThrow('being automatically deleted');
      return Promise.resolve();
    });

    await applyAutoArchive(NOW, deps);

    expect(deps.archive).toHaveBeenCalledTimes(2);
  });

  it('refuses an Auto Delete lease while runtime startup is reserved', async () => {
    let releaseStart: (() => void) | undefined;
    const startPending = withWorkspaceTargetRuntimeStartReservation(
      'code-1',
      'old-tree',
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );

    await expect(
      withWorkspaceTargetAutoArchiveLease('code-1', 'old-tree', () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('activity changed before Auto Delete');
    if (!releaseStart) throw new Error('runtime start did not begin');
    releaseStart();
    await startPending;
  });

  it('treats a runtime-start reservation race as busy instead of reporting a failure', async () => {
    const deps = createDependencies();
    let releaseStart: (() => void) | undefined;
    const startPending = withWorkspaceTargetRuntimeStartReservation(
      'code-1',
      'old-tree',
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );

    const results = await applyAutoArchive(NOW, deps);

    expect(deps.touch).toHaveBeenCalledWith('code-1', 'old-tree', NOW);
    expect(
      results.map(({ candidate, status }) => ({
        targetId: candidate.targetId,
        status,
      })),
    ).toEqual([{ targetId: 'old-entry', status: 'success' }]);
    if (!releaseStart) throw new Error('runtime start did not begin');
    releaseStart();
    await startPending;
  });

  it('continues deleting other targets when refreshing a busy target fails', async () => {
    const deps = createDependencies();
    jest
      .mocked(deps.isRuntimeBusy)
      .mockImplementation(async (candidate) =>
        Promise.resolve(candidate.targetId === 'old-tree'),
      );
    jest.mocked(deps.touch).mockRejectedValueOnce(new Error('touch failed'));

    await expect(applyAutoArchive(NOW, deps)).resolves.toEqual([
      expect.objectContaining({ status: 'success' }),
    ]);
    expect(deps.archive).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'old-entry' }),
    );
  });

  it('hydrates legacy Work Entry chat ownership before applying watcher protection', async () => {
    const listWorkEntryChatSummaries = jest
      .fn()
      .mockResolvedValue([
        { entryId: 'old-entry', chats: [{ id: 'legacy-chat' }] },
      ]);
    const deps: AutoArchiveDependencies = {
      ...createDependencies(),
      listWorkEntryChatSummaries,
    };
    jest.mocked(deps.listWatchers).mockResolvedValue([
      {
        id: 'watcher-legacy',
        trigger: 'standalone_chat_completion',
        status: 'active',
        label: 'Legacy chat watcher',
        target: {
          kind: 'standalone_chat',
          projectId: 'cowork-1',
          chatId: 'legacy-chat',
        },
        destination: {
          projectId: 'app-advisor',
          worktreeId: 'advisor-entry',
          chatId: 'advisor-chat',
        },
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ]);

    await applyAutoArchive(NOW, deps);

    expect(listWorkEntryChatSummaries).toHaveBeenCalledWith('cowork-1');
    expect(deps.touch).toHaveBeenCalledWith('cowork-1', 'old-entry', NOW);
    expect(
      jest
        .mocked(deps.archive)
        .mock.calls.some(([candidate]) => candidate.targetId === 'old-entry'),
    ).toBe(false);
  });

  it('deletes targets carrying a legacy Auto Archive lock', async () => {
    const deps = createDependencies();
    const sidebarItems = await deps.listSidebarItems();
    const code = sidebarItems.find((item) => item.id === 'code-1');
    if (!code || code.type === 'cowork')
      throw new Error('Missing code fixture');
    code.worktrees[0] = {
      ...code.worktrees[0],
      autoArchiveLocked: true,
    };
    jest.mocked(deps.listSidebarItems).mockResolvedValue(sidebarItems);
    jest.mocked(deps.readWorkEntries).mockImplementation(async (workspaceId) =>
      Promise.resolve(
        workspaceId === 'cowork-1'
          ? workEntries([
              {
                id: 'old-entry',
                title: 'Old entry',
                createdAt: '2026-08-01T00:00:00.000Z',
                lastTouchedAt: '2026-08-20T00:00:00.000Z',
                autoArchiveLocked: true,
              },
            ])
          : workEntries([]),
      ),
    );

    const results = await applyAutoArchive(NOW, deps);

    expect(results).toHaveLength(2);
    expect(
      jest
        .mocked(deps.archive)
        .mock.calls.map(([candidate]) => candidate.targetId),
    ).toEqual(['old-tree', 'old-entry']);
    expect(deps.touch).not.toHaveBeenCalled();
  });

  it('treats active watchers and enabled scheduled automations as target-specific activity', () => {
    const watchers = [
      {
        id: 'watcher-1',
        trigger: 'worktree_chat_completion',
        status: 'active',
        label: 'Watch',
        target: {
          kind: 'standalone_chat',
          projectId: 'cowork-1',
          chatId: 'chat-1',
        },
        destination: {
          projectId: 'app-advisor',
          worktreeId: 'advisor-entry',
          chatId: 'advisor-chat',
        },
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ] satisfies AppAdvisorWatcherSummary[];
    expect(
      collectWatcherTargetKeys(
        watchers,
        new Map([['cowork-1\0chat-1', 'entry-1']]),
      ),
    ).toEqual(new Set(['cowork-1\0entry-1', 'app-advisor\0advisor-entry']));

    const activities = [
      {
        version: 1,
        id: 'automation-1',
        name: 'Scheduled send',
        enabled: true,
        schedule: {
          kind: 'cron',
          expression: '0 9 * * *',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'code-1',
          worktreeId: 'tree-1',
          chatId: 'chat-1',
          prompt: 'Continue',
        },
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        failureCount: 0,
      },
    ] satisfies AutomationsListResponse['activities'];
    expect(collectScheduledAutomationTargetKeys(activities, new Set())).toEqual(
      new Set(['code-1\0tree-1']),
    );

    // A new chat each run in an existing Work Entry protects that entry too.
    const entryActivities = [
      {
        ...activities[0],
        id: 'automation-cowork',
        action: {
          type: 'standalone_prompt',
          chatProjectId: 'cowork-1',
          workEntryId: 'entry-1',
          prompt: 'Summarize',
        },
      },
      {
        ...activities[0],
        id: 'automation-advisor',
        action: {
          type: 'app_advisor_prompt',
          workEntryId: 'advisor-entry',
          prompt: 'Summarize',
        },
      },
      {
        ...activities[0],
        id: 'automation-advisor-fresh',
        action: { type: 'app_advisor_prompt', prompt: 'Summarize' },
      },
    ] satisfies AutomationsListResponse['activities'];
    expect(
      collectScheduledAutomationTargetKeys(entryActivities, new Set()),
    ).toEqual(new Set(['cowork-1\0entry-1', 'app-advisor\0advisor-entry']));
  });

  it('reports an archive failure without preventing later due targets', async () => {
    const deps = createDependencies();
    jest.mocked(deps.archive).mockImplementation((candidate) => {
      return candidate.targetId === 'old-tree'
        ? Promise.reject(new Error('capture failed'))
        : Promise.resolve();
    });

    const results = await applyAutoArchive(NOW, deps);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'failure',
          error: 'capture failed',
        }),
        expect.objectContaining({ status: 'success' }),
      ]),
    );
    expect(deps.archive).toHaveBeenCalledTimes(2);
  });
});
