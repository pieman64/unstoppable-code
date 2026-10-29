/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import type { BrowserWindow } from 'electron';
import type { Dirent } from 'node:fs';

jest.mock('node:fs/promises', () => ({
  readdir: jest.fn(),
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  isGitRepo: jest.fn(() => Promise.resolve(false)),
  getCurrentBranch: jest.fn(),
  getDiffStats: jest.fn(),
  getFullDiff: jest.fn(),
  getCommitLog: jest.fn(),
  fetchOrigin: jest.fn(),
  getAheadBehindCounts: jest.fn(),
  getRemoteUrl: jest.fn(),
  pushBranch: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
  hasAutostashEntry: jest.fn(),
  hasUnmergedPaths: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  hasCommitsAhead: jest.fn(),
  hasBranchBeenPushedToRemote: jest.fn(),
  hasRemoteTrackingBranch: jest.fn(),
  hasUnpulledCommits: jest.fn(),
  hasUnpushedCommits: jest.fn(),
  isRebaseInProgress: jest.fn(),
  mergeBranchIntoLocalBase: jest.fn(),
  stageAllChanges: jest.fn(),
  commitWithMessage: jest.fn(),
  getUncommittedDiff: jest.fn(),
}));

jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(),
  resolveRepoDefaultBranch: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('../lib/github-pr', () => ({
  createPrForRepo: jest.fn(),
  updatePrBaseBranchForRepo: jest.fn(),
  fetchRepoPrTrackingData: jest.fn(),
  mergePrForRepo: jest.fn(),
  parseGitHubRemote: jest.fn((remoteUrl: string) => {
    const sshMatch = remoteUrl.match(
      /git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
    );
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
    const httpsMatch = remoteUrl.match(
      /https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
    );
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
    return null;
  }),
  PR_MERGE_RETRY_DELAYS_MS: [
    2000, 4000, 8000, 16000, 32000, 32000, 32000, 32000,
  ],
}));

jest.mock('../lib/builtin-gh-chat', () => ({
  launchMergeConflictResolutionChat: jest.fn(),
  launchPrCommentTriageChat: jest.fn(),
  launchCiCheckFixChat: jest.fn(),
  launchMergeQueueChat: jest.fn(),
}));

jest.mock('../lib/github-pr-generator', () => ({
  generatePrContent: jest.fn(),
}));

jest.mock('../lib/github-poller', () => ({
  refreshNow: jest.fn(() => Promise.resolve(null)),
  requestRefresh: jest.fn(),
  startPolling: jest.fn(),
  enqueueFastRefresh: jest.fn(),
  enqueueKnownPrFastRefresh: jest.fn(() => Promise.resolve(false)),
  isPrHookActiveForRepo: jest.fn(() => Promise.resolve(false)),
  setForegroundWorktree: jest.fn(),
}));

jest.mock('../lib/commit-message-generator', () => ({
  generateCommitMessage: jest.fn(),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(),
}));

jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

import { launchMergeQueueChat } from '../lib/builtin-gh-chat';
import { readPreferencesFile } from '../ipc/preferences';
import { readdir } from 'node:fs/promises';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { validateId } from '../lib/validation';
import {
  fetchOrigin,
  getAheadBehindCounts,
  getCurrentBranch,
  getRemoteUrl,
} from '../lib/git';
import { fetchRepoPrTrackingData, mergePrForRepo } from '../lib/github-pr';
import {
  refreshNow,
  enqueueFastRefresh,
  isPrHookActiveForRepo,
} from '../lib/github-poller';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { registerIpcHandler } from '../ipc/register';
import { getPrMergeProgress } from '../services/pr-merge-progress';
import {
  acquireSplitLock,
  releaseSplitLock,
  SplitLockError,
} from '../services/split-lock-service';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  CancelGitActionRequest,
  CancelGitActionResponse,
  MergePrRequest,
  MergePrResponse,
  PrState,
  PrStatusData,
  RepoPrTrackingData,
} from '@canopy/desktop-shared/types/github';

const mockedReaddir = jest.mocked(readdir);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedValidateId = jest.mocked(validateId);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedGetAheadBehindCounts = jest.mocked(getAheadBehindCounts);
const mockedFetchRepoPrTrackingData = jest.mocked(fetchRepoPrTrackingData);
const mockedMergePrForRepo = jest.mocked(mergePrForRepo);
const mockedRefreshNow = jest.mocked(refreshNow);
const mockedEnqueueFastRefresh = jest.mocked(enqueueFastRefresh);
const mockedIsPrHookActiveForRepo = jest.mocked(isPrHookActiveForRepo);
const mockedLogMainProcessWarn = jest.mocked(logMainProcessWarn);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

type HandlerFn = (
  event: unknown,
  request: MergePrRequest,
) => Promise<MergePrResponse>;

type CancelHandlerFn = (
  event: unknown,
  request: CancelGitActionRequest,
) => CancelGitActionResponse;

interface MockWindow {
  isDestroyed: () => boolean;
  webContents: {
    send: jest.Mock;
    isDestroyed: () => boolean;
    isCrashed: () => boolean;
    mainFrame: { isDestroyed: () => boolean; detached: boolean };
  };
}

let mockWindow: MockWindow;

function getMergePrHandler(): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (entry: any[]) => entry[0] === IPC_CHANNELS.githubMergePr,
  );
  if (!call) {
    throw new Error('githubMergePr handler not registered');
  }
  return call[1] as unknown as HandlerFn;
}

function getCancelGitActionHandler(): CancelHandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (entry: any[]) => entry[0] === IPC_CHANNELS.githubCancelGitAction,
  );
  if (!call) {
    throw new Error('githubCancelGitAction handler not registered');
  }
  return call[1] as unknown as CancelHandlerFn;
}

function makeDirent(name: string): Dirent {
  return {
    name,
    parentPath: '/workspace',
    isFile: (): boolean => false,
    isDirectory: (): boolean => true,
    isBlockDevice: (): boolean => false,
    isCharacterDevice: (): boolean => false,
    isSymbolicLink: (): boolean => false,
    isFIFO: (): boolean => false,
    isSocket: (): boolean => false,
  };
}

function makeStatus(overrides: Partial<PrStatusData> & { prNumber: number }): {
  status: PrStatusData;
} & Pick<RepoPrTrackingData, 'snapshot' | 'branchName' | 'remote'> {
  const state: PrState = overrides.state ?? 'open';
  return {
    snapshot: null,
    branchName: 'feature/repo-a',
    remote: { owner: 'org', repo: 'repo' },
    status: {
      prUrl: `https://github.com/org/repo/pull/${overrides.prNumber}`,
      headSha: 'verified-head-sha',
      baseRefName: 'main',
      title: 'PR title',
      checkStatus: 'passing',
      checkDetails: [],
      reviewStatus: 'approved',
      reviewers: [],
      hasConflicts: false,
      mergeableState: 'clean',
      commentCount: 0,
      updatedAt: '2026-06-19T00:00:00.000Z',
      ...overrides,
      state,
    },
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

async function waitForMergePrCalls(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mockedMergePrForRepo.mock.calls.length >= count) return;
    await flushPromises();
  }
  throw new Error(`Expected mergePrForRepo to be called ${count} times`);
}

