// Native profile transactions are exercised with real registries in browser-profile-service.test.ts.
jest.mock('../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() =>
    Promise.resolve('profile-retirement'),
  ),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
}));
jest.mock('node:fs/promises');
const mockRetireCostScope = jest.fn(() => Promise.resolve());
jest.mock('../cost-index/service', () => ({
  getDesktopCostIndexStore: (): {
    retireScope: typeof mockRetireCostScope;
  } => ({ retireScope: mockRetireCostScope }),
}));
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<object>('../lib/main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));
const mockCancelLocalScope = jest.fn(() => Promise.resolve());
const mockReleaseLocalScopeFence = jest.fn(() => Promise.resolve());
const mockCommitLocalScopeCancellation = jest.fn();
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalScope: mockCancelLocalScope,
    releaseLocalScopeFence: mockReleaseLocalScopeFence,
    commitLocalScopeCancellation: mockCommitLocalScopeCancellation,
  })),
}));
jest.mock('electron', () => ({
  app: {
    getVersion: jest.fn(() => '0.0.0-test'),
  },
}));
jest.mock('../lib/paths', () => ({
  getChatArchivesFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/chat-archives/${worktreeId}.json`,
  ),
  getChatTabsFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/chats/${worktreeId}.json`,
  ),
  getWorktreeBrowserStateFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/browser/${worktreeId}.json`,
  ),
  getWorktreeAttachmentsDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/attachments/${worktreeId}`,
  ),
  getWorktreeDataDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktree-data/${worktreeId}`,
  ),
  getWorktreeDataRootDir: jest.fn(
    (projectId: string) => `/mock/workspaces/${projectId}/worktree-data`,
  ),
  getWorktreeSummaryFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/summaries/${worktreeId}.json`,
  ),
  getEntryCostDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/cost/${worktreeId}`,
  ),
}));
const mockedListTrackedPlans = jest.fn<
  Promise<Array<{ id: string }>>,
  [string, string]
>((): Promise<Array<{ id: string }>> => Promise.resolve([]));
jest.mock('../lib/plan-persistence', () => ({
  deleteTrackedPlansForWorktree: jest.fn(() => Promise.resolve()),
  listTrackedPlans: (
    projectId: string,
    worktreeId: string,
  ): Promise<Array<{ id: string }>> =>
    mockedListTrackedPlans(projectId, worktreeId),
}));
const mockedRemovePlanExploreChatsForWorktree = jest.fn<
  Promise<string[]>,
  [string, string, readonly string[]]
>((): Promise<string[]> => Promise.resolve([]));
const mockedReleasePlanFileSyncForWorktree = jest.fn<void, [string, string]>();
const mockedRemoveCodeReviewChatsForWorktree = jest.fn<
  Promise<string[]>,
  [string, string]
>((): Promise<string[]> => Promise.resolve([]));
jest.mock('../lib/code-review-cleanup', () => ({
  removeCodeReviewChatsForWorktree: (
    ...args: [string, string]
  ): Promise<string[]> => mockedRemoveCodeReviewChatsForWorktree(...args),
}));
jest.mock('../lib/plan-explore-cleanup', () => ({
  removePlanExploreChatsForWorktree: (
    ...args: [string, string, readonly string[]]
  ): Promise<string[]> => mockedRemovePlanExploreChatsForWorktree(...args),
  releasePlanFileSyncForWorktree: (...args: [string, string]): void => {
    mockedReleasePlanFileSyncForWorktree(...args);
  },
}));
jest.mock('../lib/detected-plan-persistence', () => ({
  deleteDetectedPlansForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/script-log-store', () => ({
  deleteScriptRunLogsForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/split-pr-persistence', () => ({
  deleteSplitPrMapForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/hook-log-store', () => ({
  deleteHookRunLogsForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));
const mockPurgeLivePersistedWorktreeData = jest.fn(() => Promise.resolve());
const mockPeekObservabilityService = jest.fn(
  (): { purgePersistedWorktreeData: jest.Mock } | null => null,
);
jest.mock('../observability', () => ({
  peekObservabilityService: (): unknown => mockPeekObservabilityService(),
}));
jest.mock('../observability/worktree-cleanup', () => ({
  purgePersistedWorktreeObservabilityData: jest.fn(() => Promise.resolve()),
}));
jest.mock('../browser/browser-service-registry', () => ({
  getBrowserService: jest.fn(() => null),
}));
const mockedCancelPendingLayoutWrite = jest.fn();
jest.mock('../panels/persistence', () => ({
  panelLayoutPersistenceStore: {
    cancelPendingWrite: (...args: unknown[]): unknown =>
      mockedCancelPendingLayoutWrite(...args),
  },
}));
const mockedForgetTerminalWorktree = jest.fn();
jest.mock('../terminal/persistence', () => ({
  terminalPersistenceStore: {
    forgetWorktree: (...args: unknown[]): unknown =>
      mockedForgetTerminalWorktree(...args),
  },
}));
const mockedCloseWorktree = jest.fn(() => Promise.resolve());
jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: jest.fn(() => ({
    closeWorktree: mockedCloseWorktree,
  })),
}));
const mockedCancelCodeGraphBuilds = jest.fn();
jest.mock('../lib/code-graph-scheduler', () => ({
  cancelCodeGraphBuilds: (...args: unknown[]): unknown =>
    mockedCancelCodeGraphBuilds(...args),
}));
const mockedCancelBuild = jest.fn<
  Promise<void>,
  Parameters<typeof CodeGraphBuildRunner.cancelBuild>
>(() => Promise.resolve());
jest.mock('../code-graph/build-runner', () => ({
  cancelBuild: (
    ...args: Parameters<typeof CodeGraphBuildRunner.cancelBuild>
  ): Promise<void> => mockedCancelBuild(...args),
}));
const mockedDrainDaemonCodeGraph = jest.fn<Promise<void>, [string, string]>(
  () => Promise.resolve(),
);
jest.mock('../code-graph/daemon-code-graph-route', () => ({
  drainDaemonCodeGraphWorktree: (
    workspaceId: string,
    worktreeId: string,
  ): Promise<void> => mockedDrainDaemonCodeGraph(workspaceId, worktreeId),
}));
const mockedCancelCodeGraphReads = jest.fn<Promise<void>, [string]>(
  (): Promise<void> => Promise.resolve(),
);
jest.mock('../code-graph/read-runner', () => ({
  cancelCodeGraphReads: (key: string): Promise<void> =>
    mockedCancelCodeGraphReads(key),
  // The fence itself is covered against the real runner in
  // worktree-data-cleanup-read-workers.test.ts.
  fenceCodeGraphReads: (): (() => void) => (): void => undefined,
}));
const mockedCancelCodeGraphFingerprint = jest.fn<Promise<void>, [string]>(
  (): Promise<void> => Promise.resolve(),
);
jest.mock('../code-graph/fingerprint-runner', () => ({
  cancelCodeGraphFingerprint: (key: string): Promise<void> =>
    mockedCancelCodeGraphFingerprint(key),
}));
const mockedDeleteWorktreeSearchDocs = jest.fn();
const mockedArchiveWorktreeSearchDocs = jest.fn();
jest.mock('../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorktreeDocs: mockedDeleteWorktreeSearchDocs,
    worktreeContainerArchived: mockedArchiveWorktreeSearchDocs,
  })),
}));
const mockedDeleteChatScope = jest.fn((): Promise<void> => Promise.resolve());
const mockedRunWithScopeDeletion = jest.fn(
  async (
    _scope: { projectId: string; worktreeId: string },
    operation: () => Promise<unknown>,
  ): Promise<unknown> => operation(),
);
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    deleteScope: mockedDeleteChatScope,
    runWithScopeDeletion: mockedRunWithScopeDeletion,
  })),
}));
const mockedRemovePersistedWorktreeDataDirectory = jest.fn<
  Promise<void>,
  [string, string]
>((): Promise<void> => Promise.resolve());
jest.mock('@canopy/desktop-shared/node/lib/worktree-data-cleanup', () => ({
  removePersistedWorktreeDataDirectory: (
    ...args: [string, string]
  ): Promise<void> => mockedRemovePersistedWorktreeDataDirectory(...args),
}));

import { rm } from 'node:fs/promises';
import type * as CodeGraphBuildRunner from '../code-graph/build-runner';
import { removeTreeWithoutAsar } from '../lib/remove-tree-without-asar';
import { deleteHookRunLogsForWorktree } from '../lib/hook-log-store';
import { deleteDetectedPlansForWorktree } from '../lib/detected-plan-persistence';
import { deleteTrackedPlansForWorktree } from '../lib/plan-persistence';
import { deleteScriptRunLogsForWorktree } from '../lib/script-log-store';
import { deleteSplitPrMapForWorktree } from '../lib/split-pr-persistence';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { cleanupWorktreeChatPluginDirs } from '../plugins/plugin-cleanup';
import { purgePersistedWorktreeObservabilityData } from '../observability/worktree-cleanup';
import { retireRemovedBrowserTask } from '../browser/browser-profile-lifecycle';
import {
  BROWSER_RETIREMENT_DEADLINE_MS,
  runWithBrowserRetirementDeadlineScope,
  withBrowserRetirementDeadline,
} from '../lib/browser-retirement-deadline';
import { getBrowserService } from '../browser/browser-service-registry';
import { logMainProcessWarn } from '../lib/main-process-logging';

const mockedRm = jest.mocked(rm);
const mockedDeleteDetectedPlansForWorktree = jest.mocked(
  deleteDetectedPlansForWorktree,
);
const mockedDeleteTrackedPlansForWorktree = jest.mocked(
  deleteTrackedPlansForWorktree,
);
const mockedDeleteScriptRunLogsForWorktree = jest.mocked(
  deleteScriptRunLogsForWorktree,
);
const mockedDeleteSplitPrMapForWorktree = jest.mocked(
  deleteSplitPrMapForWorktree,
);
const mockedDeleteHookRunLogsForWorktree = jest.mocked(
  deleteHookRunLogsForWorktree,
);
const mockedCleanupWorktreeChatPluginDirs = jest.mocked(
  cleanupWorktreeChatPluginDirs,
);
const mockedPurgePersistedWorktreeObservabilityData = jest.mocked(
  purgePersistedWorktreeObservabilityData,
);

describe('worktree-data-cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRm.mockResolvedValue(undefined);
    mockedRemovePersistedWorktreeDataDirectory.mockResolvedValue(undefined);
  });

  it('removes all persisted worktree-scoped data', async () => {
    const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(mockCancelLocalScope).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(warnings).toEqual([]);
    expect(mockedRemoveCodeReviewChatsForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockRetireCostScope).toHaveBeenCalledWith({
      kind: 'entry',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/cost/wt-1',
      {
        recursive: true,
        force: true,
      },
    );
    expect(mockedDeleteChatScope).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
    expect(mockedDeleteWorktreeSearchDocs).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/summaries/wt-1.json',
      { force: true },
    );
    expect(mockedCancelPendingLayoutWrite).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    // The pending layout write is cancelled immediately before the tree goes.
    expect(
      mockedCancelPendingLayoutWrite.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedRemovePersistedWorktreeDataDirectory.mock.invocationCallOrder[0],
    );
    expect(mockedForgetTerminalWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    // Terminal state is forgotten with the layout, right before the tree goes.
    expect(
      mockedForgetTerminalWorktree.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedRemovePersistedWorktreeDataDirectory.mock.invocationCallOrder[0],
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/attachments/wt-1',
      {
        recursive: true,
        force: true,
      },
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/browser/wt-1.json',
      { force: true },
    );
    expect(mockedRemovePersistedWorktreeDataDirectory).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      {
        worktreeDataRootDir: '/mock/workspaces/project-1/worktree-data',
        removeTree: removeTreeWithoutAsar,
      },
    );
    expect(mockedDeleteTrackedPlansForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedDeleteDetectedPlansForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedDeleteScriptRunLogsForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedDeleteHookRunLogsForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedDeleteSplitPrMapForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedCleanupWorktreeChatPluginDirs).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedPurgePersistedWorktreeObservabilityData).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedCloseWorktree).toHaveBeenCalledWith('project-1', 'wt-1');
  });

  it('reports unreadable legacy review ownership while continuing unrelated cleanup', async () => {
    mockedRemoveCodeReviewChatsForWorktree.mockRejectedValueOnce(
      Object.assign(new Error('registry read denied'), { code: 'EACCES' }),
    );

    const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(warnings).toEqual([
      'Failed to remove legacy review chats for this worktree: permission denied',
    ]);
    expect(mockedRemoveCodeReviewChatsForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedDeleteTrackedPlansForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedDeleteChatScope).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
  });

  it('preserves legacy review cleanup warnings returned after a partial sweep', async () => {
    const warning =
      'Failed to remove legacy review chat review-a: registry write failed';
    mockedRemoveCodeReviewChatsForWorktree.mockResolvedValueOnce([warning]);

    await expect(
      cleanupPersistedWorktreeData('project-1', 'wt-1'),
    ).resolves.toEqual([warning]);
  });

  it('still closes browser views and removes tab state when profile retirement fails', async () => {
    const destroyWorktree = jest.fn(() => Promise.resolve());
    jest
      .mocked(getBrowserService)
      .mockReturnValueOnce({ destroyWorktree } as unknown as ReturnType<
        typeof getBrowserService
      >);
    jest
      .mocked(retireRemovedBrowserTask)
      .mockRejectedValueOnce(new Error('profile metadata unavailable'));

    const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(destroyWorktree).toHaveBeenCalledWith('project-1', 'wt-1', {
      clearStorage: false,
      deletingTarget: true,
    });
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/browser/wt-1.json',
      { force: true },
    );
    expect(warnings).toEqual([
      expect.stringMatching(/browser tab state.*profile metadata unavailable/),
    ]);
  });

  it('still closes browser views and removes tab state when profile retirement never answers', async () => {
    const destroyWorktree = jest.fn(() => Promise.resolve());
    jest
      .mocked(getBrowserService)
      .mockReturnValueOnce({ destroyWorktree } as unknown as ReturnType<
        typeof getBrowserService
      >);
    const retire = jest.mocked(retireRemovedBrowserTask);
    retire.mockImplementationOnce(() => new Promise<void>(() => undefined));
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    try {
      const cleanup = cleanupPersistedWorktreeData('project-1', 'wt-1');
      for (
        let turn = 0;
        turn < 100 && retire.mock.calls.length === 0;
        turn += 1
      )
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      expect(retire).toHaveBeenCalledTimes(1);
      // This cleanup runs while the archive holds its project lock, so an
      // unanswered profile call would hold every later archive in the project.
      jest.advanceTimersByTime(BROWSER_RETIREMENT_DEADLINE_MS);

      const warnings = await cleanup;

      expect(destroyWorktree).toHaveBeenCalledWith('project-1', 'wt-1', {
        clearStorage: false,
        deletingTarget: true,
      });
      expect(mockedRm).toHaveBeenCalledWith(
        '/mock/workspaces/project-1/browser/wt-1.json',
        { force: true },
      );
      // Tab state is gone and the abandoned retirement still finishes once
      // metadata answers, with startup reconciliation as its retry, so a
      // timeout is logged rather than reported as a failed removal.
      expect(warnings).toEqual([]);
      expect(logMainProcessWarn).toHaveBeenCalledWith(
        'Worktree cleanup deferred browser profile retirement',
        { operation: 'worktree_data_cleanup', code: 'timeout' },
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not report tab state as failed when its archive already skips profile calls', async () => {
    const destroyWorktree = jest.fn(() => Promise.resolve());
    jest
      .mocked(getBrowserService)
      .mockReturnValueOnce({ destroyWorktree } as unknown as ReturnType<
        typeof getBrowserService
      >);
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    try {
      const warnings = await runWithBrowserRetirementDeadlineScope(async () => {
        // An earlier profile call of the same archive is still unanswered.
        const expired = withBrowserRetirementDeadline(
          () => new Promise<void>(() => undefined),
        ).catch(() => undefined);
        jest.advanceTimersByTime(BROWSER_RETIREMENT_DEADLINE_MS);
        await expired;
        return cleanupPersistedWorktreeData('project-1', 'wt-1');
      });

      expect(retireRemovedBrowserTask).not.toHaveBeenCalled();
      expect(destroyWorktree).toHaveBeenCalledWith('project-1', 'wt-1', {
        clearStorage: false,
        deletingTarget: true,
      });
      expect(mockedRm).toHaveBeenCalledWith(
        '/mock/workspaces/project-1/browser/wt-1.json',
        { force: true },
      );
      expect(warnings).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes every plan-explore chat scope owned by the worktree before dropping its plans', async () => {
    const order: string[] = [];
    mockedListTrackedPlans.mockResolvedValueOnce([
      { id: 'plan-a' },
      { id: 'plan-b' },
    ]);
    mockedRemovePlanExploreChatsForWorktree.mockImplementationOnce(
      (): Promise<string[]> => {
        order.push('plan-explore');
        return Promise.resolve([
          'Failed to remove plan-explore chat state for plan plan-b: busy',
        ]);
      },
    );
    mockedDeleteTrackedPlansForWorktree.mockImplementationOnce(
      (): Promise<void> => {
        order.push('tracked-plans');
        return Promise.resolve();
      },
    );

    const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(mockedListTrackedPlans).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(mockedRemovePlanExploreChatsForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      ['plan-a', 'plan-b'],
    );
    // Plan ids are read (and their explore chats removed) before the tracked
    // plans file that lists them is deleted.
    expect(order).toEqual(['plan-explore', 'tracked-plans']);
    expect(warnings).toEqual([
      'Failed to remove plan-explore chat state for plan plan-b: busy',
    ]);
  });

  it('still sweeps registry-owned plan-explore chats when the plans file cannot be resolved', async () => {
    mockedListTrackedPlans.mockRejectedValueOnce(
      new Error('Tracked plans are not available for cowork project project-1'),
    );

    await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(mockedRemovePlanExploreChatsForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      [],
    );
    expect(mockedDeleteTrackedPlansForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
  });

  it('keeps legacy plan chats with an archived worktree and releases only its plan-file sync', async () => {
    const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1', {
      chatSearchDisposition: 'container-archived',
    });

    expect(warnings).toEqual([]);
    // The archive's captured plan ids reclaim these chats when it is
    // permanently deleted; a restore brings them back with the worktree.
    expect(mockedRemovePlanExploreChatsForWorktree).not.toHaveBeenCalled();
    expect(mockedRemoveCodeReviewChatsForWorktree).not.toHaveBeenCalled();
    expect(mockedReleasePlanFileSyncForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedDeleteTrackedPlansForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
  });

  it('releases the local watcher fence when cancellation itself fails', async () => {
    mockCancelLocalScope.mockRejectedValueOnce(
      new Error('watcher cancellation failed'),
    );

    await expect(
      cleanupPersistedWorktreeData('project-1', 'wt-1'),
    ).rejects.toThrow('watcher cancellation failed');

    expect(mockReleaseLocalScopeFence).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedRemovePersistedWorktreeDataDirectory).not.toHaveBeenCalled();
  });

  it('keeps the local watcher fence when cancellation commit fails after deletion', async () => {
    mockCommitLocalScopeCancellation.mockRejectedValueOnce(
      new Error('watcher cancellation commit failed'),
    );

    await expect(
      cleanupPersistedWorktreeData('project-1', 'wt-1'),
    ).rejects.toThrow('watcher cancellation commit failed');

    expect(mockedRemovePersistedWorktreeDataDirectory).toHaveBeenCalled();
    expect(mockReleaseLocalScopeFence).not.toHaveBeenCalled();
  });

  it('changes only the search disposition when preserving an archived container', async () => {
    const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1', {
      chatSearchDisposition: 'container-archived',
    });

    expect(warnings).toEqual([]);
    expect(mockedArchiveWorktreeSearchDocs).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedDeleteWorktreeSearchDocs).not.toHaveBeenCalled();
    expect(mockedCleanupWorktreeChatPluginDirs).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedPurgePersistedWorktreeObservabilityData).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedCancelCodeGraphBuilds).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedCancelBuild).toHaveBeenCalledWith('project-1/wt-1');
    expect(mockedCancelCodeGraphReads).toHaveBeenCalledWith('project-1/wt-1');
    expect(mockedCloseWorktree).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(
      mockedCancelCodeGraphBuilds.mock.invocationCallOrder[0],
    ).toBeLessThan(mockedCloseWorktree.mock.invocationCallOrder[0] ?? 0);
    expect(mockedCancelBuild.mock.invocationCallOrder[0]).toBeLessThan(
      mockedCloseWorktree.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockedCancelCodeGraphReads.mock.invocationCallOrder[0]).toBeLessThan(
      mockedCloseWorktree.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockedRemovePersistedWorktreeDataDirectory).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      {
        worktreeDataRootDir: '/mock/workspaces/project-1/worktree-data',
        removeTree: removeTreeWithoutAsar,
      },
    );
  });

  it('rejects traversal ids before scheduling cleanup tasks', async () => {
    await expect(
      cleanupPersistedWorktreeData('project-1', '../escape'),
    ).rejects.toThrow('Invalid worktreeId');
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedRemovePersistedWorktreeDataDirectory).not.toHaveBeenCalled();
  });

  it('cancels pending code graph builds before closing the engine', async () => {
    await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(mockedCancelCodeGraphBuilds).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    // The cancel must run before closeWorktree: otherwise a build debounced at
    // worktree creation can fire after the engine is closed and worktree-data
    // is rm -rf'd, resurrecting graph.db for the just-deleted worktree.
    const cancelOrder = mockedCancelCodeGraphBuilds.mock.invocationCallOrder[0];
    const closeOrder = mockedCloseWorktree.mock.invocationCallOrder[0];
    expect(cancelOrder).toBeDefined();
    expect(closeOrder).toBeDefined();
    expect(cancelOrder).toBeLessThan(closeOrder ?? 0);
  });

  it('cancels the in-flight worker build before closing the engine', async () => {
    await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(mockedCancelBuild).toHaveBeenCalledWith('project-1/wt-1');
    // A live off-main build worker holds its own DatabaseSync connection to
    // this same graph.db and may be mid-write, so it must be canceled before
    // closeWorktree (and, transitively, before the worktree-metadata rm)
    // below — otherwise closing/removing around a still-running worker would
    // race a write in progress from a different process.
    const cancelBuildOrder = mockedCancelBuild.mock.invocationCallOrder[0];
    const closeOrder = mockedCloseWorktree.mock.invocationCallOrder[0];
    expect(cancelBuildOrder).toBeDefined();
    expect(closeOrder).toBeDefined();
    expect(cancelBuildOrder).toBeLessThan(closeOrder ?? 0);
  });

  it('drains the daemon builds it started before closing the engine', async () => {
    await cleanupPersistedWorktreeData('project-1', 'wt-1');

    // A daemon build host writes the same graph.db under the same lease
    // (CAN-5089); one still running could recreate the removed graph.
    expect(mockedDrainDaemonCodeGraph).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    const drainOrder = mockedDrainDaemonCodeGraph.mock.invocationCallOrder[0];
    const closeOrder = mockedCloseWorktree.mock.invocationCallOrder[0];
    expect(drainOrder).toBeDefined();
    expect(drainOrder).toBeLessThan(closeOrder ?? 0);
  });

  it('awaits matching read workers before closing and removing graph data', async () => {
    await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(mockedCancelCodeGraphReads).toHaveBeenCalledWith('project-1/wt-1');
    const cancelOrder = mockedCancelCodeGraphReads.mock.invocationCallOrder[0];
    const closeOrder = mockedCloseWorktree.mock.invocationCallOrder[0];
    expect(cancelOrder).toBeDefined();
    expect(closeOrder).toBeDefined();
    expect(cancelOrder).toBeLessThan(closeOrder ?? 0);
  });

  it('awaits matching fingerprint workers before closing and removing graph data', async () => {
    await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(mockedCancelCodeGraphFingerprint).toHaveBeenCalledWith(
      'project-1/wt-1',
    );
    const cancelOrder =
      mockedCancelCodeGraphFingerprint.mock.invocationCallOrder[0];
    const closeOrder = mockedCloseWorktree.mock.invocationCallOrder[0];
    expect(cancelOrder).toBeDefined();
    expect(closeOrder).toBeDefined();
    expect(cancelOrder).toBeLessThan(closeOrder ?? 0);
  });

  it('awaits worker-build cancellation (kill + settled) before closing the engine and removing metadata', async () => {
    let resolveCancel: (() => void) | undefined;
    mockedCancelBuild.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCancel = resolve;
      }),
    );

    const cleanupPromise = cleanupPersistedWorktreeData('project-1', 'wt-1');
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The worker cancel has been issued but has not yet settled (the killed
    // worker has not exited): the engine close — and, transitively, the
    // worktree-data rm — must still be pending.
    expect(mockedCancelBuild).toHaveBeenCalledWith('project-1/wt-1');
    expect(mockedCloseWorktree).not.toHaveBeenCalled();
    expect(mockedRemovePersistedWorktreeDataDirectory).not.toHaveBeenCalled();

    resolveCancel?.();
    await expect(cleanupPromise).resolves.toEqual([]);
    expect(mockedCloseWorktree).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(mockedRemovePersistedWorktreeDataDirectory).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      {
        worktreeDataRootDir: '/mock/workspaces/project-1/worktree-data',
        removeTree: removeTreeWithoutAsar,
      },
    );
  });

  it('closes the code graph engine before removing the metadata root', async () => {
    let resolveCloseWorktree: (() => void) | undefined;
    mockedCloseWorktree.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCloseWorktree = resolve;
      }),
    );

    const cleanupPromise = cleanupPersistedWorktreeData('project-1', 'wt-1');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockedCloseWorktree).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(mockedRemovePersistedWorktreeDataDirectory).not.toHaveBeenCalled();

    resolveCloseWorktree?.();
    await expect(cleanupPromise).resolves.toEqual([]);
    expect(mockedRemovePersistedWorktreeDataDirectory).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      {
        worktreeDataRootDir: '/mock/workspaces/project-1/worktree-data',
        removeTree: removeTreeWithoutAsar,
      },
    );
  });

  it('waits for child worktree-data cleanup before removing the metadata root', async () => {
    let resolveHookCleanup: (() => void) | undefined;
    let markHookStarted: (() => void) | undefined;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    mockedDeleteHookRunLogsForWorktree.mockImplementationOnce(() => {
      markHookStarted?.();
      return new Promise<void>((resolve) => {
        resolveHookCleanup = resolve;
      });
    });

    const cleanupPromise = cleanupPersistedWorktreeData('project-1', 'wt-1');
    await hookStarted;

    expect(mockedDeleteHookRunLogsForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedRemovePersistedWorktreeDataDirectory).not.toHaveBeenCalled();

    resolveHookCleanup?.();
    await expect(cleanupPromise).resolves.toEqual([]);
    expect(mockedRemovePersistedWorktreeDataDirectory).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      {
        worktreeDataRootDir: '/mock/workspaces/project-1/worktree-data',
        removeTree: removeTreeWithoutAsar,
      },
    );
  });

  it('keeps the chat deletion boundary active through metadata removal', async () => {
    let deletionBoundaryActive = false;
    let releaseMetadataRemoval: (() => void) | undefined;
    const metadataRemovalGate = new Promise<void>((resolve) => {
      releaseMetadataRemoval = resolve;
    });
    mockedRunWithScopeDeletion.mockImplementationOnce(
      async (_scope, operation) => {
        deletionBoundaryActive = true;
        try {
          return await operation();
        } finally {
          deletionBoundaryActive = false;
        }
      },
    );
    mockedRemovePersistedWorktreeDataDirectory.mockImplementationOnce(
      async () => {
        expect(deletionBoundaryActive).toBe(true);
        await metadataRemovalGate;
      },
    );

    const cleanupPromise = cleanupPersistedWorktreeData('project-1', 'wt-1');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockedRunWithScopeDeletion).toHaveBeenCalledWith(
      { projectId: 'project-1', worktreeId: 'wt-1' },
      expect.any(Function),
    );
    expect(deletionBoundaryActive).toBe(true);

    releaseMetadataRemoval?.();
    await expect(cleanupPromise).resolves.toEqual([]);
    expect(deletionBoundaryActive).toBe(false);
  });

  it('returns warnings for cleanup failures without aborting the rest', async () => {
    mockedDeleteScriptRunLogsForWorktree.mockRejectedValueOnce(
      new Error('busy'),
    );

    const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(warnings).toEqual([
      'Failed to remove script run logs for this worktree: busy',
    ]);
    expect(mockedDeleteHookRunLogsForWorktree).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedPurgePersistedWorktreeObservabilityData).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
  });

  it('returns a warning when shared metadata removal fails', async () => {
    mockedRemovePersistedWorktreeDataDirectory.mockRejectedValueOnce(
      Object.assign(new Error('busy'), { code: 'EBUSY' }),
    );

    await expect(
      cleanupPersistedWorktreeData('project-1', 'wt-1'),
    ).resolves.toContain(
      'Failed to remove worktree metadata for this worktree: resource busy or locked',
    );
  });

  it('normalizes filesystem cleanup warnings before returning them', async () => {
    mockedDeleteScriptRunLogsForWorktree.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "EBUSY: resource busy or locked, unlink '/Users/test/worktree.log'",
        ),
        { code: 'EBUSY' },
      ),
    );

    const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1');

    expect(warnings).toEqual([
      'Failed to remove script run logs for this worktree: resource busy or locked',
    ]);
    expect(warnings[0]?.includes('/Users/test/worktree.log')).toBe(false);
    expect(mockedPurgePersistedWorktreeObservabilityData).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
  });

  it('purges persisted-only observability through a running service', async () => {
    mockPeekObservabilityService.mockReturnValue({
      purgePersistedWorktreeData: mockPurgeLivePersistedWorktreeData,
    });
    try {
      const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1');

      expect(warnings).toEqual([]);
      expect(mockPurgeLivePersistedWorktreeData).toHaveBeenCalledWith(
        'project-1',
        'wt-1',
      );
      expect(
        mockedPurgePersistedWorktreeObservabilityData,
      ).not.toHaveBeenCalled();
    } finally {
      mockPeekObservabilityService.mockReturnValue(null);
    }
  });

  it('requires an explicit observability purge for live-service cleanup', async () => {
    const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1', {
      observabilityMode: 'live-service',
    });

    expect(warnings).toEqual([
      'Failed to remove agent observability records for this worktree: live-service observability cleanup requires a purge implementation',
    ]);
    expect(
      mockedPurgePersistedWorktreeObservabilityData,
    ).not.toHaveBeenCalled();
  });

  it('uses the provided observability purge for live-service cleanup', async () => {
    const purgeObservabilityData = jest.fn(() => Promise.resolve());

    const warnings = await cleanupPersistedWorktreeData('project-1', 'wt-1', {
      observabilityMode: 'live-service',
      purgeObservabilityData,
    });

    expect(warnings).toEqual([]);
    expect(purgeObservabilityData).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(
      mockedPurgePersistedWorktreeObservabilityData,
    ).not.toHaveBeenCalled();
  });
});
