jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  fetchOrigin: jest.fn(() => Promise.resolve()),
  getChangedFilesList: jest.fn(),
  getCommittedFilesList: jest.fn(),
  getFileDiffUncommitted: jest.fn(),
  getFileDiffCommitted: jest.fn(),
  getFileDiffCombined: jest.fn(),
  getFileDiffBetweenTrees: jest.fn(),
  revertUncommittedFile: jest.fn(),
}));

jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(),
}));

jest.mock('../lib/git-default-branch', () => ({
  revalidateDefaultBranchInBackground: jest.fn(),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
}));

const mockGetLiveBackgroundTaskSnapshot = jest.fn();
jest.mock('../agents/session-manager', () => ({
  stopTaskForSession: jest.fn(),
  getLiveBackgroundTaskSnapshot: mockGetLiveBackgroundTaskSnapshot,
  isSessionUnavailableForTaskStopError: (error: unknown): boolean =>
    error instanceof Error &&
    error.name === 'SessionUnavailableForTaskStopError',
}));

const mockRecordBackgroundProcessChatEvent = jest.fn();
jest.mock('../portal/background-process-tracker', () => ({
  recordBackgroundProcessChatEvent: mockRecordBackgroundProcessChatEvent,
}));

const mockEmitSessionEndedBackgroundTaskNotification = jest.fn();
jest.mock('../lib/session-ended-background-tasks', () => ({
  emitSessionEndedBackgroundTaskNotification:
    mockEmitSessionEndedBackgroundTaskNotification,
}));

import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerActivityPanelHandlers } from '../ipc/activity-panel';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import {
  fetchOrigin,
  getChangedFilesList,
  getCommittedFilesList,
  getFileDiffCombined,
  getFileDiffCommitted,
  revertUncommittedFile,
} from '../lib/git';
import { resolveEffectiveBaseBranchForRepo } from '../lib/worktree-base-branches';
import { revalidateDefaultBranchInBackground } from '../lib/git-default-branch';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import { stopTaskForSession } from '../agents/session-manager';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedGetChangedFilesList = jest.mocked(getChangedFilesList);
const mockedGetCommittedFilesList = jest.mocked(getCommittedFilesList);
const mockedGetFileDiffCommitted = jest.mocked(getFileDiffCommitted);
const mockedGetFileDiffCombined = jest.mocked(getFileDiffCombined);
const mockedRevertUncommittedFile = jest.mocked(revertUncommittedFile);
const mockedResolveEffectiveBaseBranchForRepo = jest.mocked(
  resolveEffectiveBaseBranchForRepo,
);
const mockedRevalidateDefaultBranchInBackground = jest.mocked(
  revalidateDefaultBranchInBackground,
);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedStopTaskForSession = jest.mocked(stopTaskForSession);

function getHandler<TArgs extends unknown[], TResult>(
  channel: string,
): (_event: unknown, ...args: TArgs) => Promise<TResult> {
  const registration = mockedRegisterIpcHandler.mock.calls.find(
    (call) => call[0] === channel,
  );
  if (!registration) {
    throw new Error(`Missing handler for ${channel}`);
  }

  const handler = registration[1];
  return async (_event: unknown, ...args: TArgs): Promise<TResult> =>
    Promise.resolve(
      Reflect.apply(handler, undefined, [undefined, ...args]) as TResult,
    );
}