describe('githubMergePr handler', () => {
  let handler: HandlerFn;
  let cancelHandler: CancelHandlerFn;

  beforeAll(async () => {
    const { getGitHubClient } = await import('../lib/github-client');
    jest.mocked(getGitHubClient).mockReturnValue({} as any);

    const { registerGitHubHandlers } = await import('../ipc/github');
    mockWindow = {
      isDestroyed: (): boolean => false,
      webContents: {
        send: jest.fn(),
        isDestroyed: (): boolean => false,
        isCrashed: (): boolean => false,
        mainFrame: { isDestroyed: (): boolean => false, detached: false },
      },
    };
    registerGitHubHandlers(() => mockWindow as unknown as BrowserWindow);
    handler = getMergePrHandler();
    cancelHandler = getCancelGitActionHandler();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(launchMergeQueueChat)
      .mockReset()
      .mockResolvedValue({ chatId: 'queue-chat' });
    jest.mocked(readPreferencesFile).mockResolvedValue({} as any);
    mockedIsPrHookActiveForRepo.mockReset().mockResolvedValue(false);
    mockedValidateId.mockImplementation((): void => undefined);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    } as any);
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([makeDirent('repo-a')] as any);
    mockedGetCurrentBranch.mockResolvedValue('feature/repo-a');
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
    mockedFetchOrigin.mockResolvedValue();
    mockedGetAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 0 });
    releaseSplitLock('project-1', 'worktree-1');
  });

  it('refuses a merge while the worktree is split-locked', async () => {
    acquireSplitLock('project-1', 'worktree-1');

    await expect(
      handler({} as any, {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    ).rejects.toBeInstanceOf(SplitLockError);
    expect(mockedFetchRepoPrTrackingData).not.toHaveBeenCalled();
  });

  it('projects a held Split PR lock as busy for remote PR actions', async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(true);
    jest.mocked(git.hasUnpushedCommits).mockResolvedValue(false);
    jest.mocked(git.hasRemoteTrackingBranch).mockResolvedValue(false);
    jest.mocked(git.hasBranchBeenPushedToRemote).mockResolvedValue(false);
    jest.mocked(git.hasUnpulledCommits).mockResolvedValue(false);
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(true);
    jest.mocked(bases.resolveEffectiveBaseBranchForRepo).mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: true,
    });
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'App',
            status: null,
            prLookupAvailable: true,
          },
        ],
      });
    acquireSplitLock('project-1', 'worktree-1');
    try {
      await expect(
        runWorktreePrAction({
          action: 'get_actions',
          workspaceLocalId: 'project-1',
          worktreeLocalId: 'worktree-1',
        }),
      ).resolves.toEqual(expect.objectContaining({ busy: true }));
    } finally {
      refresh.mockRestore();
    }
  });

  it('merges an open mergeable PR with no unresolved comments and refreshes', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({ prNumber: 7, unresolvedReviewThreadCount: 0 }) as any,
    );
    mockedMergePrForRepo.mockResolvedValue({
      outcome: 'merged',
      mergeMethod: 'squash',
      mergeCommitSha: 'sha123',
    });

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.mergedRepos).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        prNumber: 7,
        prUrl: 'https://github.com/org/repo/pull/7',
        mergeMethod: 'squash',
        mergeCommitSha: 'sha123',
        status: 'merged',
      },
    ]);
    expect(result.requiresUnresolvedConfirmation).toEqual([]);
    expect(result.failedRepos).toEqual([]);
    expect(mockedMergePrForRepo).toHaveBeenCalledWith(
      '/workspace/wt/repos/repo-a',
      7,
      'verified-head-sha',
    );
    expect(mockedRefreshNow).toHaveBeenCalledWith('workspace-a', 'wt-1');
    expect(mockedEnqueueFastRefresh).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
      false,
    );
  });

  it.each([false, true, undefined])(
    'opens a queue chat (already queued: %s) without merging or refreshing',
    async (inQueue) => {
      mockedFetchRepoPrTrackingData.mockResolvedValue(
        makeStatus({
          prNumber: 7,
          unresolvedReviewThreadCount: 0,
          headSha: undefined,
          mergeQueue: { required: true, inQueue },
        }),
      );
      const result = await handler(
        {},
        { projectId: 'workspace-a', worktreeId: 'wt-1' },
      );
      expect(result.mergeQueueChats).toEqual([
        {
          repoId: 'repo-a',
          repoName: 'repo-a',
          prNumber: 7,
          prUrl: 'https://github.com/org/repo/pull/7',
          chatId: 'queue-chat',
        },
      ]);
      expect(result.verifiedRepos).toEqual([
        expect.objectContaining({ mergeable: true, usesMergeQueue: true }),
      ]);
      expect(result.mergedRepos).toEqual([]);
      expect(result.failedRepos).toEqual([]);
      expect(mockedMergePrForRepo).not.toHaveBeenCalled();
      expect(mockedRefreshNow).not.toHaveBeenCalled();
      // The click waits on these reads, so none may queue behind polling.
      expect(mockedFetchRepoPrTrackingData.mock.calls.length).toBeGreaterThan(
        0,
      );
      for (const call of mockedFetchRepoPrTrackingData.mock.calls) {
        expect(call[2]).toEqual({ priority: 'high' });
      }
      expect(launchMergeQueueChat).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedRepoId: 'repo-a',
          projectId: 'workspace-a',
          worktreeId: 'wt-1',
          context: {
            repoName: 'repo-a',
            branchName: 'feature/repo-a',
            prNumber: 7,
            prUrl: 'https://github.com/org/repo/pull/7',
          },
        }),
      );
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.githubMergePrProgress,
        expect.objectContaining({ repoId: 'repo-a', phase: 'done' }),
      );
    },
  );

  it.each([false, undefined])(
    'keeps direct merging for false or unknown detection: %s',
    async (required) => {
      mockedFetchRepoPrTrackingData.mockResolvedValue(
        makeStatus({
          prNumber: 7,
          unresolvedReviewThreadCount: 0,
          ...(required === undefined
            ? {}
            : { mergeQueue: { required, inQueue: false } }),
        }),
      );
      mockedMergePrForRepo.mockResolvedValue({
        outcome: 'merged',
        mergeMethod: 'squash',
        mergeCommitSha: 'sha123',
      });
      const result = await handler(
        {},
        { projectId: 'workspace-a', worktreeId: 'wt-1' },
      );
      expect(result.mergedRepos).toHaveLength(1);
      expect(result.mergeQueueChats).toEqual([]);
      expect(launchMergeQueueChat).not.toHaveBeenCalled();
    },
  );

  describe('merge queue agent handling setting', () => {
    function mockQueueRequiredPr(inQueue = false): void {
      mockedFetchRepoPrTrackingData.mockResolvedValue(
        makeStatus({
          prNumber: 7,
          unresolvedReviewThreadCount: 0,
          mergeableState: 'blocked',
          mergeQueue: { required: true, inQueue },
        }),
      );
    }

    function mockHandling(mergeQueueAgentHandling: unknown): void {
      jest
        .mocked(readPreferencesFile)
        .mockResolvedValue({ mergeQueueAgentHandling } as any);
    }

    function expectDirectEnqueue(result: MergePrResponse): void {
      expect(launchMergeQueueChat).not.toHaveBeenCalled();
      expect(result.mergeQueueChats).toEqual([]);
      expect(mockedMergePrForRepo).toHaveBeenCalledWith(
        '/workspace/wt/repos/repo-a',
        7,
        'verified-head-sha',
      );
      expect(result.mergedRepos).toEqual([
        expect.objectContaining({ prNumber: 7, status: 'enqueued' }),
      ]);
      expect(result.verifiedRepos).toEqual([
        expect.objectContaining({
          mergeable: true,
          usesMergeQueue: true,
          startsAgentChat: false,
        }),
      ]);
    }

    beforeEach(() => {
      mockedMergePrForRepo.mockResolvedValue({
        outcome: 'enqueued',
        mergeMethod: 'squash',
        mergeCommitSha: null,
        queuePosition: 2,
      });
    });

    it('adds the pull request to the merge queue directly when set to Never', async () => {
      mockHandling('never');
      mockQueueRequiredPr();

      const result = await handler(
        {},
        { projectId: 'workspace-a', worktreeId: 'wt-1' },
      );

      expectDirectEnqueue(result);
      expect(mockedIsPrHookActiveForRepo).not.toHaveBeenCalled();
    });

    it('refuses an already-queued pull request when set to Never', async () => {
      mockHandling('never');
      mockQueueRequiredPr(true);

      const result = await handler(
        {},
        { projectId: 'workspace-a', worktreeId: 'wt-1' },
      );

      expect(launchMergeQueueChat).not.toHaveBeenCalled();
      expect(mockedMergePrForRepo).not.toHaveBeenCalled();
      expect(result.verifiedRepos).toEqual([
        expect.objectContaining({
          mergeable: false,
          blockedReason: 'in_merge_queue',
          startsAgentChat: false,
        }),
      ]);
    });

    it('enqueues directly when the project hook would run', async () => {
      mockHandling('when_hook_absent');
      mockedIsPrHookActiveForRepo.mockResolvedValue(true);
      mockQueueRequiredPr();

      const result = await handler(
        {},
        { projectId: 'workspace-a', worktreeId: 'wt-1' },
      );

      expectDirectEnqueue(result);
      expect(mockedIsPrHookActiveForRepo).toHaveBeenCalledWith({
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        repoId: 'repo-a',
        triggerName: 'pr:queue:removed',
      });
    });

    it.each([
      ['when_hook_absent', false],
      ['always', true],
    ])(
      'opens a chat when set to %s (hook active: %s)',
      async (handling, hookActive) => {
        mockHandling(handling);
        mockedIsPrHookActiveForRepo.mockResolvedValue(hookActive);
        mockQueueRequiredPr();

        const result = await handler(
          {},
          { projectId: 'workspace-a', worktreeId: 'wt-1' },
        );

        expect(result.mergeQueueChats).toHaveLength(1);
        expect(mockedMergePrForRepo).not.toHaveBeenCalled();
        expect(result.verifiedRepos).toEqual([
          expect.objectContaining({ startsAgentChat: true }),
        ]);
      },
    );

    it.each([undefined, 'sometimes'])(
      'treats a missing or unknown setting (%s) as When project hook is absent',
      async (handling) => {
        mockHandling(handling);
        mockedIsPrHookActiveForRepo.mockResolvedValue(true);
        mockQueueRequiredPr();

        const result = await handler(
          {},
          { projectId: 'workspace-a', worktreeId: 'wt-1' },
        );

        expectDirectEnqueue(result);
      },
    );

    it('opens a chat when the hook lookup fails', async () => {
      mockHandling('when_hook_absent');
      mockedIsPrHookActiveForRepo.mockRejectedValue(new Error('unreadable'));
      mockQueueRequiredPr();

      const result = await handler(
        {},
        { projectId: 'workspace-a', worktreeId: 'wt-1' },
      );

      expect(result.mergeQueueChats).toHaveLength(1);
      expect(mockedLogMainProcessWarn).toHaveBeenCalledWith(
        '[github-merge-pr] merge queue hook lookup failed:',
        expect.any(Error),
      );
    });

    it('reports the route in a dry run without merging or opening a chat', async () => {
      mockHandling('never');
      mockQueueRequiredPr();

      const result = await handler(
        {},
        { projectId: 'workspace-a', worktreeId: 'wt-1', dryRun: true },
      );

      expect(result.verifiedRepos).toEqual([
        expect.objectContaining({
          usesMergeQueue: true,
          startsAgentChat: false,
        }),
      ]);
      expect(mockedMergePrForRepo).not.toHaveBeenCalled();
      expect(launchMergeQueueChat).not.toHaveBeenCalled();
    });
  });

  it('never launches during dry-run or pending confirmation, then hands off a confirmed retry', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({
        prNumber: 7,
        unresolvedReviewThreadCount: 2,
        mergeQueue: { required: true, inQueue: false },
      }),
    );
    const request = { projectId: 'workspace-a', worktreeId: 'wt-1' };
    const dryRun = await handler(
      {},
      { ...request, dryRun: true, confirmUnresolvedComments: true },
    );
    expect(dryRun.mergeQueueChats).toEqual([]);
    expect(dryRun.verifiedRepos[0].usesMergeQueue).toBe(true);
    expect(
      (await handler({}, request)).requiresUnresolvedConfirmation,
    ).toHaveLength(1);
    expect(launchMergeQueueChat).not.toHaveBeenCalled();
    expect(
      (await handler({}, { ...request, confirmUnresolvedComments: true }))
        .mergeQueueChats,
    ).toHaveLength(1);
  });

  it('reports launch failure without terminal success', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({
        prNumber: 7,
        unresolvedReviewThreadCount: 0,
        mergeQueue: { required: true, inQueue: false },
      }),
    );
    jest
      .mocked(launchMergeQueueChat)
      .mockRejectedValueOnce(
        new Error(
          'This chat requires an active renderer window before it can start.',
        ),
      );
    const result = await handler(
      {},
      { projectId: 'workspace-a', worktreeId: 'wt-1' },
    );
    expect(result.mergeQueueChats).toEqual([]);
    expect(result.failedRepos).toHaveLength(1);
    expect(result.failedRepos[0].repoId).toBe('repo-a');
    expect(result.failedRepos[0].error).toContain('active renderer window');
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.githubMergePrProgress,
      expect.objectContaining({ phase: 'done' }),
    );
    expect(mockWindow.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.githubMergePrProgress,
      expect.objectContaining({ phase: 'error' }),
    );
  });

  it('attempts standard merges first, then launches queue chats in workspace order despite independent failures', async () => {
    mockedReaddir.mockResolvedValue(
      ['repo-a', 'repo-b', 'repo-c', 'repo-d'].map(makeDirent) as any,
    );
    const order: string[] = [];
    mockedFetchRepoPrTrackingData.mockImplementation((repoPath) =>
      Promise.resolve(
        makeStatus({
          prNumber: repoPath.endsWith('repo-b') ? 8 : 7,
          unresolvedReviewThreadCount: 0,
          mergeQueue: {
            required: !repoPath.endsWith('repo-b'),
            inQueue: false,
          },
        }),
      ),
    );
    mockedMergePrForRepo.mockImplementation(() => {
      order.push('standard');
      return Promise.reject(new Error('direct failure'));
    });
    jest.mocked(launchMergeQueueChat).mockImplementation((args) => {
      order.push(args.context.repoName ?? 'unknown');
      if (args.context.repoName === 'repo-c')
        return Promise.reject(new Error('launch failure'));
      return Promise.resolve({ chatId: `chat-${args.context.repoName}` });
    });
    const result = await handler(
      {},
      { projectId: 'workspace-a', worktreeId: 'wt-1' },
    );
    expect(order).toEqual(['standard', 'repo-a', 'repo-c', 'repo-d']);
    expect(result.mergeQueueChats?.map((repo) => repo.repoId)).toEqual([
      'repo-a',
      'repo-d',
    ]);
    expect(result.failedRepos.map((repo) => repo.repoId)).toEqual([
      'repo-b',
      'repo-c',
    ]);
  });

  it('verifies displayed identity again and uses the fresh queue decision', async () => {
    const queue = makeStatus({
      prNumber: 7,
      unresolvedReviewThreadCount: 0,
      mergeQueue: { required: true, inQueue: false },
    });
    const request = {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      expectedBaseBranch: 'main',
      expectedHeadBranch: 'feature/repo-a',
      expectedPrNumber: 7,
    };
    mockedFetchRepoPrTrackingData
      .mockResolvedValueOnce(queue)
      .mockResolvedValueOnce(queue)
      .mockResolvedValueOnce(
        makeStatus({
          prNumber: 8,
          unresolvedReviewThreadCount: 0,
          mergeQueue: { required: true, inQueue: false },
        }),
      );
    expect((await handler({}, request)).failedRepos[0].error).toContain(
      'PR state changed',
    );
    expect(launchMergeQueueChat).not.toHaveBeenCalled();
    mockedFetchRepoPrTrackingData
      .mockResolvedValueOnce(queue)
      .mockResolvedValueOnce(queue)
      .mockResolvedValueOnce(
        makeStatus({ prNumber: 7, unresolvedReviewThreadCount: 0 }),
      );
    mockedMergePrForRepo.mockResolvedValue({
      outcome: 'merged',
      mergeMethod: 'squash',
      mergeCommitSha: 'sha123',
    });
    expect((await handler({}, request)).mergedRepos).toHaveLength(1);
    expect(launchMergeQueueChat).not.toHaveBeenCalled();
  });

  it('leaves repository scope unset in a single-repo workspace', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({
        prNumber: 7,
        unresolvedReviewThreadCount: 0,
        mergeQueue: { required: true, inQueue: false },
      }),
    );
    await handler({}, { projectId: 'workspace-a', worktreeId: 'wt-1' });
    expect(
      jest.mocked(launchMergeQueueChat).mock.calls[0][0],
    ).not.toHaveProperty('selectedRepoId');
  });

  it('keeps readiness retries before queue handoff', async () => {
    jest.useFakeTimers();
    try {
      mockedFetchRepoPrTrackingData
        .mockResolvedValueOnce(
          makeStatus({ prNumber: 7, unresolvedReviewThreadCount: 0 }),
        )
        .mockResolvedValueOnce(
          makeStatus({
            prNumber: 7,
            unresolvedReviewThreadCount: 0,
            mergeableState: 'unknown',
            mergeQueue: { required: true, inQueue: false },
          }),
        )
        .mockResolvedValueOnce(
          makeStatus({
            prNumber: 7,
            unresolvedReviewThreadCount: 0,
            mergeQueue: { required: true, inQueue: false },
          }),
        );
      const pending = handler(
        {},
        { projectId: 'workspace-a', worktreeId: 'wt-1' },
      );
      await flushMicrotasks();
      expect(launchMergeQueueChat).not.toHaveBeenCalled();
      await jest.runAllTimersAsync();
      expect((await pending).mergeQueueChats).toHaveLength(1);
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.githubMergePrProgress,
        expect.objectContaining({ phase: 'waiting_mergeability' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves blocked-queue readiness and successful mixed outcomes', async () => {
    mockedReaddir.mockResolvedValue(
      ['repo-a', 'repo-b'].map(makeDirent) as any,
    );
    mockedFetchRepoPrTrackingData.mockImplementation((repoPath) =>
      Promise.resolve(
        makeStatus({
          prNumber: repoPath.endsWith('repo-a') ? 7 : 8,
          unresolvedReviewThreadCount: 0,
          mergeableState: repoPath.endsWith('repo-a') ? 'blocked' : 'clean',
          mergeQueue: { required: repoPath.endsWith('repo-a'), inQueue: false },
        }),
      ),
    );
    mockedMergePrForRepo.mockResolvedValue({
      outcome: 'merged',
      mergeMethod: 'squash',
      mergeCommitSha: 'sha123',
    });
    const result = await handler(
      {},
      { projectId: 'workspace-a', worktreeId: 'wt-1' },
    );
    expect(result.mergedRepos).toEqual([
      expect.objectContaining({ repoId: 'repo-b', status: 'merged' }),
    ]);
    expect(result.mergeQueueChats).toEqual([
      expect.objectContaining({ repoId: 'repo-a' }),
    ]);
    expect(result.failedRepos).toEqual([]);
    expect(mockedRefreshNow).toHaveBeenCalledTimes(1);
  });

  it('retains completed handoffs when cancelled and does not start further chats', async () => {
    mockedReaddir.mockResolvedValue(
      ['repo-a', 'repo-b'].map(makeDirent) as any,
    );
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({
        prNumber: 7,
        unresolvedReviewThreadCount: 0,
        mergeQueue: { required: true, inQueue: false },
      }),
    );
    const request = {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      operationId: 'queue-operation',
    };
    jest.mocked(launchMergeQueueChat).mockImplementationOnce(() => {
      cancelHandler({}, request);
      return Promise.resolve({ chatId: 'first-chat' });
    });
    const result = await handler({}, request);
    expect(result.cancelled).toBe(true);
    expect(result.mergeQueueChats).toEqual([
      expect.objectContaining({ chatId: 'first-chat' }),
    ]);
    expect(launchMergeQueueChat).toHaveBeenCalledTimes(1);
  });

  it('rejects a remote merge when the pull request was retargeted', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({
        prNumber: 7,
        baseRefName: 'release',
        unresolvedReviewThreadCount: 0,
      }),
    );
    mockedMergePrForRepo.mockResolvedValue({
      outcome: 'merged',
      mergeMethod: 'squash',
      mergeCommitSha: 'sha123',
    });

    const result = await handler(
      {},
      {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        expectedBaseBranch: 'main',
        expectedHeadBranch: 'feature/repo-a',
        expectedPrNumber: 7,
      },
    );

    expect(result.mergedRepos).toEqual([]);
    expect(result.failedRepos).toEqual([
      expect.objectContaining({
        repoId: 'repo-a',
        prNumber: 7,
      }),
    ]);
    expect(result.failedRepos[0]?.error).toContain('PR state changed');
    expect(mockedMergePrForRepo).not.toHaveBeenCalled();
  });

  it('returns successful merge results when the post-merge refresh fails', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({ prNumber: 7, unresolvedReviewThreadCount: 0 }) as any,
    );
    mockedMergePrForRepo.mockResolvedValue({
      outcome: 'merged',
      mergeMethod: 'squash',
      mergeCommitSha: 'sha123',
    });
    mockedRefreshNow.mockRejectedValueOnce(new Error('tracking unavailable'));

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.mergedRepos).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        prNumber: 7,
        prUrl: 'https://github.com/org/repo/pull/7',
        mergeMethod: 'squash',
        mergeCommitSha: 'sha123',
        status: 'merged',
      },
    ]);
    expect(result.failedRepos).toEqual([]);
    expect(mockedEnqueueFastRefresh).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
      false,
    );
    expect(mockedLogMainProcessWarn).toHaveBeenCalledWith(
      '[github-merge-pr] post-merge refresh failed:',
      expect.any(Error),
    );
  });

  it('holds back a PR with unresolved comments until confirmed', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({ prNumber: 8, unresolvedReviewThreadCount: 2 }) as any,
    );

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      confirmUnresolvedComments: false,
    });

    expect(result.mergedRepos).toEqual([]);
    expect(result.requiresUnresolvedConfirmation).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        prNumber: 8,
        prUrl: 'https://github.com/org/repo/pull/8',
        unresolvedReviewThreadCount: 2,
      },
    ]);
    expect(mockedMergePrForRepo).not.toHaveBeenCalled();
    expect(mockedRefreshNow).not.toHaveBeenCalled();
  });

  it('holds back a PR with unknown unresolved comment state until confirmed', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({
        prNumber: 8,
        unresolvedReviewThreadCount: undefined,
      }) as any,
    );

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      confirmUnresolvedComments: false,
    });

    expect(result.mergedRepos).toEqual([]);
    expect(result.requiresUnresolvedConfirmation).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        prNumber: 8,
        prUrl: 'https://github.com/org/repo/pull/8',
        unresolvedReviewThreadCount: undefined,
      },
    ]);
    expect(mockedMergePrForRepo).not.toHaveBeenCalled();
    expect(mockedRefreshNow).not.toHaveBeenCalled();
  });

  it('merges a PR with unresolved comments once confirmed', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({ prNumber: 8, unresolvedReviewThreadCount: 2 }) as any,
    );
    mockedMergePrForRepo.mockResolvedValue({
      outcome: 'merged',
      mergeMethod: 'merge',
      mergeCommitSha: 'sha999',
    });

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      confirmUnresolvedComments: true,
    });

    expect(result.mergedRepos).toHaveLength(1);
    expect(result.requiresUnresolvedConfirmation).toEqual([]);
    expect(mockedMergePrForRepo).toHaveBeenCalledWith(
      '/workspace/wt/repos/repo-a',
      8,
      'verified-head-sha',
    );
  });

  it('fails instead of merging when the verified PR head SHA is missing', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({
        prNumber: 13,
        headSha: undefined,
        unresolvedReviewThreadCount: 0,
      }) as any,
    );

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.mergedRepos).toEqual([]);
    expect(result.failedRepos).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        prNumber: 13,
        error:
          'Cannot merge the pull request because GitHub did not return a verified head commit SHA.',
        status: 'failed',
      },
    ]);
    expect(mockedMergePrForRepo).not.toHaveBeenCalled();
  });

  it('reports a not-mergeable PR as blocked without merging', async () => {
    jest.useFakeTimers();
    try {
      mockedFetchRepoPrTrackingData.mockResolvedValue(
        makeStatus({
          prNumber: 9,
          mergeableState: 'blocked',
          unresolvedReviewThreadCount: 0,
        }) as any,
      );

      const resultPromise = handler({} as any, {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
      });
      await jest.advanceTimersByTimeAsync(
        2000 + 4000 + 8000 + 16000 + 32000 + 32000 + 32000 + 32000,
      );
      const result = await resultPromise;

      expect(result.mergedRepos).toEqual([]);
      expect(result.verifiedRepos).toEqual([
        {
          repoId: 'repo-a',
          repoName: 'repo-a',
          prNumber: 9,
          prUrl: 'https://github.com/org/repo/pull/9',
          mergeable: false,
          usesMergeQueue: false,
          startsAgentChat: false,
          unresolvedReviewThreadCount: 0,
          blockedReason: 'not_mergeable',
        },
      ]);
      expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledTimes(10);
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.githubMergePrProgress,
        expect.objectContaining({
          phase: 'waiting_mergeability',
          retryDelayMs: 32000,
        }),
      );
      expect(mockedMergePrForRepo).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a temporarily not-mergeable PR before merging', async () => {
    jest.useFakeTimers();
    try {
      mockedFetchRepoPrTrackingData
        .mockResolvedValueOnce(
          makeStatus({ prNumber: 9, unresolvedReviewThreadCount: 0 }) as any,
        )
        .mockResolvedValueOnce(
          makeStatus({
            prNumber: 9,
            mergeableState: 'blocked',
            unresolvedReviewThreadCount: 0,
          }) as any,
        )
        .mockResolvedValueOnce(
          makeStatus({ prNumber: 9, unresolvedReviewThreadCount: 0 }) as any,
        );
      mockedMergePrForRepo.mockResolvedValue({
        outcome: 'merged',
        mergeMethod: 'squash',
        mergeCommitSha: 'sha123',
      });

      const resultPromise = handler({} as any, {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
      });
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(2000);
      const result = await resultPromise;

      expect(result.mergedRepos).toHaveLength(1);
      expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledTimes(3);
      expect(mockedMergePrForRepo).toHaveBeenCalledWith(
        '/workspace/wt/repos/repo-a',
        9,
        'verified-head-sha',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops mergeability retries when the PR base branch changes', async () => {
    jest.useFakeTimers();
    try {
      mockedFetchRepoPrTrackingData
        .mockResolvedValueOnce(
          makeStatus({
            prNumber: 9,
            mergeableState: 'blocked',
            unresolvedReviewThreadCount: 0,
            baseRefName: 'main',
          }) as any,
        )
        .mockResolvedValueOnce(
          makeStatus({
            prNumber: 9,
            mergeableState: 'blocked',
            unresolvedReviewThreadCount: 0,
            baseRefName: 'main',
          }) as any,
        )
        .mockResolvedValueOnce(
          makeStatus({
            prNumber: 9,
            unresolvedReviewThreadCount: 0,
            baseRefName: 'develop',
          }) as any,
        );

      const resultPromise = handler({} as any, {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
      });
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(2000);
      const result = await resultPromise;

      expect(result.mergedRepos).toEqual([]);
      expect(result.verifiedRepos).toEqual([
        {
          repoId: 'repo-a',
          repoName: 'repo-a',
          prNumber: 9,
          prUrl: 'https://github.com/org/repo/pull/9',
          mergeable: false,
          usesMergeQueue: false,
          startsAgentChat: false,
          unresolvedReviewThreadCount: 0,
          blockedReason: 'base_changed',
        },
      ]);
      expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledTimes(3);
      expect(mockedMergePrForRepo).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('flags conflicting PRs with has_conflicts', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({
        prNumber: 10,
        hasConflicts: true,
        mergeableState: 'dirty',
      }) as any,
    );

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.verifiedRepos[0].blockedReason).toBe('has_conflicts');
    expect(result.mergedRepos).toEqual([]);
  });

  it('dry runs without merging but reports verified state', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({ prNumber: 11, unresolvedReviewThreadCount: 1 }) as any,
    );

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.verifiedRepos).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        prNumber: 11,
        prUrl: 'https://github.com/org/repo/pull/11',
        mergeable: true,
        usesMergeQueue: false,
        startsAgentChat: false,
        unresolvedReviewThreadCount: 1,
      },
    ]);
    expect(mockedMergePrForRepo).not.toHaveBeenCalled();
    expect(mockedRefreshNow).not.toHaveBeenCalled();
  });

  it('checks multiple repositories in parallel during a dry run', async () => {
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ]);

    let resolveRepoA: (value: ReturnType<typeof makeStatus>) => void = () => {
      throw new Error('Repo A resolver was not initialized');
    };
    const repoAStatus = new Promise<ReturnType<typeof makeStatus>>(
      (resolve) => {
        resolveRepoA = resolve;
      },
    );
    mockedFetchRepoPrTrackingData.mockImplementation(async (repoPath) => {
      if (repoPath.endsWith('/repo-a')) {
        return repoAStatus;
      }
      return makeStatus({ prNumber: 22, unresolvedReviewThreadCount: 0 });
    });

    const resultPromise = handler(
      {},
      {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        dryRun: true,
      },
    );
    await flushPromises();

    // Repo B starts before repo A finishes; a sequential dry run would still
    // have only one request in flight here.
    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledTimes(2);

    resolveRepoA(makeStatus({ prNumber: 21, unresolvedReviewThreadCount: 0 }));
    const result = await resultPromise;

    expect(result.verifiedRepos.map((repo) => repo.repoName)).toEqual([
      'repo-a',
      'repo-b',
    ]);
    expect(mockedMergePrForRepo).not.toHaveBeenCalled();
  });

  it('keeps unresolved confirmation repos ordered during a parallel dry run', async () => {
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ]);

    let resolveRepoA: (value: ReturnType<typeof makeStatus>) => void = () => {
      throw new Error('Repo A resolver was not initialized');
    };
    const repoAStatus = new Promise<ReturnType<typeof makeStatus>>(
      (resolve) => {
        resolveRepoA = resolve;
      },
    );
    mockedFetchRepoPrTrackingData.mockImplementation(async (repoPath) => {
      if (repoPath.endsWith('/repo-a')) {
        return repoAStatus;
      }
      return makeStatus({ prNumber: 22, unresolvedReviewThreadCount: 1 });
    });

    const resultPromise = handler(
      {},
      {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        dryRun: true,
      },
    );
    await flushPromises();

    resolveRepoA(makeStatus({ prNumber: 21, unresolvedReviewThreadCount: 1 }));
    const result = await resultPromise;

    expect(
      result.requiresUnresolvedConfirmation.map((repo) => repo.repoName),
    ).toEqual(['repo-a', 'repo-b']);
  });

  it('skips repos without an open PR', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
    } as any);

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.verifiedRepos).toEqual([]);
    expect(result.mergedRepos).toEqual([]);
    expect(result.requiresUnresolvedConfirmation).toEqual([]);
    expect(mockedGetRemoteUrl).not.toHaveBeenCalled();
    expect(mockedMergePrForRepo).not.toHaveBeenCalled();
  });

  it('surfaces merge API failures as failed repos', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({ prNumber: 12, unresolvedReviewThreadCount: 0 }) as any,
    );
    mockedMergePrForRepo.mockRejectedValue(
      new Error('merge blocked by branch protection'),
    );

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.mergedRepos).toEqual([]);
    expect(result.failedRepos).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        prNumber: 12,
        error: 'merge blocked by branch protection',
        status: 'failed',
      },
    ]);
    expect(mockedRefreshNow).not.toHaveBeenCalled();
  });

  it('serializes concurrent merge requests for the same GitHub repo', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({ prNumber: 7, unresolvedReviewThreadCount: 0 }) as any,
    );

    let resolveFirstMerge: (value: {
      merged: boolean;
      mergeMethod: string;
      mergeCommitSha: string;
    }) => void = () => {
      throw new Error('First merge resolver was not initialized');
    };
    const firstMerge = new Promise<{
      merged: boolean;
      mergeMethod: string;
      mergeCommitSha: string;
    }>((resolve) => {
      resolveFirstMerge = resolve;
    });

    mockedMergePrForRepo
      .mockReturnValueOnce(firstMerge as any)
      .mockResolvedValueOnce({
        outcome: 'merged',
        mergeMethod: 'squash',
        mergeCommitSha: 'sha456',
      });

    const firstResult = handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });
    await waitForMergePrCalls(1);
    expect(getPrMergeProgress('workspace-a', 'wt-1')).toEqual({
      mergingPr: true,
      mergePrPhase: 'merging',
    });

    const secondResult = handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-2',
    });
    await flushPromises();

    expect(mockedMergePrForRepo).toHaveBeenCalledTimes(1);
    expect(mockWindow.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.githubMergePrProgress,
      expect.objectContaining({
        projectId: 'workspace-a',
        worktreeId: 'wt-2',
        repoId: 'repo-a',
        repoName: 'repo-a',
        phase: 'queued',
        queuePosition: 2,
        queueLength: 2,
      }),
    );
    expect(getPrMergeProgress('workspace-a', 'wt-2')).toEqual({
      mergingPr: true,
      mergePrPhase: 'queued',
    });

    resolveFirstMerge({
      outcome: 'merged',
      mergeMethod: 'squash',
      mergeCommitSha: 'sha123',
    });

    await expect(firstResult).resolves.toMatchObject({
      mergedRepos: [expect.objectContaining({ mergeCommitSha: 'sha123' })],
    });
    await expect(secondResult).resolves.toMatchObject({
      mergedRepos: [expect.objectContaining({ mergeCommitSha: 'sha456' })],
    });
    expect(mockedMergePrForRepo).toHaveBeenCalledTimes(2);
    expect(getPrMergeProgress('workspace-a', 'wt-1')).toEqual({
      mergingPr: false,
      mergePrPhase: null,
    });
    expect(getPrMergeProgress('workspace-a', 'wt-2')).toEqual({
      mergingPr: false,
      mergePrPhase: null,
    });
  });

  it('removes a cancelled merge from the queue before it starts', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeStatus({ prNumber: 7, unresolvedReviewThreadCount: 0 }) as any,
    );

    let resolveFirstMerge: (value: {
      merged: boolean;
      mergeMethod: string;
      mergeCommitSha: string;
    }) => void = () => {
      throw new Error('First merge resolver was not initialized');
    };
    const firstMerge = new Promise<{
      merged: boolean;
      mergeMethod: string;
      mergeCommitSha: string;
    }>((resolve) => {
      resolveFirstMerge = resolve;
    });
    mockedMergePrForRepo.mockReturnValueOnce(firstMerge as any);

    const firstResult = handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      operationId: 'merge-operation-1',
    });
    await waitForMergePrCalls(1);

    const secondResult = handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-2',
      operationId: 'merge-operation-2',
    });
    await flushPromises();
    expect(mockedMergePrForRepo).toHaveBeenCalledTimes(1);

    expect(
      cancelHandler({} as any, {
        projectId: 'workspace-a',
        worktreeId: 'wt-2',
        operationId: 'merge-operation-2',
      }),
    ).toEqual({ accepted: true, reason: 'cancel_requested' });
    await expect(secondResult).resolves.toMatchObject({ cancelled: true });
    expect(mockedMergePrForRepo).toHaveBeenCalledTimes(1);
    expect(getPrMergeProgress('workspace-a', 'wt-2')).toEqual({
      mergingPr: false,
      mergePrPhase: null,
    });

    resolveFirstMerge({
      outcome: 'merged',
      mergeMethod: 'squash',
      mergeCommitSha: 'sha123',
    });
    await expect(firstResult).resolves.toMatchObject({
      mergedRepos: [expect.objectContaining({ mergeCommitSha: 'sha123' })],
    });
  });
  it.each([
    {
      state: 'none',
      dirty: true,
      unpushed: false,
      origin: true,
      ready: false,
      create: true,
      merge: false,
    },
    {
      state: 'open',
      dirty: false,
      unpushed: false,
      origin: true,
      ready: true,
      create: false,
      merge: true,
    },
    {
      state: 'draft',
      dirty: false,
      unpushed: false,
      origin: true,
      ready: true,
      create: false,
      merge: false,
    },
    {
      state: 'open',
      dirty: true,
      unpushed: false,
      origin: true,
      ready: true,
      create: false,
      merge: false,
    },
    {
      state: 'open',
      dirty: false,
      unpushed: true,
      origin: true,
      ready: true,
      create: false,
      merge: false,
    },
    {
      state: 'none',
      dirty: true,
      unpushed: false,
      origin: false,
      ready: false,
      create: false,
      merge: false,
    },
    {
      state: 'open',
      dirty: false,
      unpushed: false,
      origin: true,
      ready: false,
      create: false,
      merge: false,
    },
  ])(
    'projects remote PR eligibility from GitHub and local state: %j',
    async (scenario) => {
      const git = await import('../lib/git');
      const bases = await import('../lib/worktree-base-branches');
      const service = await import('../services/pr-service');
      const { runWorktreePrAction } =
        await import('../services/pr-worktree-actions');
      mockedIsMultiRepoWorkspace.mockReturnValue(false);
      mockedGetRemoteUrl.mockResolvedValue(
        scenario.origin ? 'https://github.com/org/repo.git' : '',
      );
      jest.mocked(git.hasUncommittedChanges).mockResolvedValue(scenario.dirty);
      jest.mocked(git.hasUnpushedCommits).mockResolvedValue(scenario.unpushed);
      jest
        .mocked(git.hasRemoteTrackingBranch)
        .mockResolvedValue(scenario.state !== 'none');
      jest
        .mocked(git.hasBranchBeenPushedToRemote)
        .mockResolvedValue(scenario.state !== 'none');
      jest.mocked(git.hasUnpulledCommits).mockResolvedValue(false);
      mockedGetAheadBehindCounts.mockResolvedValue({
        ahead: scenario.unpushed ? 1 : 0,
        behind: 0,
      });
      jest.mocked(git.hasCommitsAhead).mockResolvedValue(true);
      jest.mocked(bases.resolveEffectiveBaseBranchForRepo).mockResolvedValue({
        branch: 'main',
        existsLocally: true,
        existsInRemote: true,
      });
      const refresh = jest
        .spyOn(service, 'refreshPullRequestState')
        .mockResolvedValue({
          workspaceLocalId: 'project-1',
          worktreeLocalId: 'worktree-1',
          repos: [
            {
              repoId: 'repo-a',
              repoName: 'App',
              prLookupAvailable: true,
              status:
                scenario.state === 'none'
                  ? null
                  : {
                      state: scenario.state,
                      mergeReady: scenario.ready,
                      unresolvedReviewThreadCount: 0,
                    },
            },
          ],
        });
      try {
        const result = await runWorktreePrAction({
          action: 'get_actions',
          workspaceLocalId: 'project-1',
          worktreeLocalId: 'worktree-1',
        });
        expect(result).toEqual(
          expect.objectContaining({
            repos: [
              expect.objectContaining({
                canCreate: scenario.create,
                canMerge: scenario.merge,
              }),
            ],
          }),
        );
      } finally {
        refresh.mockRestore();
      }
    },
  );

  it('blocks create when GitHub could not verify that no PR exists', async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
    mockedGetCurrentBranch.mockResolvedValue('feature');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(true);
    jest.mocked(git.hasBranchBeenPushedToRemote).mockResolvedValue(false);
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(true);
    jest.mocked(bases.resolveEffectiveBaseBranchForRepo).mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: true,
    });
    const unavailableState = {
      workspaceLocalId: 'project-1',
      worktreeLocalId: 'worktree-1',
      repos: [
        {
          repoId: 'repo-a',
          repoName: 'App',
          status: null,
          prLookupAvailable: false,
        },
      ],
    };
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue(unavailableState);

    try {
      await expect(
        runWorktreePrAction({
          action: 'get_actions',
          workspaceLocalId: 'project-1',
          worktreeLocalId: 'worktree-1',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              canCreate: false,
              createBlockedReason: 'pr_status_unavailable',
            }),
          ],
        }),
      );
    } finally {
      refresh.mockRestore();
    }
  });
  it.each([
    {
      name: 'no origin remote',
      origin: false,
      dirty: true,
      expected: { createBlockedReason: 'no_remote' },
    },
    {
      name: 'the worktree sits on the base branch',
      branch: 'main',
      dirty: true,
      expected: { createBlockedReason: 'base_branch' },
    },
    {
      name: 'nothing has changed yet',
      expected: { createBlockedReason: 'no_changes' },
    },
    {
      name: 'the dirty branch is behind its remote',
      dirty: true,
      tracking: true,
      unpulled: true,
      ahead: true,
      expected: { createBlockedReason: 'needs_pull' },
    },
    {
      name: 'a draft pull request is open',
      state: 'draft',
      ready: true,
      expected: { createBlockedReason: 'pr_open', mergeBlockedReason: 'draft' },
    },
    {
      name: 'checks are failing',
      state: 'open',
      checkStatus: 'failing',
      expected: { mergeBlockedReason: 'checks_failing' },
    },
    {
      name: 'checks are still running',
      state: 'open',
      checkStatus: 'pending',
      expected: { mergeBlockedReason: 'checks_pending' },
    },
    {
      name: 'the review is outstanding',
      state: 'open',
      reviewStatus: 'pending',
      expected: { mergeBlockedReason: 'review_pending' },
    },
    {
      name: 'GitHub is not ready and no review is required',
      state: 'open',
      reviewStatus: 'none',
      expected: { mergeBlockedReason: 'not_ready' },
    },
    {
      name: 'the pull request has conflicts',
      state: 'open',
      hasConflicts: true,
      expected: { mergeBlockedReason: 'conflicts' },
    },
    {
      name: 'the worktree has uncommitted work',
      state: 'open',
      ready: true,
      dirty: true,
      expected: { mergeBlockedReason: 'local_changes' },
    },
  ])('explains why a PR action is unavailable: $name', async (scenario) => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    const state: string = scenario.state ?? 'none';
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedGetCurrentBranch.mockResolvedValue(scenario.branch ?? 'feature');
    mockedGetRemoteUrl.mockResolvedValue(
      scenario.origin === false ? '' : 'https://github.com/org/repo.git',
    );
    jest
      .mocked(git.hasUncommittedChanges)
      .mockResolvedValue(scenario.dirty === true);
    jest.mocked(git.hasUnpushedCommits).mockResolvedValue(false);
    jest
      .mocked(git.hasRemoteTrackingBranch)
      .mockResolvedValue(
        scenario.tracking === true || state === 'open' || state === 'draft',
      );
    jest
      .mocked(git.hasBranchBeenPushedToRemote)
      .mockResolvedValue(
        scenario.tracking === true || state === 'open' || state === 'draft',
      );
    jest
      .mocked(git.hasUnpulledCommits)
      .mockResolvedValue(scenario.unpulled === true);
    mockedGetAheadBehindCounts.mockResolvedValue({
      ahead: 0,
      behind: scenario.unpulled === true ? 1 : 0,
    });
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(scenario.ahead === true);
    jest
      .mocked(git.getDiffStats)
      .mockResolvedValue({ insertions: 0, deletions: 0 } as any);
    jest
      .mocked(bases.resolveEffectiveBaseBranchForRepo)
      .mockResolvedValue({ branch: 'main', existsInRemote: true } as any);
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'App',
            prLookupAvailable: true,
            status:
              state === 'none'
                ? null
                : {
                    state,
                    checkStatus: scenario.checkStatus ?? 'passing',
                    reviewStatus: scenario.reviewStatus ?? 'approved',
                    hasConflicts: scenario.hasConflicts === true,
                    mergeReady: scenario.ready === true,
                    unresolvedReviewThreadCount: 0,
                  },
          },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(result).toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              baseBranch: 'main',
              ...scenario.expected,
            }),
          ],
        }),
      );
    } finally {
      refresh.mockRestore();
    }
  });
  it('passes each check execution state through get_actions', async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(false);
    jest.mocked(git.hasUnpushedCommits).mockResolvedValue(false);
    jest.mocked(git.hasRemoteTrackingBranch).mockResolvedValue(true);
    jest.mocked(git.hasBranchBeenPushedToRemote).mockResolvedValue(true);
    jest.mocked(git.hasUnpulledCommits).mockResolvedValue(false);
    mockedGetAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 0 });
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(true);
    jest
      .mocked(git.getDiffStats)
      .mockResolvedValue({ insertions: 0, deletions: 0 } as any);
    jest
      .mocked(bases.resolveEffectiveBaseBranchForRepo)
      .mockResolvedValue({ branch: 'main', existsInRemote: true } as any);
    const checkDetails = [
      {
        name: 'build',
        status: 'pending' as const,
        executionState: 'running' as const,
        detailsUrl: 'https://github.com/org/repo/actions/runs/1/job/2',
      },
      { name: 'legacy', status: 'success' as const, detailsUrl: null },
    ];
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'App',
            prLookupAvailable: true,
            status: {
              state: 'open',
              checkStatus: 'pending',
              checkDetails,
              reviewStatus: 'approved',
              hasConflicts: false,
              mergeReady: false,
              unresolvedReviewThreadCount: 0,
            },
          },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(result).toMatchObject({
        repos: [{ status: { checkStatus: 'pending', checkDetails } }],
      });
    } finally {
      refresh.mockRestore();
    }
  });

  it("blames the dirty sibling when it blocks a clean repo's merge", async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ] as any);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    // Only repo-b has uncommitted work.
    jest
      .mocked(git.hasUncommittedChanges)
      .mockImplementation((repoPath: string) =>
        Promise.resolve(repoPath.endsWith('/repo-b')),
      );
    jest.mocked(git.hasUnpushedCommits).mockResolvedValue(false);
    jest.mocked(git.hasRemoteTrackingBranch).mockResolvedValue(true);
    jest.mocked(git.hasBranchBeenPushedToRemote).mockResolvedValue(true);
    jest.mocked(git.hasUnpulledCommits).mockResolvedValue(false);
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(true);
    jest
      .mocked(bases.resolveEffectiveBaseBranchForRepo)
      .mockResolvedValue({ branch: 'main', existsInRemote: true } as any);
    const openPr = {
      state: 'open',
      checkStatus: 'passing',
      reviewStatus: 'approved',
      hasConflicts: false,
      mergeReady: true,
      unresolvedReviewThreadCount: 0,
    };
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          { repoId: 'repo-a', repoName: 'repo-a', status: { ...openPr } },
          { repoId: 'repo-b', repoName: 'repo-b', status: { ...openPr } },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(result).toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              repoId: 'repo-a',
              canMerge: false,
              mergeBlockedReason: 'other_repo_changes',
            }),
            expect.objectContaining({
              repoId: 'repo-b',
              canMerge: false,
              mergeBlockedReason: 'local_changes',
            }),
          ],
        }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it("blocks a clean repo's merge for a sibling ahead of its remote", async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ] as any);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(false);
    jest.mocked(git.hasUnpushedCommits).mockResolvedValue(false);
    jest.mocked(git.hasRemoteTrackingBranch).mockResolvedValue(true);
    jest.mocked(git.hasBranchBeenPushedToRemote).mockResolvedValue(true);
    jest.mocked(git.hasUnpulledCommits).mockResolvedValue(false);
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(true);
    mockedGetAheadBehindCounts.mockImplementation((repoPath: string) =>
      Promise.resolve({
        ahead: repoPath.endsWith('/repo-b') ? 1 : 0,
        behind: 0,
      }),
    );
    jest
      .mocked(bases.resolveEffectiveBaseBranchForRepo)
      .mockResolvedValue({ branch: 'main', existsInRemote: true } as any);
    const readyPr = {
      state: 'open',
      checkStatus: 'passing',
      reviewStatus: 'approved',
      hasConflicts: false,
      mergeReady: true,
      unresolvedReviewThreadCount: 0,
    };
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          { repoId: 'repo-a', repoName: 'repo-a', status: readyPr },
          {
            repoId: 'repo-b',
            repoName: 'repo-b',
            status: { ...readyPr, state: 'merged', mergeReady: false },
          },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(result).toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              repoId: 'repo-a',
              canMerge: false,
              mergeBlockedReason: 'other_repo_changes',
            }),
            expect.objectContaining({
              repoId: 'repo-b',
              canMerge: false,
              mergeBlockedReason: 'no_pr',
            }),
          ],
        }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it("blocks a clean repo's merge for an unpublished sibling with committed changes", async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(false);
    jest
      .mocked(git.hasBranchBeenPushedToRemote)
      .mockImplementation((repoPath: string) =>
        Promise.resolve(repoPath.endsWith('/repo-a')),
      );
    jest.mocked(git.hasUnpulledCommits).mockResolvedValue(false);
    jest
      .mocked(git.hasCommitsAhead)
      .mockImplementation((repoPath: string) =>
        Promise.resolve(repoPath.endsWith('/repo-b')),
      );
    mockedGetAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 0 });
    jest.mocked(bases.resolveEffectiveBaseBranchForRepo).mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: true,
    });
    const readyPr = {
      state: 'open',
      checkStatus: 'passing',
      reviewStatus: 'approved',
      hasConflicts: false,
      mergeReady: true,
      unresolvedReviewThreadCount: 0,
    };
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          { repoId: 'repo-a', repoName: 'repo-a', status: readyPr },
          { repoId: 'repo-b', repoName: 'repo-b', status: null },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(result).toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              repoId: 'repo-a',
              canMerge: false,
              mergeBlockedReason: 'other_repo_changes',
            }),
            expect.objectContaining({
              repoId: 'repo-b',
              canMerge: false,
              mergeBlockedReason: 'no_pr',
            }),
          ],
        }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it('fetches origin once per repository while projecting PR actions', async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(false);
    jest.mocked(git.hasBranchBeenPushedToRemote).mockResolvedValue(true);
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(false);
    jest
      .mocked(git.getDiffStats)
      .mockResolvedValue({ insertions: 0, deletions: 0 });
    jest.mocked(bases.resolveEffectiveBaseBranchForRepo).mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: true,
    });
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [{ repoId: 'repo-a', repoName: 'repo-a', status: null }],
      });
    try {
      await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(mockedFetchOrigin).toHaveBeenCalledTimes(1);
    } finally {
      refresh.mockRestore();
    }
  });

  it('lets every clean repo merge when no sibling is dirty', async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ] as any);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(false);
    jest.mocked(git.hasUnpushedCommits).mockResolvedValue(false);
    jest.mocked(git.hasRemoteTrackingBranch).mockResolvedValue(true);
    jest.mocked(git.hasBranchBeenPushedToRemote).mockResolvedValue(true);
    jest.mocked(git.hasUnpulledCommits).mockResolvedValue(false);
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(true);
    jest
      .mocked(bases.resolveEffectiveBaseBranchForRepo)
      .mockResolvedValue({ branch: 'main', existsInRemote: true } as any);
    const openPr = {
      state: 'open',
      checkStatus: 'passing',
      reviewStatus: 'approved',
      hasConflicts: false,
      mergeReady: true,
      unresolvedReviewThreadCount: 0,
    };
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          { repoId: 'repo-a', repoName: 'repo-a', status: { ...openPr } },
          { repoId: 'repo-b', repoName: 'repo-b', status: { ...openPr } },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(result).toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              canMerge: true,
              mergeBlockedReason: undefined,
            }),
            expect.objectContaining({
              canMerge: true,
              mergeBlockedReason: undefined,
            }),
          ],
        }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it('projects the refreshed pull request base after a retarget', async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(false);
    jest.mocked(git.hasRemoteTrackingBranch).mockResolvedValue(true);
    jest.mocked(git.hasBranchBeenPushedToRemote).mockResolvedValue(true);
    jest.mocked(git.hasUnpulledCommits).mockResolvedValue(false);
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(true);
    mockedGetAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 0 });
    jest
      .mocked(bases.resolveEffectiveBaseBranchForRepo)
      .mockResolvedValue({ branch: 'main', existsInRemote: true } as any);
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'App',
            status: {
              number: 42,
              state: 'open',
              baseRefName: 'release',
              checkStatus: 'passing',
              reviewStatus: 'approved',
              hasConflicts: false,
              mergeReady: true,
              unresolvedReviewThreadCount: 0,
            },
          },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(result).toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              baseBranch: 'release',
              canMerge: true,
            }),
          ],
        }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it('omits the base branch when it cannot be resolved', async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(true);
    jest.mocked(git.hasUnpushedCommits).mockResolvedValue(false);
    jest.mocked(git.hasRemoteTrackingBranch).mockResolvedValue(false);
    jest.mocked(git.hasUnpulledCommits).mockResolvedValue(false);
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(true);
    jest
      .mocked(bases.resolveEffectiveBaseBranchForRepo)
      .mockResolvedValue({ branch: null, existsInRemote: false } as any);
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'App',
            status: null,
            prLookupAvailable: true,
          },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      // Mobile falls back to a bare "Create PR" label rather than inventing
      // a branch name.
      expect(result).toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              baseBranch: undefined,
              headBranch: 'feature',
            }),
          ],
        }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it('projects the remote default when the configured base is local-only', async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(true);
    jest.mocked(git.hasRemoteTrackingBranch).mockResolvedValue(false);
    jest.mocked(bases.resolveEffectiveBaseBranchForRepo).mockResolvedValue({
      branch: 'stack/local-only',
      existsLocally: true,
      existsInRemote: false,
    });
    jest.mocked(bases.resolveRepoDefaultBranch).mockResolvedValue('main');
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'App',
            status: null,
            prLookupAvailable: true,
          },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(result).toEqual(
        expect.objectContaining({
          repos: [expect.objectContaining({ baseBranch: 'main' })],
        }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it('uses freshly fetched branch divergence for create eligibility', async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(true);
    jest.mocked(git.hasRemoteTrackingBranch).mockResolvedValue(true);
    jest.mocked(git.hasBranchBeenPushedToRemote).mockResolvedValue(true);
    mockedGetAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });
    jest.mocked(bases.resolveEffectiveBaseBranchForRepo).mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: true,
    });
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'App',
            status: null,
            prLookupAvailable: true,
          },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(result).toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({ createBlockedReason: 'needs_pull' }),
          ],
        }),
      );
      expect(mockedFetchOrigin.mock.invocationCallOrder[0]).toBeLessThan(
        mockedGetAheadBehindCounts.mock.invocationCallOrder[0],
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it('blocks merge for commits ahead of the remote branch without an upstream', async () => {
    const git = await import('../lib/git');
    const bases = await import('../lib/worktree-base-branches');
    const service = await import('../services/pr-service');
    const { runWorktreePrAction } =
      await import('../services/pr-worktree-actions');
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature');
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
    jest.mocked(git.hasUncommittedChanges).mockResolvedValue(false);
    jest.mocked(git.hasUnpushedCommits).mockResolvedValue(false);
    jest.mocked(git.hasRemoteTrackingBranch).mockResolvedValue(true);
    jest.mocked(git.hasBranchBeenPushedToRemote).mockResolvedValue(true);
    mockedGetAheadBehindCounts.mockResolvedValue({ ahead: 1, behind: 0 });
    jest.mocked(git.hasCommitsAhead).mockResolvedValue(true);
    jest.mocked(bases.resolveEffectiveBaseBranchForRepo).mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: true,
    });
    const refresh = jest
      .spyOn(service, 'refreshPullRequestState')
      .mockResolvedValue({
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'App',
            status: {
              state: 'open',
              mergeReady: true,
              unresolvedReviewThreadCount: 0,
            },
          },
        ],
      });
    try {
      const result = await runWorktreePrAction({
        action: 'get_actions',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(result).toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              canMerge: false,
              mergeBlockedReason: 'local_changes',
            }),
          ],
        }),
      );
    } finally {
      refresh.mockRestore();
    }
  });
});
