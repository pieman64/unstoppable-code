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

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  isGitRepo: jest.fn(() => Promise.resolve(false)),
  getCurrentBranch: jest.fn(),
  getDiffStats: jest.fn(),
  getFullDiff: jest.fn(),
  getCommitLog: jest.fn(),
  getRemoteUrl: jest.fn(),
  pushBranch: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
  hasAutostashEntry: jest.fn(),
  hasUnmergedPaths: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  hasCommitsAhead: jest.fn(),
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

jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

import { readdir } from 'node:fs/promises';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { validateId } from '../lib/validation';
import {
  getCurrentBranch,
  getRemoteUrl,
  hasCommitsAhead,
  hasUncommittedChanges,
  mergeBranchIntoLocalBase,
} from '../lib/git';
import { requestRefresh } from '../lib/github-poller';
import { resolveEffectiveBaseBranchForRepo } from '../lib/worktree-base-branches';
import { registerIpcHandler } from '../ipc/register';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import type {
  MergeLocalBranchesRequest,
  MergeLocalBranchesResponse,
} from '@canopy/desktop-shared/types/github';

const mockedReaddir = jest.mocked(readdir);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedValidateId = jest.mocked(validateId);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedHasCommitsAhead = jest.mocked(hasCommitsAhead);
const mockedHasUncommittedChanges = jest.mocked(hasUncommittedChanges);
const mockedMergeBranchIntoLocalBase = jest.mocked(mergeBranchIntoLocalBase);
const mockedRequestRefresh = jest.mocked(requestRefresh);
const mockedResolveEffectiveBaseBranchForRepo = jest.mocked(
  resolveEffectiveBaseBranchForRepo,
);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

type HandlerFn = (
  event: any,
  request: MergeLocalBranchesRequest,
) => Promise<MergeLocalBranchesResponse>;

function getMergeHandler(): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (entry: any[]) => entry[0] === IPC_CHANNELS.githubMergeLocalBranches,
  );
  if (!call) {
    throw new Error('githubMergeLocalBranches handler not registered');
  }
  return call[1] as unknown as HandlerFn;
}

function makeDirent(name: string): any {
  return { name, isDirectory: (): boolean => true };
}

describe('githubMergeLocalBranches handler', () => {
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
    handler = getMergeHandler();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedValidateId.mockImplementation((): void => undefined);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    } as any);
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
      makeDirent('repo-c'),
      makeDirent('repo-d'),
    ] as any);
  });

  it('merges only local-only repos with committed changes and skips the rest', async () => {
    mockedGetRemoteUrl
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('git@github.com:org/repo-b.git')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockedHasUncommittedChanges
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockedGetCurrentBranch
      .mockResolvedValueOnce('feature/repo-a')
      .mockResolvedValueOnce('feature/repo-d');
    mockedResolveEffectiveBaseBranchForRepo
      .mockResolvedValueOnce({
        branch: 'main',
        existsLocally: true,
        existsInRemote: false,
      })
      .mockResolvedValueOnce({
        branch: null,
        existsLocally: false,
        existsInRemote: false,
      });
    mockedHasCommitsAhead.mockResolvedValueOnce(true);
    mockedMergeBranchIntoLocalBase.mockResolvedValueOnce('merge123');

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        branchName: 'feature/repo-a',
        baseBranch: 'main',
        mergeCommitHash: 'merge123',
        status: 'success',
      },
    ]);
    expect(result.skippedRepos).toEqual([
      {
        repoId: 'repo-b',
        repoName: 'repo-b',
        reason: 'has_remote_origin',
      },
      {
        repoId: 'repo-c',
        repoName: 'repo-c',
        reason: 'uncommitted_changes',
      },
      {
        repoId: 'repo-d',
        repoName: 'repo-d',
        reason: 'missing_base_branch',
      },
    ]);
    expect(result.failedRepos).toEqual([]);
    expect(mockedMergeBranchIntoLocalBase).toHaveBeenCalledWith(
      '/workspace/wt/repos/repo-a',
      'feature/repo-a',
      'main',
    );
    expect(mockedRequestRefresh).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
      true,
    );
  });

  it('accepts the project root repo id for local-only merges', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/workspace/source',
      repos: [],
    } as any);
    mockedReaddir.mockResolvedValue([]);
    mockedGetRemoteUrl.mockResolvedValue(null);
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature/root');
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: false,
    });
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedMergeBranchIntoLocalBase.mockResolvedValue('merge123');
    mockedValidateId.mockImplementation((value): void => {
      if (value === WORKSPACE_ROOT_REPO_ID) {
        throw new Error('project root repo id should bypass validateId');
      }
    });

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      repoIds: [WORKSPACE_ROOT_REPO_ID],
    });

    expect(result.repos).toEqual([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: WORKSPACE_ROOT_REPO_NAME,
        branchName: 'feature/root',
        baseBranch: 'main',
        mergeCommitHash: 'merge123',
        status: 'success',
      },
    ]);
    expect(result.skippedRepos).toEqual([]);
    expect(result.failedRepos).toEqual([]);
    expect(mockedMergeBranchIntoLocalBase).toHaveBeenCalledWith(
      '/workspace/wt',
      'feature/root',
      'main',
    );
    expect(mockedRequestRefresh).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
      true,
    );
  });

  it('fails detached HEAD sources instead of reporting a successful merge', async () => {
    mockedReaddir.mockResolvedValue([makeDirent('repo-a')] as any);
    mockedGetRemoteUrl.mockResolvedValue(null);
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedGetCurrentBranch.mockResolvedValue('HEAD');

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([]);
    expect(result.skippedRepos).toEqual([]);
    expect(result.failedRepos).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        branchName: 'HEAD',
        error:
          'Cannot merge from detached HEAD. Check out a named branch first.',
        status: 'failed',
      },
    ]);
    expect(mockedResolveEffectiveBaseBranchForRepo).not.toHaveBeenCalled();
    expect(mockedHasCommitsAhead).not.toHaveBeenCalled();
    expect(mockedMergeBranchIntoLocalBase).not.toHaveBeenCalled();
  });

  it('surfaces merge failures as failed repos', async () => {
    mockedReaddir.mockResolvedValue([makeDirent('repo-a')] as any);
    mockedGetRemoteUrl.mockResolvedValue(null);
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature/repo-a');
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: false,
    });
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedMergeBranchIntoLocalBase.mockRejectedValue(
      new Error('merge conflict'),
    );

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([]);
    expect(result.skippedRepos).toEqual([]);
    expect(result.failedRepos).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        branchName: 'feature/repo-a',
        baseBranch: 'main',
        error: 'merge conflict',
        status: 'failed',
      },
    ]);
  });

  it('throws when only remote-backed repos are selected', async () => {
    mockedReaddir.mockResolvedValue([makeDirent('repo-a')] as any);
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:org/repo-a.git');

    await expect(
      handler({} as any, {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('No local-only repos had committed changes to merge');

    expect(mockedMergeBranchIntoLocalBase).not.toHaveBeenCalled();
  });
});
