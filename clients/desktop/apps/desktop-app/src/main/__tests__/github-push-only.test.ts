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
  getCurrentBranch: jest.fn(),
  fetchOrigin: jest.fn(),
  hasUnpulledCommits: jest.fn(),
  pullBranchRebase: jest.fn(),
  getDiffStats: jest.fn(),
  getFullDiff: jest.fn(),
  getCommitLog: jest.fn(),
  getRemoteUrl: jest.fn(),
  getPushRemoteUrlStrict: jest.fn(),
  pushBranch: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  hasCommitsAhead: jest.fn(),
  hasRemoteTrackingBranch: jest.fn(),
  hasUnpushedCommits: jest.fn(),
  stageAllChanges: jest.fn(),
  commitWithMessage: jest.fn(),
  getUncommittedDiff: jest.fn(),
}));

jest.mock('../lib/github-pr', () => ({
  createPrForRepo: jest.fn(),
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

jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

const mockScheduleKnown = jest.fn(() => Promise.resolve());
jest.mock('../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleKnown: typeof mockScheduleKnown;
  } => ({
    scheduleKnown: mockScheduleKnown,
  }),
}));

import { readdir } from 'node:fs/promises';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import {
  getRemoteUrl,
  getPushRemoteUrlStrict,
  getCurrentBranch,
  fetchOrigin,
  hasUnpulledCommits,
  pullBranchRebase,
  commitWithMessage,
  hasRemoteTrackingBranch,
  hasUnpushedCommits,
  pushBranch,
} from '../lib/git';
import { registerIpcHandler } from '../ipc/register';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  PushOnlyRequest,
  PushOnlyResponse,
} from '@canopy/desktop-shared/types/github';

const mockedReaddir = jest.mocked(readdir);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedHasRemoteTrackingBranch = jest.mocked(hasRemoteTrackingBranch);
const mockedHasUnpushedCommits = jest.mocked(hasUnpushedCommits);
const mockedPushBranch = jest.mocked(pushBranch);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
// The user flows pass fetchOrigin a signal so failures are not swallowed.
const ANY_SIGNAL: unknown = expect.any(AbortSignal);

type HandlerFn = (
  event: any,
  request: PushOnlyRequest,
) => Promise<PushOnlyResponse>;

function getPushOnlyHandler(): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (entry: any[]) => entry[0] === IPC_CHANNELS.githubPushOnly,
  );
  if (!call) {
    throw new Error('githubPushOnly handler not registered');
  }
  return call[1] as unknown as HandlerFn;
}

function makeDirent(name: string): any {
  return { name, isDirectory: (): boolean => true };
}

