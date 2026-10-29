/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  fetchOrigin: jest.fn(() => Promise.resolve()),
  getCurrentBranch: jest.fn(),
  getDiffStats: jest.fn(),
  getFullDiff: jest.fn(),
  getCommitLog: jest.fn(),
  getRemoteUrl: jest.fn(),
  getPushRemoteUrlStrict: jest.fn(),
  pushBranch: jest.fn(),
  pullBranchRebase: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  hasCommitsAhead: jest.fn(),
  hasRemoteTrackingBranch: jest.fn(),
  hasUnpulledCommits: jest.fn(),
  hasUnpushedCommits: jest.fn(),
  stageAllChanges: jest.fn(),
  commitWithMessage: jest.fn(),
  getUncommittedDiff: jest.fn(),
  isRebaseInProgress: jest.fn(),
}));

jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(),
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

jest.mock('../lib/commit-generation-model-candidates', () => ({
  resolveCommitGenerationModelCandidates: jest.fn(),
}));

jest.mock('../lib/worktree-precommit-failure-hook', () => ({
  triggerWorktreePrecommitFailureHook: jest.fn(() => Promise.resolve()),
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
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { validateId } from '../lib/validation';
import { readdir } from 'node:fs/promises';
import {
  fetchOrigin,
  getCurrentBranch,
  getRemoteUrl,
  getPushRemoteUrlStrict,
  pushBranch,
  pullBranchRebase,
  hasUncommittedChanges,
  hasRemoteTrackingBranch,
  hasUnpulledCommits,
  hasUnpushedCommits,
  stageAllChanges,
  commitWithMessage,
  getUncommittedDiff,
  isRebaseInProgress,
} from '../lib/git';
import { generateCommitMessage } from '../lib/commit-message-generator';
import { resolveCommitGenerationModelCandidates } from '../lib/commit-generation-model-candidates';
import { launchRebaseResolutionChat } from '../lib/rebase-resolution-chat';
import { triggerWorktreePrecommitFailureHook } from '../lib/worktree-precommit-failure-hook';
import { readPreferencesFile } from '../ipc/preferences';
import { registerIpcHandler } from '../ipc/register';
import {
  GitActionCancelledError,
  requestGitActionCancellation,
} from '../ipc/git-action-cancellation';
import type { IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import type {
  CommitAndPushRequest,
  CommitAndPushResponse,
  GenerateCommitMessagesRequest,
  GenerateCommitMessagesResponse,
} from '@canopy/desktop-shared/types/github';

const mockedReaddir = jest.mocked(readdir);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedValidateId = jest.mocked(validateId);
const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedHasRemoteTrackingBranch = jest.mocked(hasRemoteTrackingBranch);
const mockedHasUncommittedChanges = jest.mocked(hasUncommittedChanges);
const mockedHasUnpulledCommits = jest.mocked(hasUnpulledCommits);
const mockedHasUnpushedCommits = jest.mocked(hasUnpushedCommits);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetUncommittedDiff = jest.mocked(getUncommittedDiff);
const mockedIsRebaseInProgress = jest.mocked(isRebaseInProgress);
const mockedStageAllChanges = jest.mocked(stageAllChanges);
const mockedCommitWithMessage = jest.mocked(commitWithMessage);
const mockedPushBranch = jest.mocked(pushBranch);
const mockedPullBranchRebase = jest.mocked(pullBranchRebase);
const mockedGenerateCommitMessage = jest.mocked(generateCommitMessage);
const mockedResolveCommitGenerationModelCandidates = jest.mocked(
  resolveCommitGenerationModelCandidates,
);
const COMMIT_MODEL_PLAN = {
  model: 'claude-sonnet-4-6',
  fallbackModels: ['gpt-5.5'],
};
const mockedLaunchRebaseResolutionChat = jest.mocked(
  launchRebaseResolutionChat,
);
const mockedTriggerWorktreePrecommitFailureHook = jest.mocked(
  triggerWorktreePrecommitFailureHook,
);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

type HandlerFn = (
  event: any,
  request: CommitAndPushRequest,
) => Promise<CommitAndPushResponse>;

type GenerateMessagesHandlerFn = (
  request: GenerateCommitMessagesRequest,
) => Promise<GenerateCommitMessagesResponse>;

type RegisteredGenerateMessagesHandlerFn = (
  event: IpcMainInvokeEvent,
  request: GenerateCommitMessagesRequest,
) => Promise<GenerateCommitMessagesResponse>;

function isGenerateMessagesHandler(
  value: unknown,
): value is RegisteredGenerateMessagesHandlerFn {
  return typeof value === 'function';
}

function getCommitAndPushHandler(): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (entry: any[]) => entry[0] === IPC_CHANNELS.githubCommitAndPush,
  );
  if (!call) {
    throw new Error('githubCommitAndPush handler not registered');
  }
  return call[1] as unknown as HandlerFn;
}

function getGenerateMessagesHandler(): GenerateMessagesHandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (entry) => entry[0] === IPC_CHANNELS.githubGenerateCommitMessages,
  );
  if (!call) {
    throw new Error('githubGenerateCommitMessages handler not registered');
  }
  const registeredHandler: unknown = call[1];
  if (!isGenerateMessagesHandler(registeredHandler)) {
    throw new Error('githubGenerateCommitMessages handler has an invalid type');
  }
  return (request): Promise<GenerateCommitMessagesResponse> =>
    registeredHandler(Object.create(null), request);
}

