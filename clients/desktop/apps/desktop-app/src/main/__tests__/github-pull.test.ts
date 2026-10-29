/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
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

jest.mock('../lib/git', () => ({
  isGitRepo: jest.fn(() => Promise.resolve(false)),
  fetchOrigin: jest.fn(() => Promise.resolve()),
  getCurrentBranch: jest.fn(),
  getDiffStats: jest.fn(),
  getFullDiff: jest.fn(),
  getCommitLog: jest.fn(),
  getRemoteUrl: jest.fn(),
  pushBranch: jest.fn(),
  pullBranchFastForward: jest.fn(),
  pullBranchRebase: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
  hasAutostashEntry: jest.fn(),
  hasUnmergedPaths: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  hasCommitsAhead: jest.fn(),
  hasRemoteTrackingBranch: jest.fn(),
  hasUnpulledCommits: jest.fn(),
  hasUnpushedCommits: jest.fn(),
  isRebaseInProgress: jest.fn(),
  stageAllChanges: jest.fn(),
  commitWithMessage: jest.fn(),
  getUncommittedDiff: jest.fn(),
}));

jest.mock('../lib/github-pr', () => ({
  createPrForRepo: jest.fn(),
  updatePrBaseBranchForRepo: jest.fn(),
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
  setForegroundWorktree: jest.fn(),
}));

jest.mock('../lib/commit-message-generator', () => ({
  generateCommitMessage: jest.fn(),
}));

jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(),
}));

jest.mock('../lib/rebase-resolution-chat', () => ({
  launchRebaseResolutionChat: jest.fn(),
}));

jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { readdir } from 'node:fs/promises';
import {
  fetchOrigin,
  getCurrentBranch,
  getRemoteUrl,
  hasRemoteTrackingBranch,
  isRebaseInProgress,
  hasUnpulledCommits,
  hasUnpushedCommits,
  pullBranchFastForward,
  pullBranchRebase,
} from '../lib/git';
import { launchRebaseResolutionChat } from '../lib/rebase-resolution-chat';
import { readPreferencesFile } from '../ipc/preferences';
import { registerIpcHandler } from '../ipc/register';
import { requestGitActionCancellation } from '../ipc/git-action-cancellation';
import {
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
} from '@canopy/desktop-shared/types';
import type {
  PullResponse,
  WorktreePullRequest,
} from '@canopy/desktop-shared/types/github';

const mockedReaddir = jest.mocked(readdir);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedHasRemoteTrackingBranch = jest.mocked(hasRemoteTrackingBranch);
const mockedIsRebaseInProgress = jest.mocked(isRebaseInProgress);
const mockedHasUnpulledCommits = jest.mocked(hasUnpulledCommits);
const mockedHasUnpushedCommits = jest.mocked(hasUnpushedCommits);
const mockedPullBranchFastForward = jest.mocked(pullBranchFastForward);
const mockedPullBranchRebase = jest.mocked(pullBranchRebase);
const mockedLaunchRebaseResolutionChat = jest.mocked(
  launchRebaseResolutionChat,
);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

type HandlerFn = (
  event: any,
  request: WorktreePullRequest,
) => Promise<PullResponse>;

function getPullHandler(): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (entry: any[]) => entry[0] === IPC_CHANNELS.githubPull,
  );
  if (!call) {
    throw new Error('githubPull handler not registered');
  }
  return call[1] as unknown as HandlerFn;
}