describe('githubPushOnly handler', () => {
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
    registerGitHubHandlers(() => mockWindow as any, {
      // These tests reach no projected pull request read.
      dispatcher: {} as never,
      resolveCaller: () => {
        throw new Error('No projected pull request read in this test.');
      },
    });
    handler = getPushOnlyHandler();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:org/repo.git');
  });

  it('returns successes, skips, and failures for multi-repo push-only runs', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
      makeDirent('repo-c'),
      makeDirent('repo-d'),
    ] as any);
    mockedGetRemoteUrl
      .mockResolvedValueOnce('git@github.com:org/repo-a.git')
      .mockResolvedValueOnce('git@github.com:org/repo-b.git')
      .mockResolvedValueOnce('git@github.com:org/repo-c.git')
      .mockResolvedValueOnce(null);

    mockedHasRemoteTrackingBranch
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockedHasUnpushedCommits
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockedPushBranch
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('push rejected'));

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
    expect(result.failedRepos).toEqual([
      {
        repoId: 'repo-b',
        repoName: 'repo-b',
        error: 'push rejected',
        status: 'failed',
      },
    ]);
    expect(result.skippedRepos).toEqual([
      {
        repoId: 'repo-c',
        repoName: 'repo-c',
        reason: 'no_commits_ahead',
      },
      {
        repoId: 'repo-d',
        repoName: 'repo-d',
        reason: 'no_remote_origin',
      },
    ]);
    expect(mockScheduleKnown).toHaveBeenCalledTimes(1);
    expect(mockScheduleKnown).toHaveBeenCalledWith('workspace-a', 'wt-1');
  });

  it('keeps a successful push successful when publication scheduling fails', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedHasRemoteTrackingBranch.mockResolvedValue(true);
    mockedHasUnpushedCommits.mockResolvedValue(true);
    mockedPushBranch.mockResolvedValue();
    mockScheduleKnown.mockRejectedValueOnce(
      new Error('state store unavailable'),
    );

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).resolves.toMatchObject({
      repos: [{ status: 'success' }],
      failedRepos: [],
    });
    expect(mockScheduleKnown).toHaveBeenCalledWith('project-a', 'wt-1');
  });

  it('throws when no repos have commits to push', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedHasRemoteTrackingBranch.mockResolvedValue(true);
    mockedHasUnpushedCommits.mockResolvedValue(false);

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('No repos had commits to push');
    expect(mockScheduleKnown).not.toHaveBeenCalled();
  });

  it('skips repos without an origin remote before tracking checks', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedGetRemoteUrl.mockResolvedValue(null);

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('No repos had commits to push');

    expect(mockedHasRemoteTrackingBranch).not.toHaveBeenCalled();
    expect(mockedHasUnpushedCommits).not.toHaveBeenCalled();
  });

  it('classifies the push destination and preserves the original error', async () => {
    jest.mocked(isMultiRepoWorkspace).mockReturnValue(false);
    jest.mocked(resolveWorktreeCwd).mockReturnValue('/workspace/wt');
    jest.mocked(getRemoteUrl).mockResolvedValue('https://github.com/a/b');
    jest
      .mocked(getPushRemoteUrlStrict)
      .mockResolvedValue('https://github.com/a/b');
    jest.mocked(hasRemoteTrackingBranch).mockResolvedValue(true);
    jest.mocked(hasUnpushedCommits).mockResolvedValue(true);
    jest
      .mocked(pushBranch)
      .mockRejectedValue(new Error('Authentication failed'));
    const result = await handler(
      {},
      { projectId: 'workspace-a', worktreeId: 'wt-1' },
    );
    expect(result.failedRepos[0]).toMatchObject({
      error: 'Authentication failed',
      failureCode: 'github_not_authenticated',
    });
    jest.mocked(getPushRemoteUrlStrict).mockResolvedValue('git@github.com:a/b');
    const ssh = await handler(
      {},
      { projectId: 'workspace-a', worktreeId: 'wt-1' },
    );
    expect(ssh.failedRepos[0]).not.toHaveProperty('failureCode');
  });

  it.each([false, true])(
    'preserves a pending rebase-pull before continuing an existing push, behind: %s',
    async (behind) => {
      jest.mocked(isMultiRepoWorkspace).mockReturnValue(false);
      jest.mocked(resolveWorktreeCwd).mockReturnValue('/workspace/wt');
      jest.mocked(getCurrentBranch).mockResolvedValue('feature');
      jest.mocked(fetchOrigin).mockResolvedValue();
      jest.mocked(hasUnpulledCommits).mockResolvedValue(behind);
      jest.mocked(pullBranchRebase).mockResolvedValue();
      jest.mocked(pushBranch).mockResolvedValue();
      await handler(
        {},
        {
          projectId: 'workspace-a',
          worktreeId: 'wt-1',
          repoIds: ['__single_repo__'],
          establishUpstream: true,
          expectedHeadBranch: 'feature',
          pullFirst: true,
        },
      );
      expect(fetchOrigin).toHaveBeenCalledWith('/workspace/wt', {
        signal: ANY_SIGNAL,
      });
      expect(pullBranchRebase).toHaveBeenCalledTimes(behind ? 1 : 0);
      if (behind)
        expect(pullBranchRebase).toHaveBeenCalledWith(
          '/workspace/wt',
          'feature',
        );
      expect(pushBranch).toHaveBeenCalledWith('/workspace/wt');
      expect(commitWithMessage).not.toHaveBeenCalled();
    },
  );

  // fetchOrigin swallows every error unless the caller passes a signal.
  it('fails the repo when the pull-first fetch fails instead of pushing over stale refs', async () => {
    jest.mocked(isMultiRepoWorkspace).mockReturnValue(false);
    jest.mocked(resolveWorktreeCwd).mockReturnValue('/workspace/wt');
    jest.mocked(getRemoteUrl).mockResolvedValue('git@github.com:a/b.git');
    jest.mocked(getCurrentBranch).mockResolvedValue('feature');
    jest
      .mocked(fetchOrigin)
      .mockImplementation((_repoPath, options) =>
        options?.signal === undefined
          ? Promise.resolve()
          : Promise.reject(new Error('fatal: unable to access origin')),
      );
    jest.mocked(hasUnpulledCommits).mockResolvedValue(false);
    jest.mocked(pullBranchRebase).mockResolvedValue();
    jest.mocked(pushBranch).mockResolvedValue();

    const result = await handler(
      {},
      {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        repoIds: ['__single_repo__'],
        establishUpstream: true,
        expectedHeadBranch: 'feature',
        pullFirst: true,
      },
    );

    expect(result.failedRepos).toEqual([
      expect.objectContaining({ error: 'fatal: unable to access origin' }),
    ]);
    const options = jest.mocked(fetchOrigin).mock.calls[0]?.[1];
    expect(options?.signal?.aborted).toBe(false);
    expect(pullBranchRebase).not.toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
  });

  it('continues only the selected push without tracking or a new commit', async () => {
    jest.clearAllMocks();
    jest.mocked(isMultiRepoWorkspace).mockReturnValue(true);
    jest.mocked(resolveWorktreeCwd).mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ] as any);
    jest.mocked(getRemoteUrl).mockResolvedValue('https://github.com/a/b');
    jest.mocked(hasRemoteTrackingBranch).mockResolvedValue(false);
    jest.mocked(getCurrentBranch).mockResolvedValue('feature');
    jest.mocked(pushBranch).mockResolvedValue();
    await handler(
      {},
      {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        repoIds: ['repo-b'],
        establishUpstream: true,
        expectedHeadBranch: 'feature',
      },
    );
    expect(pushBranch).toHaveBeenCalledTimes(1);
    expect(pushBranch).toHaveBeenCalledWith('/workspace/wt/repos/repo-b');
    expect(commitWithMessage).not.toHaveBeenCalled();
  });
});