describe('activity panel handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const getWindow = (): BrowserWindow | null => null;
    registerActivityPanelHandlers(getWindow);
    mockedGetChangedFilesList.mockResolvedValue([]);
    mockedGetCommittedFilesList.mockResolvedValue([]);
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'develop',
      existsLocally: true,
      existsInRemote: true,
    });
  });

  it('uses the tracked base branch for single-repo changed files', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/repo/worktree');

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
        },
      ],
      unknown
    >(IPC_CHANNELS.activityChangedFiles);

    await handler(undefined, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(mockedResolveEffectiveBaseBranchForRepo).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repo/worktree',
      allowRemoteLookup: false,
    });
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/repo/worktree', {
      ttlMs: 300_000,
      backgroundPriority: true,
    });
    expect(mockedGetCommittedFilesList).toHaveBeenCalledWith(
      '/repo/worktree',
      'develop',
    );
    // The remote default branch is still revalidated, without being awaited.
    expect(mockedRevalidateDefaultBranchInBackground).toHaveBeenCalledWith(
      '/repo/worktree',
    );
  });

  it('does not read source-checkout changes for a Git-pending worktree', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-pending',
        branchName: 'feature/pending',
        createdAt: '2026-07-22T00:00:00.000Z',
        setupPhase: 'git-pending',
      },
    ]);

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
        },
      ],
      unknown
    >(IPC_CHANNELS.activityChangedFiles);

    await expect(
      handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-pending',
      }),
    ).resolves.toEqual({ uncommitted: [], committed: [] });
    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalled();
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedGetChangedFilesList).not.toHaveBeenCalled();
    expect(mockedGetCommittedFilesList).not.toHaveBeenCalled();
  });

  it('uses per-repo tracked base branches for multi-repo changed files', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        repoPath: '/workspace/wt/repos/repo-a',
      },
      {
        repoId: 'repo-b',
        repoName: 'Repo B',
        repoPath: '/workspace/wt/repos/repo-b',
      },
    ]);
    mockedResolveEffectiveBaseBranchForRepo
      .mockResolvedValueOnce({
        branch: 'develop',
        existsLocally: true,
        existsInRemote: true,
      })
      .mockResolvedValueOnce({
        branch: 'release/1.2',
        existsLocally: true,
        existsInRemote: false,
      });

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
        },
      ],
      unknown
    >(IPC_CHANNELS.activityChangedFiles);

    await handler(undefined, {
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(mockedGetCommittedFilesList).toHaveBeenNthCalledWith(
      1,
      '/workspace/wt/repos/repo-a',
      'develop',
    );
    expect(mockedGetCommittedFilesList).toHaveBeenNthCalledWith(
      2,
      '/workspace/wt/repos/repo-b',
      'release/1.2',
    );
    expect(mockedFetchOrigin).toHaveBeenCalledWith(
      '/workspace/wt/repos/repo-a',
      { ttlMs: 300_000, backgroundPriority: true },
    );
    expect(mockedFetchOrigin).toHaveBeenCalledWith(
      '/workspace/wt/repos/repo-b',
      { ttlMs: 300_000, backgroundPriority: true },
    );
  });

  it.each([
    ['single-repo', false],
    ['multi-repo', true],
  ])(
    'lists %s changed files while the automatic fetch waits on the remote',
    async (_label, multiRepo) => {
      jest.useFakeTimers();
      try {
        mockedIsMultiRepoWorkspace.mockReturnValue(multiRepo);
        mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
        mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            repoPath: '/workspace/wt',
          },
        ]);
        // `git fetch` waiting on a credential helper that never answers.
        mockedFetchOrigin.mockReturnValue(new Promise<void>(() => {}));
        mockedGetChangedFilesList.mockResolvedValue([
          {
            path: 'src/local.ts',
            status: 'modified',
            insertions: 1,
            deletions: 0,
          },
        ]);

        const handler = getHandler<
          [{ projectId: string; worktreeId: string }],
          { uncommitted: Array<{ path: string }> }
        >(IPC_CHANNELS.activityChangedFiles);
        let settled = false;
        const result = handler(undefined, {
          projectId: 'workspace-1',
          worktreeId: 'wt-1',
        }).finally(() => {
          settled = true;
        });

        await jest.advanceTimersByTimeAsync(2_900);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(100);
        await expect(result).resolves.toMatchObject({
          uncommitted: [expect.objectContaining({ path: 'src/local.ts' })],
        });
        // The base branch comes from local knowledge, never `ls-remote`.
        expect(mockedResolveEffectiveBaseBranchForRepo).toHaveBeenCalledWith(
          expect.objectContaining({ allowRemoteLookup: false }),
        );
        expect(mockedRevalidateDefaultBranchInBackground).toHaveBeenCalledWith(
          '/workspace/wt',
        );
      } finally {
        mockedFetchOrigin.mockResolvedValue(undefined);
        jest.useRealTimers();
      }
    },
  );

  it('reverts files directly in a multi-repo child repo', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedGetChangedFilesList.mockResolvedValue([
      {
        path: 'src/new-name.ts',
        status: 'renamed',
        insertions: 0,
        deletions: 0,
        previousPath: 'src/old-name.ts',
      },
    ]);

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          filePath: string;
          status: 'renamed';
          previousPath: string;
          repoId: string;
        },
      ],
      void
    >(IPC_CHANNELS.activityRevertFile);

    await handler(undefined, {
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      filePath: 'src/new-name.ts',
      status: 'renamed',
      previousPath: 'src/old-name.ts',
      repoId: 'repo-a',
    });

    expect(mockedGetChangedFilesList).toHaveBeenCalledWith(
      '/workspace/wt/repos/repo-a',
    );
    expect(mockedRevertUncommittedFile).toHaveBeenCalledWith(
      '/workspace/wt/repos/repo-a',
      'src/new-name.ts',
      'renamed',
      'src/old-name.ts',
    );
  });

  it('reverts files directly in a multi-repo project root repo', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedGetChangedFilesList.mockResolvedValue([
      {
        path: 'canopy.json',
        status: 'modified',
        insertions: 0,
        deletions: 0,
      },
    ]);

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          filePath: string;
          status: 'modified';
          repoId: string;
        },
      ],
      void
    >(IPC_CHANNELS.activityRevertFile);

    await handler(undefined, {
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      filePath: 'canopy.json',
      status: 'modified',
      repoId: WORKSPACE_ROOT_REPO_ID,
    });

    expect(mockedGetChangedFilesList).toHaveBeenCalledWith('/workspace/wt');
    expect(mockedRevertUncommittedFile).toHaveBeenCalledWith(
      '/workspace/wt',
      'canopy.json',
      'modified',
      undefined,
    );
  });

  it('prefers the current changed-file status over stale renderer data', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/repo/worktree');
    mockedGetChangedFilesList.mockResolvedValue([
      {
        path: 'src/app.ts',
        status: 'modified',
        insertions: 1,
        deletions: 1,
      },
    ]);

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          filePath: string;
          status: 'deleted';
        },
      ],
      void
    >(IPC_CHANNELS.activityRevertFile);

    await handler(undefined, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      filePath: 'src/app.ts',
      status: 'deleted',
    });

    expect(mockedRevertUncommittedFile).toHaveBeenCalledWith(
      '/repo/worktree',
      'src/app.ts',
      'modified',
      undefined,
    );
  });

  it('rejects invalid revert statuses before calling git helpers', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/repo/worktree');

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          filePath: string;
          status: string;
        },
      ],
      void
    >(IPC_CHANNELS.activityRevertFile);

    await expect(
      handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        filePath: 'src/app.ts',
        status: 'bogus',
      }),
    ).rejects.toThrow('Invalid file status');
    expect(mockedGetChangedFilesList).not.toHaveBeenCalled();
    expect(mockedRevertUncommittedFile).not.toHaveBeenCalled();
  });

  it('rejects renamed requests with a missing previousPath', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/repo/worktree');

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          filePath: string;
          status: 'renamed';
        },
      ],
      void
    >(IPC_CHANNELS.activityRevertFile);

    await expect(
      handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        filePath: 'src/new-name.ts',
        status: 'renamed',
      }),
    ).rejects.toThrow('previousPath is required for renamed files');
    expect(mockedGetChangedFilesList).not.toHaveBeenCalled();
    expect(mockedRevertUncommittedFile).not.toHaveBeenCalled();
  });

  it('rejects empty previousPath values before calling git helpers', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/repo/worktree');

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          filePath: string;
          status: 'modified';
          previousPath: string;
        },
      ],
      void
    >(IPC_CHANNELS.activityRevertFile);

    await expect(
      handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        filePath: 'src/app.ts',
        status: 'modified',
        previousPath: '',
      }),
    ).rejects.toThrow('Invalid filePath');
    expect(mockedGetChangedFilesList).not.toHaveBeenCalled();
    expect(mockedRevertUncommittedFile).not.toHaveBeenCalled();
  });

  it('uses the tracked base branch for committed activity diffs', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/repo/worktree');
    mockedGetFileDiffCommitted.mockResolvedValue({
      oldValue: 'old\n',
      newValue: 'new\n',
      truncated: false,
      binary: false,
    });

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          filePath: string;
          source: 'committed';
        },
      ],
      unknown
    >(IPC_CHANNELS.activityFileDiff);

    await handler(undefined, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      filePath: 'src/app.ts',
      source: 'committed',
    });

    expect(mockedGetFileDiffCommitted).toHaveBeenCalledWith(
      '/repo/worktree',
      'src/app.ts',
      'develop',
    );
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/repo/worktree');
  });

  it('uses the tracked base branch for combined activity diffs', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/repo/worktree');
    mockedGetFileDiffCombined.mockResolvedValue({
      oldValue: 'base\n',
      newValue: 'working\n',
      truncated: false,
      binary: false,
    });

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          filePath: string;
          source: 'combined';
        },
      ],
      unknown
    >(IPC_CHANNELS.activityFileDiff);

    await handler(undefined, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      filePath: 'src/app.ts',
      source: 'combined',
    });

    expect(mockedGetFileDiffCombined).toHaveBeenCalledWith(
      '/repo/worktree',
      'src/app.ts',
      'develop',
    );
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/repo/worktree');
  });

  it('opens a committed diff while the fetch waits on the remote', async () => {
    jest.useFakeTimers();
    try {
      mockedIsMultiRepoWorkspace.mockReturnValue(false);
      mockedResolveWorktreeCwd.mockReturnValue('/repo/worktree');
      // `git fetch` waiting on a credential helper that never answers.
      mockedFetchOrigin.mockReturnValue(new Promise<void>(() => {}));
      mockedGetFileDiffCommitted.mockResolvedValue({
        oldValue: 'old\n',
        newValue: 'new\n',
        truncated: false,
        binary: false,
      });

      const handler = getHandler<
        [
          {
            projectId: string;
            worktreeId: string;
            filePath: string;
            source: 'committed';
          },
        ],
        { newValue: string }
      >(IPC_CHANNELS.activityFileDiff);
      const result = handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        filePath: 'src/app.ts',
        source: 'committed',
      });

      await jest.advanceTimersByTimeAsync(3_000);
      await expect(result).resolves.toMatchObject({ newValue: 'new\n' });
      expect(mockedResolveEffectiveBaseBranchForRepo).toHaveBeenCalledWith(
        expect.objectContaining({ allowRemoteLookup: false }),
      );
    } finally {
      mockedFetchOrigin.mockResolvedValue(undefined);
      jest.useRealTimers();
    }
  });
});