describe('githubPull handler', () => {
  let handler: HandlerFn;

  beforeAll(async () => {
    const { getGitHubClient } = await import('../lib/github-client');
    jest.mocked(getGitHubClient).mockReturnValue({} as any);

    const { registerGitHubHandlers } = await import('../ipc/github');
    const mockWindow = {
      isDestroyed: (): boolean => false,
      webContents: {
        send: jest.fn(),
        isDestroyed: (): boolean => false,
        isCrashed: (): boolean => false,
        mainFrame: { isDestroyed: (): boolean => false, detached: false },
      },
    };
    registerGitHubHandlers(() => mockWindow as any);
    handler = getPullHandler();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedFetchOrigin.mockResolvedValue();
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:org/repo.git');
    mockedHasRemoteTrackingBranch.mockResolvedValue(true);
    mockedIsRebaseInProgress.mockResolvedValue(false);
    mockedHasUnpulledCommits.mockResolvedValue(true);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedPullBranchFastForward.mockResolvedValue();
    mockedPullBranchRebase.mockResolvedValue();
    mockedLaunchRebaseResolutionChat.mockResolvedValue({ chatId: 'chat-1' });
    mockedReadPreferencesFile.mockResolvedValue({
      agentRebaseResolutionEnabled: false,
    } as any);
  });

  it('uses fast-forward pull for behind-only branches', async () => {
    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(mockedFetchOrigin).toHaveBeenCalledWith('/workspace/single-repo', {
      prune: true,
    });
    expect(result.repos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        status: 'success',
      },
    ]);
    expect(result.agentResolutionRepos).toEqual([]);
    expect(mockedPullBranchFastForward).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'feature-branch',
    );
    expect(mockedPullBranchRebase).not.toHaveBeenCalled();
  });

  it('uses rebase pull for clean diverged branches', async () => {
    mockedHasUnpushedCommits.mockResolvedValue(true);

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        status: 'success',
      },
    ]);
    expect(result.agentResolutionRepos).toEqual([]);
    expect(mockedPullBranchRebase).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'feature-branch',
    );
    expect(mockedPullBranchFastForward).not.toHaveBeenCalled();
  });

  it('returns no_remote_origin skips alongside successful pulls', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      { name: 'repo-a', isDirectory: (): boolean => true },
      { name: 'repo-b', isDirectory: (): boolean => true },
    ] as any);
    mockedGetRemoteUrl
      .mockResolvedValueOnce('git@github.com:org/repo-a.git')
      .mockResolvedValueOnce(null);
    mockedFetchOrigin.mockResolvedValueOnce();
    mockedHasRemoteTrackingBranch.mockResolvedValueOnce(true);
    mockedHasUnpulledCommits.mockResolvedValueOnce(true);
    mockedHasUnpushedCommits.mockResolvedValueOnce(false);

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        status: 'success',
      },
    ]);
    expect(result.agentResolutionRepos).toEqual([]);
    expect(result.skippedRepos).toEqual([
      {
        repoId: 'repo-b',
        repoName: 'repo-b',
        reason: 'no_remote_origin',
      },
    ]);
  });

  it('skips repos without an origin remote before fetching', async () => {
    mockedGetRemoteUrl.mockResolvedValue(null);

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('No repos needed to pull');

    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedHasRemoteTrackingBranch).not.toHaveBeenCalled();
  });

  it('stops pulling after a pruned fetch detects the remote branch is gone', async () => {
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpulledCommits.mockResolvedValue(false);

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('No repos needed to pull');

    expect(mockedFetchOrigin).toHaveBeenCalledWith('/workspace/single-repo', {
      prune: true,
    });
    expect(mockedPullBranchFastForward).not.toHaveBeenCalled();
    expect(mockedPullBranchRebase).not.toHaveBeenCalled();
  });

  it('prunes again when the remote branch disappears during pull', async () => {
    mockedPullBranchFastForward.mockRejectedValue(
      new Error("couldn't find remote ref feature-branch"),
    );

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(mockedFetchOrigin).toHaveBeenNthCalledWith(
      1,
      '/workspace/single-repo',
      { prune: true },
    );
    expect(mockedFetchOrigin).toHaveBeenNthCalledWith(
      2,
      '/workspace/single-repo',
      { prune: true },
    );
    expect(result.failedRepos).toEqual([
      expect.objectContaining({
        repoName: 'single-repo',
        error: "couldn't find remote ref feature-branch",
        status: 'failed',
      }),
    ]);
  });

  it('starts an agent resolution chat for rebase conflicts when enabled', async () => {
    const pullError = Object.assign(new Error('pull failed'), {
      stderr: 'CONFLICT (content): Merge conflict',
    });
    mockedHasUnpushedCommits.mockResolvedValue(true);
    mockedPullBranchRebase.mockRejectedValue(pullError);
    mockedIsRebaseInProgress.mockResolvedValue(true);
    mockedReadPreferencesFile.mockResolvedValue({
      agentRebaseResolutionEnabled: true,
    } as any);

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([]);
    expect(result.failedRepos).toEqual([]);
    expect(result.agentResolutionRepos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        chatId: 'chat-1',
        kind: 'rebase_conflict',
      },
    ]);
    const launchArgs = mockedLaunchRebaseResolutionChat.mock.calls[0]?.[0];
    expect(launchArgs?.projectId).toBe('project-a');
    expect(launchArgs?.worktreeId).toBe('wt-1');
    expect(launchArgs?.context).toMatchObject({
      kind: 'rebase_conflict',
      repoName: 'single-repo',
      branchName: 'feature-branch',
      repoPath: '/workspace/single-repo',
      errorMessage: 'CONFLICT (content): Merge conflict',
    });
  });

  it('does not start agent resolution after cancellation is accepted during a failed pull', async () => {
    const request: WorktreePullRequest = {
      projectId: 'project-a',
      worktreeId: 'wt-1',
      operationId: 'operation-1',
    };
    const pullError = Object.assign(new Error('pull failed'), {
      stderr: 'CONFLICT (content): Merge conflict',
    });
    mockedHasUnpushedCommits.mockResolvedValue(true);
    mockedPullBranchRebase.mockImplementation(() => {
      expect(
        requestGitActionCancellation({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          operationId: 'operation-1',
        }),
      ).toEqual({ accepted: true, reason: 'cancel_requested' });
      return Promise.reject(pullError);
    });
    mockedIsRebaseInProgress.mockResolvedValue(true);
    mockedReadPreferencesFile.mockResolvedValue({
      agentRebaseResolutionEnabled: true,
    } as any);

    const result = await handler({} as any, request);

    expect(result.cancelled).toBe(true);
    expect(mockedLaunchRebaseResolutionChat).not.toHaveBeenCalled();
  });

  it('returns manual resolution guidance for rebase conflicts when agent resolution is disabled', async () => {
    const pullError = Object.assign(new Error('pull failed'), {
      stderr: 'CONFLICT (content): Merge conflict',
    });
    mockedHasUnpushedCommits.mockResolvedValue(true);
    mockedPullBranchRebase.mockRejectedValue(pullError);
    mockedIsRebaseInProgress.mockResolvedValue(true);
    mockedReadPreferencesFile.mockResolvedValue({
      agentRebaseResolutionEnabled: false,
    } as any);

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([]);
    expect(result.agentResolutionRepos).toEqual([]);
    expect(result.failedRepos).toHaveLength(1);
    expect(result.failedRepos[0]).toMatchObject({
      repoId: SINGLE_REPO_USAGE_REPO_ID,
      repoName: 'single-repo',
      status: 'failed',
    });
    expect(result.failedRepos[0]?.error).toContain(
      'Rebase conflict while pulling "feature-branch" in "single-repo". The repo is mid-rebase and needs manual resolution.',
    );
    expect(result.failedRepos[0]?.error).toContain(
      'Next steps: resolve conflicts in the listed files, `git add` them, then run `git rebase --continue`.',
    );
    expect(result.failedRepos[0]?.error).toContain(
      'CONFLICT (content): Merge conflict',
    );
    expect(mockedLaunchRebaseResolutionChat).not.toHaveBeenCalled();
  });
});