describe('githubCommitAndPush handler', () => {
  let handler: HandlerFn;
  let generateMessagesHandler: GenerateMessagesHandlerFn;

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
    handler = getCommitAndPushHandler();
    generateMessagesHandler = getGenerateMessagesHandler();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedValidateId.mockImplementation((): void => undefined);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    } as any);
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:org/single-repo.git');
    mockedHasRemoteTrackingBranch.mockResolvedValue(true);
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasUnpulledCommits.mockResolvedValue(false);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedGetUncommittedDiff.mockResolvedValue('working tree diff');
    mockedIsRebaseInProgress.mockResolvedValue(false);
    mockedStageAllChanges.mockResolvedValue();
    mockedCommitWithMessage.mockResolvedValue('abc123');
    mockedPushBranch.mockResolvedValue();
    mockedGenerateCommitMessage.mockResolvedValue('feat: generated');
    mockedResolveCommitGenerationModelCandidates.mockResolvedValue(
      COMMIT_MODEL_PLAN,
    );
    mockedTriggerWorktreePrecommitFailureHook.mockResolvedValue();
    mockedReadPreferencesFile.mockResolvedValue({
      commitGenerationModel: 'claude-sonnet-4-6',
      commitGenerationThinkingLevel: 'high',
      commitInstructions: '',
      commitInstructionMode: 'append',
    } as any);
    mockedLaunchRebaseResolutionChat.mockResolvedValue({ chatId: 'chat-1' });
  });

  it('generates commit-only messages without requiring remote tracking', async () => {
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);

    const result = await generateMessagesHandler({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      commitOnly: true,
    });

    expect(result.repos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        message: 'feat: generated',
      },
    ]);
    expect(result.skippedRepos).toEqual([]);
  });

  it('still requires remote tracking for commit-and-push message generation', async () => {
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);

    const result = await generateMessagesHandler({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([]);
    expect(result.skippedRepos).toEqual([
      { repoName: 'single-repo', reason: 'no_remote_tracking' },
    ]);
  });

  it('fails instead of auto-generating when reviewed messages are required but missing', async () => {
    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
      requireReviewedMessages: true,
      messages: [],
    });

    expect(result.repos).toEqual([]);
    expect(result.failedRepos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        error:
          'Missing reviewed commit message for "single-repo". Regenerate the preview before committing.',
        status: 'failed',
      },
    ]);
    expect(mockedGenerateCommitMessage).not.toHaveBeenCalled();
    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/workspace/single-repo');
  });

  it('commits successfully when a reviewed message is provided', async () => {
    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
      requireReviewedMessages: true,
      messages: [
        {
          repoName: 'single-repo',
          message: 'feat: reviewed commit',
        },
      ],
    });

    expect(result.repos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        commitHash: 'abc123',
        status: 'success',
        operation: 'commit_and_push',
      },
    ]);
    expect(result.failedRepos).toEqual([]);
    expect(mockedGenerateCommitMessage).not.toHaveBeenCalled();
    expect(mockedStageAllChanges).toHaveBeenCalledWith(
      '/workspace/single-repo',
    );
    expect(mockedCommitWithMessage).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'feat: reviewed commit',
    );
  });

  it('pushes existing unpushed commits when there are no uncommitted changes', async () => {
    mockedHasUncommittedChanges.mockResolvedValue(false);
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
        operation: 'push',
      },
    ]);
    expect(result.failedRepos).toEqual([]);
    expect(result.skippedRepos).toEqual([]);
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/workspace/single-repo');
    expect(mockedPushBranch).toHaveBeenCalledWith('/workspace/single-repo');
    expect(mockedGenerateCommitMessage).not.toHaveBeenCalled();
    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
  });

  it('returns a structured push auth failure after committing only once', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    jest
      .mocked(getPushRemoteUrlStrict)
      .mockResolvedValue('https://github.com/a/b');
    mockedHasRemoteTrackingBranch.mockResolvedValue(true);
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedCommitWithMessage.mockResolvedValue('commit-1');
    mockedPushBranch.mockRejectedValueOnce(new Error('Authentication failed'));
    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
      messages: [{ repoName: 'wt', message: 'Commit' }],
    });
    expect(result.failedRepos).toEqual([
      expect.objectContaining({
        error: 'Authentication failed',
        failureCode: 'github_not_authenticated',
      }),
    ]);
    expect(mockedCommitWithMessage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'classifies prerequisite HTTPS fetch auth and reports commit readiness, changes: %s',
    async (hasChanges) => {
      mockedGetRemoteUrl.mockResolvedValue('https://github.com/acme/app.git');
      mockedHasUncommittedChanges.mockResolvedValue(hasChanges);
      mockedFetchOrigin.mockRejectedValueOnce(
        new Error('Authentication failed'),
      );
      const result = await handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });
      expect(result.failedRepos).toEqual([
        expect.objectContaining({
          failureCode: 'github_not_authenticated',
          commitPrepared: !hasChanges,
        }),
      ]);
      expect(mockedStageAllChanges).not.toHaveBeenCalled();
      expect(mockedCommitWithMessage).not.toHaveBeenCalled();
      expect(mockedPushBranch).not.toHaveBeenCalled();
    },
  );

  it('refuses an unprepared continuation after the original branch changes', async () => {
    mockedGetCurrentBranch.mockResolvedValue('different-branch');
    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
      expectedHeadBranch: 'original-branch',
    });
    expect(result.failedRepos[0]?.error).toContain('branch changed');
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });

  it('pulls with rebase before pushing existing commits when pullFirst is requested', async () => {
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasUnpulledCommits.mockResolvedValue(true);
    mockedHasUnpushedCommits.mockResolvedValue(true);

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
      pullFirst: true,
    });

    expect(result.repos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        status: 'success',
        operation: 'push',
      },
    ]);
    expect(result.failedRepos).toEqual([]);
    expect(result.skippedRepos).toEqual([]);
    expect(mockedPullBranchRebase).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'feature-branch',
    );
    expect(mockedPushBranch).toHaveBeenCalledWith('/workspace/single-repo');
  });

  it.each([false, true])(
    'does not start agent resolution after cancellation during a failed pre-push pull (has changes: %s)',
    async (hasChanges) => {
      const request: CommitAndPushRequest = {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        operationId: 'operation-1',
        pullFirst: true,
      };
      const pullError = Object.assign(new Error('pull failed'), {
        stderr: 'CONFLICT (content): Merge conflict',
      });
      mockedHasUncommittedChanges.mockResolvedValue(hasChanges);
      mockedHasUnpulledCommits.mockResolvedValue(true);
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
      expect(mockedPushBranch).not.toHaveBeenCalled();
      expect(mockedStageAllChanges).not.toHaveBeenCalled();
    },
  );

  it('passes the commit model fallback chain and runs each git step once', async () => {
    // The generator exhausted every candidate and returned the branch title.
    mockedGenerateCommitMessage.mockResolvedValue('Feature branch');

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    const candidateInput =
      mockedResolveCommitGenerationModelCandidates.mock.calls[0]?.[0];
    expect(candidateInput?.primaryModel).toBe('claude-sonnet-4-6');
    expect(candidateInput?.workspaceId).toBe('project-a');
    expect(candidateInput?.preferences.commitGenerationModel).toBe(
      'claude-sonnet-4-6',
    );
    expect(mockedGenerateCommitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        fallbackModels: ['gpt-5.5'],
      }),
    );
    expect(result.failedRepos).toEqual([]);
    expect(result.repos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        commitHash: 'abc123',
        status: 'success',
        operation: 'commit_and_push',
      },
    ]);
    expect(mockedStageAllChanges).toHaveBeenCalledTimes(1);
    expect(mockedCommitWithMessage).toHaveBeenCalledTimes(1);
    expect(mockedCommitWithMessage).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'Feature branch',
    );
    expect(mockedPushBranch).toHaveBeenCalledTimes(1);
  });

  it('runs no git step when commit generation is cancelled', async () => {
    mockedGenerateCommitMessage.mockRejectedValue(
      new GitActionCancelledError(),
    );

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.cancelled).toBe(true);
    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });

  it('passes the same fallback chain to every repo in a multi-repo commit', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      { name: 'repo-a', isDirectory: (): boolean => true },
      { name: 'repo-b', isDirectory: (): boolean => true },
    ] as any);

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.failedRepos).toEqual([]);
    expect(mockedGenerateCommitMessage).toHaveBeenCalledTimes(2);
    for (const call of mockedGenerateCommitMessage.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          model: 'claude-sonnet-4-6',
          fallbackModels: ['gpt-5.5'],
        }),
      );
    }
    expect(mockedStageAllChanges).toHaveBeenCalledTimes(2);
    expect(mockedCommitWithMessage).toHaveBeenCalledTimes(2);
    expect(mockedPushBranch).toHaveBeenCalledTimes(2);
  });

  it('passes the fallback chain to the commit message preview', async () => {
    const result = await generateMessagesHandler({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(mockedGenerateCommitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        fallbackModels: ['gpt-5.5'],
      }),
    );
    expect(result.repos[0]?.message).toBe('feat: generated');
    expect(result.failedRepos).toEqual([]);
  });

  it('commits local-only repos without fetch, tracking checks, or push', async () => {
    mockedGetRemoteUrl.mockResolvedValue(null);

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        commitHash: 'abc123',
        status: 'success',
        operation: 'commit',
      },
    ]);
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedHasRemoteTrackingBranch).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });

  it('fires the precommit failure hook when git commit fails', async () => {
    const commitError = Object.assign(new Error('git commit failed'), {
      stderr: 'pre-commit hook failed\n',
    });
    mockedCommitWithMessage.mockRejectedValueOnce(commitError);

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([]);
    expect(result.failedRepos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        error: 'git commit failed',
        status: 'failed',
      },
    ]);
    expect(mockedTriggerWorktreePrecommitFailureHook).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        repo: {
          repoPath: '/workspace/single-repo',
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoName: 'single-repo',
        },
        error: commitError,
        commitMessage: 'feat: generated',
      }),
    );
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });

  it('uses commit-only flow for selected repoIds', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      { name: 'repo-a', isDirectory: (): boolean => true },
      { name: 'repo-b', isDirectory: (): boolean => true },
    ] as any);
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:org/repo.git');

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      repoIds: ['repo-b'],
      commitOnly: true,
    });

    expect(result.repos).toEqual([
      {
        repoId: 'repo-b',
        repoName: 'repo-b',
        commitHash: 'abc123',
        status: 'success',
        operation: 'commit',
      },
    ]);
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedHasRemoteTrackingBranch).not.toHaveBeenCalled();
    expect(mockedStageAllChanges).toHaveBeenCalledTimes(1);
    expect(mockedStageAllChanges).toHaveBeenCalledWith(
      '/workspace/wt/repos/repo-b',
    );
  });

  it('accepts the project root repo id for local-only commits', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/workspace/source',
      repos: [],
    } as any);
    mockedReaddir.mockResolvedValue([] as any);
    mockedGetRemoteUrl.mockResolvedValue(null);
    mockedValidateId.mockImplementation((value: string): void => {
      if (value === WORKSPACE_ROOT_REPO_ID) {
        throw new Error('project root repo id should bypass validateId');
      }
    });

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      repoIds: [WORKSPACE_ROOT_REPO_ID],
      commitOnly: true,
    });

    expect(result.repos).toEqual([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: WORKSPACE_ROOT_REPO_NAME,
        commitHash: 'abc123',
        status: 'success',
        operation: 'commit',
      },
    ]);
    expect(mockedStageAllChanges).toHaveBeenCalledWith('/workspace/wt');
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });
});

