/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn(),
  getDiffStats: jest.fn(),
  getFullDiff: jest.fn(),
  getCommitLog: jest.fn(),
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

import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { updatePrBaseBranchForRepo } from '../lib/github-pr';
import { enqueueFastRefresh } from '../lib/github-poller';
import { registerIpcHandler } from '../ipc/register';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  UpdatePrBaseBranchRequest,
  UpdatePrBaseBranchResponse,
} from '@canopy/desktop-shared/types/github';

const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedUpdatePrBaseBranchForRepo = jest.mocked(updatePrBaseBranchForRepo);
const mockedEnqueueFastRefresh = jest.mocked(enqueueFastRefresh);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

type HandlerFn = (
  event: any,
  request: UpdatePrBaseBranchRequest,
) => Promise<UpdatePrBaseBranchResponse>;

function getUpdatePrBaseBranchHandler(): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (entry: any[]) => entry[0] === IPC_CHANNELS.githubUpdatePrBaseBranch,
  );
  if (!call) {
    throw new Error('githubUpdatePrBaseBranch handler not registered');
  }
  return call[1] as unknown as HandlerFn;
}

describe('githubUpdatePrBaseBranch handler', () => {
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
    handler = getUpdatePrBaseBranchHandler();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedUpdatePrBaseBranchForRepo.mockResolvedValue({
      prUrl: 'https://github.com/example-org/example-repo/pull/355',
    });
  });

  it('rejects non-positive PR numbers', async () => {
    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        prNumber: 0,
        newBaseBranch: 'main',
      }),
    ).rejects.toThrow('Invalid prNumber: must be a positive integer');

    expect(mockedUpdatePrBaseBranchForRepo).not.toHaveBeenCalled();
  });

  it('rejects empty and HEAD base branches', async () => {
    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        prNumber: 355,
        newBaseBranch: '   ',
      }),
    ).rejects.toThrow('Invalid newBaseBranch: must not be empty');

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        prNumber: 355,
        newBaseBranch: 'HEAD',
      }),
    ).rejects.toThrow('Invalid newBaseBranch: "HEAD" is not allowed');

    expect(mockedUpdatePrBaseBranchForRepo).not.toHaveBeenCalled();
  });

  it('trims the base branch before updating the PR', async () => {
    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        prNumber: 355,
        newBaseBranch: '  release/2026-04  ',
      }),
    ).resolves.toEqual({
      success: true,
      prUrl: 'https://github.com/example-org/example-repo/pull/355',
    });

    expect(mockedUpdatePrBaseBranchForRepo).toHaveBeenCalledWith(
      '/workspace/wt',
      355,
      'release/2026-04',
    );
    expect(mockedEnqueueFastRefresh).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
      false,
    );
  });
});
