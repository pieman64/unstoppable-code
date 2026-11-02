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

jest.mock('../lib/github-repo-listing', () => ({
  listUserRepos: jest.fn(),
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

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { enqueueKnownPrFastRefresh } from '../lib/github-poller';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from '../ipc/register';

const mockedEnqueueKnownPrFastRefresh = jest.mocked(enqueueKnownPrFastRefresh);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedValidateId = jest.mocked(validateId);

type HandlerFn = (
  event: any,
  request: { projectId: string; worktreeId: string },
) => Promise<boolean>;

function getKnownPrFastRefreshHandler(): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (entry: any[]) => entry[0] === IPC_CHANNELS.githubRequestKnownPrFastRefresh,
  );
  if (!call) {
    throw new Error('githubRequestKnownPrFastRefresh handler not registered');
  }
  return call[1] as unknown as HandlerFn;
}

describe('githubRequestKnownPrFastRefresh handler', () => {
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
    handler = getKnownPrFastRefreshHandler();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedEnqueueKnownPrFastRefresh.mockResolvedValue(true);
  });

  it('validates ids and delegates to the known PR fast refresh queue', async () => {
    await expect(
      handler({} as any, { projectId: 'project-a', worktreeId: 'wt-1' }),
    ).resolves.toBe(true);

    expect(mockedValidateId).toHaveBeenCalledWith('project-a', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
    expect(mockedEnqueueKnownPrFastRefresh).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
    );
  });

  it('does not enqueue a refresh when id validation fails', async () => {
    mockedValidateId.mockImplementation((value, fieldName) => {
      if (fieldName === 'projectId') {
        throw new Error(`Invalid ${fieldName}: ${String(value)}`);
      }
    });

    await expect(
      handler({} as any, { projectId: 'bad id', worktreeId: 'wt-1' }),
    ).rejects.toThrow('Invalid projectId: bad id');

    expect(mockedEnqueueKnownPrFastRefresh).not.toHaveBeenCalled();
  });
});