describe('activity live background task handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const getWindow = (): BrowserWindow | null => null;
    registerActivityPanelHandlers(getWindow);
    mockGetLiveBackgroundTaskSnapshot.mockReturnValue({});
    mockedStopTaskForSession.mockResolvedValue('stopped');
  });

  it('returns the main-process live background task snapshot', async () => {
    mockGetLiveBackgroundTaskSnapshot.mockReturnValue({
      'chat-1': { sessionActive: true, liveTasks: [{ taskId: 'task-1' }] },
    });

    const handler = getHandler<
      [{ projectId: string; worktreeId: string }],
      {
        chats: Record<
          string,
          { sessionActive: boolean; liveTasks: Array<{ taskId: string }> }
        >;
      }
    >(IPC_CHANNELS.activityListLiveBgTasks);

    await expect(
      handler(undefined, { projectId: 'project-1', worktreeId: 'wt-1' }),
    ).resolves.toEqual({
      chats: {
        'chat-1': { sessionActive: true, liveTasks: [{ taskId: 'task-1' }] },
      },
    });
    expect(mockGetLiveBackgroundTaskSnapshot).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
  });

  it('rejects an invalid worktree id before reading sessions', async () => {
    const handler = getHandler<
      [{ projectId: string; worktreeId: string }],
      unknown
    >(IPC_CHANNELS.activityListLiveBgTasks);

    await expect(
      handler(undefined, { projectId: 'project-1', worktreeId: '../escape' }),
    ).rejects.toThrow('worktreeId');
    expect(mockGetLiveBackgroundTaskSnapshot).not.toHaveBeenCalled();
  });

  it('records a stopped background process when the provider stops the task', async () => {
    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          chatId: string;
          taskId: string;
        },
      ],
      void
    >(IPC_CHANNELS.activityStopBgProcess);

    await expect(
      handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        taskId: 'task-1',
      }),
    ).resolves.toBe('stopped');

    expect(mockRecordBackgroundProcessChatEvent).toHaveBeenCalledTimes(1);
    expect(
      mockEmitSessionEndedBackgroundTaskNotification,
    ).not.toHaveBeenCalled();
  });

  it('resolves and notifies when the chat has no live session left', async () => {
    const error = new Error('No active session is available to stop that task');
    error.name = 'SessionUnavailableForTaskStopError';
    mockedStopTaskForSession.mockRejectedValue(error);

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          chatId: string;
          taskId: string;
        },
      ],
      void
    >(IPC_CHANNELS.activityStopBgProcess);

    await expect(
      handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        taskId: 'task-1',
      }),
    ).resolves.toBe('session-ended');

    expect(mockEmitSessionEndedBackgroundTaskNotification).toHaveBeenCalledWith(
      { projectId: 'project-1', worktreeId: 'wt-1', chatId: 'chat-1' },
      { taskId: 'task-1' },
    );
  });

  it('resolves and notifies when the provider reports the task already finished', async () => {
    mockedStopTaskForSession.mockResolvedValue('already-finished');

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          chatId: string;
          taskId: string;
        },
      ],
      void
    >(IPC_CHANNELS.activityStopBgProcess);

    await expect(
      handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        taskId: 'task-1',
      }),
    ).resolves.toBe('already-finished');

    expect(mockEmitSessionEndedBackgroundTaskNotification).toHaveBeenCalledWith(
      { projectId: 'project-1', worktreeId: 'wt-1', chatId: 'chat-1' },
      { taskId: 'task-1' },
      { reason: 'already_finished', summary: 'This task had already finished' },
    );
  });

  it('still rejects a genuine provider stop failure', async () => {
    mockedStopTaskForSession.mockRejectedValue(
      new Error(
        'Stopping individual tasks is not supported for Codex sessions',
      ),
    );

    const handler = getHandler<
      [
        {
          projectId: string;
          worktreeId: string;
          chatId: string;
          taskId: string;
        },
      ],
      void
    >(IPC_CHANNELS.activityStopBgProcess);

    await expect(
      handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        taskId: 'task-1',
      }),
    ).rejects.toThrow('not supported for Codex');
    expect(
      mockEmitSessionEndedBackgroundTaskNotification,
    ).not.toHaveBeenCalled();
  });
});