describe('helper model preferences are never lane-substituted', () => {
  const sources: ReadonlyArray<readonly [string, string]> = [
    [
      'lib/worktree-chat-turn.ts',
      'apps/desktop-app/src/main/lib/worktree-chat-turn.ts',
    ],
    ['lib/branch-namer.ts', 'apps/desktop-app/src/main/lib/branch-namer.ts'],
    ['ipc/github.ts', 'apps/desktop-app/src/main/ipc/github.ts'],
    [
      'lib/github-pr-splitter.ts',
      'apps/desktop-app/src/main/lib/github-pr-splitter.ts',
    ],
    [
      'pipelines/pipeline-advisor.ts',
      'apps/desktop-app/src/main/pipelines/pipeline-advisor.ts',
    ],
    [
      'app-advisor/chat-service.ts',
      'apps/desktop-app/src/main/app-advisor/chat-service.ts',
    ],
    [
      'automations/service.ts',
      'apps/desktop-app/src/main/automations/service.ts',
    ],
    [
      'memory/local/consolidation-scheduler.ts',
      'apps/desktop-app/src/main/memory/local/consolidation-scheduler.ts',
    ],
    [
      'memory/local/manual-consolidation-trigger.ts',
      'apps/desktop-app/src/main/memory/local/manual-consolidation-trigger.ts',
    ],
  ];

  it.each(sources)(
    '%s never invokes the feature-preference lane resolver',
    (_label, file) => {
      const source = readFileSync(
        path.join(__dirname, '../../../../..', file),
        'utf8',
      );
      expect(source).not.toContain('resolveLaneAwarePreferenceModel');
    },
  );
});
