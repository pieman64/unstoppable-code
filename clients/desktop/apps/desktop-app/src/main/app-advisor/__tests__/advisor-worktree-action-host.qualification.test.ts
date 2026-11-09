import type { WorktreeData } from '@canopy/desktop-shared/types';
jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockUpdateWorktree = jest.fn((request: { worktreeId: string }) =>
  Promise.resolve({ worktree: { id: request.worktreeId }, changed: true }),
);
jest.mock('../../lib/worktree-update', (): object => ({
  ...jest.requireActual<object>('../../lib/worktree-update'),
  updateWorktree: (request: { worktreeId: string }) =>
    mockUpdateWorktree(request),
}));

const mockSetWorktreeHooksPaused = jest.fn((request: { worktreeId: string }) =>
  Promise.resolve({
    worktree: { id: request.worktreeId },
    pausedHookKeys: ['lint'],
    changed: true,
  }),
);
jest.mock('../../lib/workspace-script-hook-settings', (): object => ({
  ...jest.requireActual<object>('../../lib/workspace-script-hook-settings'),
  setWorktreeHooksPaused: (request: { worktreeId: string }) =>
    mockSetWorktreeHooksPaused(request),
}));

const mockCreateAgentChatWorktree = jest.fn(() =>
  Promise.resolve({ status: 'created', worktreeId: 'wt-new' }),
);
jest.mock('../../lib/agent-chat-worktree', () => ({
  createAgentChatWorktree: (...args: unknown[]): unknown =>
    mockCreateAgentChatWorktree(...(args as [])),
}));

const mockSendToAllWindows = jest.fn();
jest.mock('../../lib/window-send', (): object => ({
  ...jest.requireActual<object>('../../lib/window-send'),
  sendToAllWindows: (...args: unknown[]): void => {
    mockSendToAllWindows(...args);
  },
}));

const mockLaunches: Array<{ kind: string; args: unknown }> = [];
jest.mock('../../lib/builtin-gh-chat', () => ({
  launchCiCheckFixChat: (args: unknown): Promise<{ chatId: string }> => {
    mockLaunches.push({ kind: 'ci', args });
    return Promise.resolve({ chatId: 'ci-chat' });
  },
  launchMergeConflictResolutionChat: (
    args: unknown,
  ): Promise<{ chatId: string }> => {
    mockLaunches.push({ kind: 'merge', args });
    return Promise.resolve({ chatId: 'merge-chat' });
  },
  launchPrCommentTriageChat: (args: unknown): Promise<{ chatId: string }> => {
    mockLaunches.push({ kind: 'triage', args });
    return Promise.resolve({ chatId: 'triage-chat' });
  },
}));
let mockDiffStatsRead: () => Promise<unknown> = () => Promise.resolve({});
jest.mock('../../lib/preferences-store', (): object => ({
  ...jest.requireActual<object>('../../lib/preferences-store'),
  readPreferencesFile: (): Promise<{ prefs: true }> =>
    Promise.resolve({ prefs: true }),
}));

import { mainAdvisorWorktreeActionHost } from '../advisor-worktree-action-host';

function host(): ReturnType<typeof mainAdvisorWorktreeActionHost> {
  return mainAdvisorWorktreeActionHost({
    getMainWindow: () => null,
    selectWorktree: () => Promise.resolve(),
    readSourceStatus: () => mockDiffStatsRead(),
    readWorktrees: () =>
      Promise.resolve([{ id: 'wt' }, { id: 'wt-new' }] as WorktreeData[]),
  });
}

beforeEach(() => {
  mockUpdateWorktree.mockClear();
  mockSetWorktreeHooksPaused.mockClear();
  mockCreateAgentChatWorktree.mockClear();
  mockSendToAllWindows.mockClear();
  mockLaunches.length = 0;
});

describe('App Advisor worktree action host (CAN-5997)', () => {
  it('a settings write goes through the keyed core.worktree.update writer and announces the row on workspace:worktrees-updated', async () => {
    await host().updateWorktree({
      workspaceId: 'proj',
      worktreeId: 'wt',
      patch: { hidden: true },
      idempotencyKey: 'app-advisor-action:chat:toolu_1:hidden',
    });

    expect(mockUpdateWorktree).toHaveBeenCalledWith({
      workspaceId: 'proj',
      worktreeId: 'wt',
      patch: { hidden: true },
      idempotencyKey: 'app-advisor-action:chat:toolu_1:hidden',
    });
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'workspace:worktrees-updated',
      // The writer's portable projection is not the renderer's full row, so
      // windows reload the project's worktrees instead of replacing the row.
      { workspaceId: 'proj' },
    );
  });

  it('paused hooks go through the keyed core.worktree.hooks.setPaused writer as App Advisor', async () => {
    await host().setPausedHookKeys({
      projectId: 'proj',
      worktreeId: 'wt',
      pausedHookKeys: ['lint'],
      idempotencyKey: 'app-advisor-action:chat:toolu_1:paused-hooks',
    });

    expect(mockSetWorktreeHooksPaused).toHaveBeenCalledWith({
      workspaceId: 'proj',
      worktreeId: 'wt',
      change: { kind: 'replace', pausedHookKeys: ['lint'] },
      source: 'app_advisor',
      idempotencyKey: 'app-advisor-action:chat:toolu_1:paused-hooks',
    });
  });

  it('creation runs the keyed core.worktree.create writer with the App Advisor caller source', async () => {
    await host().createWorktree({
      workspaceId: 'proj',
      baseBranch: 'develop',
      idempotencyKey: 'app-advisor-action:chat:toolu_1:worktree',
    });

    expect(mockCreateAgentChatWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'proj',
        baseBranch: 'develop',
        idempotencyKey: 'app-advisor-action:chat:toolu_1:worktree',
        callerSource: 'app-advisor',
      }),
    );
    // The full list reaches the windows before the action's select, so the
    // new row exists when the main window selects it.
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'workspace:worktrees-updated',
      { workspaceId: 'proj', worktrees: [{ id: 'wt' }, { id: 'wt-new' }] },
    );
  });

  it('the source status check needs a fresh read, never a cached entry', async () => {
    mockDiffStatsRead = (): Promise<unknown> =>
      Promise.reject(new Error('git failed'));
    await expect(host().verifySourceStatus('proj', 'wt')).resolves.toBe(false);
    mockDiffStatsRead = (): Promise<unknown> => Promise.resolve({});
    await expect(host().verifySourceStatus('proj', 'wt')).resolves.toBe(true);
  });

  it('a fix start sees no main window when none is open', () => {
    expect(host().hasMainWindow()).toBe(false);
  });

  it('each fix start reaches its own launcher with the target and repository', async () => {
    const h = host();
    await h.launchFixChat('worktree.start_ci_check_fix', {
      projectId: 'proj',
      worktreeId: 'wt',
      repoId: 'repo-a',
      branchName: 'feature',
    });
    await h.launchFixChat('worktree.start_merge_conflict_resolution', {
      projectId: 'proj',
      worktreeId: 'wt',
    });
    await h.launchFixChat('worktree.start_pr_comment_triage', {
      projectId: 'proj',
      worktreeId: 'wt',
    });

    expect(mockLaunches.map(({ kind }) => kind)).toEqual([
      'ci',
      'merge',
      'triage',
    ]);
    expect(mockLaunches[0]?.args).toMatchObject({
      projectId: 'proj',
      worktreeId: 'wt',
      selectedRepoId: 'repo-a',
      context: { branchName: 'feature' },
    });
  });
});
