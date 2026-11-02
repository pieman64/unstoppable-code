import { GitHubBrokerError } from '../lib/github-broker/errors';
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
const mockRecordCreatedPullRequest = jest.fn();
const mockWindowSend = jest.fn();

jest.mock('../lib/desktop-telemetry', () => ({
  recordGitCommitTelemetry: jest.fn(),
  recordPullRequestOpenedTelemetry: jest.fn(),
  recordPullRequestMergedTelemetry: jest.fn(),
}));
import {
  recordGitCommitTelemetry,
  recordPullRequestOpenedTelemetry,
} from '../lib/desktop-telemetry';
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
  hasUncommittedChanges: jest.fn(),
  hasCommitsAhead: jest.fn(),
  readBranchPublication: jest.fn(),
  hasRemoteTrackingBranch: jest.fn(),
  hasUnpulledCommits: jest.fn(),
  hasUnpushedCommits: jest.fn(),
  stageAllChanges: jest.fn(),
  commitWithMessage: jest.fn(),
  getUncommittedDiff: jest.fn(),
}));

jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(),
  resolveRepoDefaultBranch: jest.fn(),
}));

jest.mock('../lib/github-pr', () => ({
  createPrForRepo: jest.fn(),
  fetchRepoPrTrackingData: jest.fn(),
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

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordCreatedPullRequest: mockRecordCreatedPullRequest,
  })),
}));

import { readdir } from 'node:fs/promises';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import {
  getCurrentBranch,
  getDiffStats,
  getFullDiff,
  getCommitLog,
  fetchOrigin,
  getAheadBehindCounts,
  getRemoteUrl,
  pushBranch,
  hasUncommittedChanges,
  hasCommitsAhead,
  readBranchPublication,
  hasRemoteTrackingBranch,
  hasUnpulledCommits,
  stageAllChanges,
  commitWithMessage,
  getUncommittedDiff,
} from '../lib/git';
import { createPrForRepo, fetchRepoPrTrackingData } from '../lib/github-pr';
import { generatePrContent } from '../lib/github-pr-generator';
import { generateCommitMessage } from '../lib/commit-message-generator';
import { resolveCommitGenerationModelCandidates } from '../lib/commit-generation-model-candidates';
import {
  refreshNow,
  requestRefresh,
  enqueueFastRefresh,
} from '../lib/github-poller';
import {
  resolveEffectiveBaseBranchForRepo,
  resolveRepoDefaultBranch,
} from '../lib/worktree-base-branches';
import { validateId } from '../lib/validation';
import { readPreferencesFile } from '../ipc/preferences';
import { registerIpcHandler } from '../ipc/register';
import {
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
} from '@canopy/desktop-shared/types';
import type {
  CancelGitActionRequest,
  CancelGitActionResponse,
  CreatePrRequest,
  CreatePrResponse,
} from '@canopy/desktop-shared/types/github';

const mockedReaddir = jest.mocked(readdir);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedResolveRepoDefaultBranch = jest.mocked(resolveRepoDefaultBranch);
const mockedGetDiffStats = jest.mocked(getDiffStats);
const mockedHasUncommittedChanges = jest.mocked(hasUncommittedChanges);
const mockedHasCommitsAhead = jest.mocked(hasCommitsAhead);
const mockedReadBranchPublication = jest.mocked(readBranchPublication);
const mockedHasRemoteTrackingBranch = jest.mocked(hasRemoteTrackingBranch);
const mockedHasUnpulledCommits = jest.mocked(hasUnpulledCommits);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetFullDiff = jest.mocked(getFullDiff);
const mockedGetCommitLog = jest.mocked(getCommitLog);
const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedGetAheadBehindCounts = jest.mocked(getAheadBehindCounts);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedPushBranch = jest.mocked(pushBranch);
const mockedStageAllChanges = jest.mocked(stageAllChanges);
const mockedCommitWithMessage = jest.mocked(commitWithMessage);
const mockedGetUncommittedDiff = jest.mocked(getUncommittedDiff);
const mockedCreatePrForRepo = jest.mocked(createPrForRepo);
const mockedFetchRepoPrTrackingData = jest.mocked(fetchRepoPrTrackingData);
const mockedGeneratePrContent = jest.mocked(generatePrContent);
const mockedGenerateCommitMessage = jest.mocked(generateCommitMessage);
const mockedResolveCommitGenerationModelCandidates = jest.mocked(
  resolveCommitGenerationModelCandidates,
);
const mockedRefreshNow = jest.mocked(refreshNow);
const mockedRequestRefresh = jest.mocked(requestRefresh);
const mockedEnqueueFastRefresh = jest.mocked(enqueueFastRefresh);
const mockedResolveEffectiveBaseBranchForRepo = jest.mocked(
  resolveEffectiveBaseBranchForRepo,
);
const mockedValidateId = jest.mocked(validateId);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

initAgentModels([]);
initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });

type HandlerFn = (
  event: any,
  request: CreatePrRequest,
) => Promise<CreatePrResponse>;

function getCreatePrHandler(): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (c: any[]) => c[0] === IPC_CHANNELS.githubCreatePr,
  );
  if (!call) throw new Error('githubCreatePr handler not registered');
  return call[1] as unknown as HandlerFn;
}

type CancelHandlerFn = (
  event: any,
  request: CancelGitActionRequest,
) => CancelGitActionResponse;

function getCancelGitActionHandler(): CancelHandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    (c: any[]) => c[0] === IPC_CHANNELS.githubCancelGitAction,
  );
  if (!call) throw new Error('githubCancelGitAction handler not registered');
  return call[1] as unknown as CancelHandlerFn;
}

function makeDirent(name: string): any {
  return { name, isDirectory: (): boolean => true };
}

describe('githubCreatePr handler', () => {
  let handler: HandlerFn;
  let cancelHandler: CancelHandlerFn;

  beforeAll(async () => {
    const { getGitHubClient } = await import('../lib/github-client');
    jest.mocked(getGitHubClient).mockReturnValue({} as any);

    const { registerGitHubHandlers } = await import('../ipc/github');
    const mockWindow = {
      isDestroyed: (): boolean => false,
      webContents: {
        send: mockWindowSend,
        isDestroyed: (): boolean => false,
        isCrashed: (): boolean => false,
        mainFrame: { isDestroyed: (): boolean => false, detached: false },
      },
    };
    registerGitHubHandlers(() => mockWindow as any, {
      // These tests reach no dispatched pull request call: no workspace
      // records their checkouts, so the writes keep their direct path.
      dispatcher: {} as never,
      resolveCaller: () => ({
        principalId: 'local-desktop-user',
        clientInstanceId: 'electron-web-contents:1',
        authorityId: 'local-desktop',
        interfaceKind: 'desktop',
        grants: [],
      }),
    });
    handler = getCreatePrHandler();
    cancelHandler = getCancelGitActionHandler();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadPreferencesFile.mockResolvedValue({
      prGenerationModel: 'claude-sonnet-4-6',
      prGenerationThinkingLevel: 'high',
      prInstructions: '',
      prInstructionMode: 'append',
      commitGenerationModel: 'claude-sonnet-4-6',
      commitGenerationThinkingLevel: 'high',
      commitInstructions: '',
      commitInstructionMode: 'append',
    } as any);
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:org/repo.git');
    mockedReadWorkspaceConfig.mockRejectedValue(new Error('No config'));
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: true,
    });
    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    mockedFetchOrigin.mockResolvedValue();
    mockedGetAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 0 });
    mockedReadBranchPublication.mockResolvedValue(false);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpulledCommits.mockResolvedValue(false);
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
      snapshot: null,
      branchName: 'feature-branch',
      remote: { owner: 'org', repo: 'repo' },
    });
    // Default: no changes via getDiffStats fallback
    mockedGetDiffStats.mockResolvedValue({ insertions: 0, deletions: 0 });
    mockedResolveCommitGenerationModelCandidates.mockResolvedValue({
      model: 'claude-sonnet-4-6',
      fallbackModels: ['gpt-5.5'],
    });
  });

  it('validates cancellation operation ids with the standard id gate', () => {
    cancelHandler({} as any, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      operationId: 'operation-1',
    });

    expect(mockedValidateId).toHaveBeenCalledWith('operation-1', 'operationId');
  });

  it('validates operation ids before registering a cancellable action', async () => {
    mockedValidateId.mockImplementationOnce(() => {
      throw new Error('Invalid operationId');
    });

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        operationId: 'INVALID',
      }),
    ).rejects.toThrow('Invalid operationId');

    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalled();
  });

  it('reports a cancellation accepted after the final handler checkpoint', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');

    let resolveCreatePr:
      | ((value: { prNumber: number; prUrl: string; created: boolean }) => void)
      | undefined;
    let markCreatePrStarted: (() => void) | undefined;
    const createPrStarted = new Promise<void>((resolve) => {
      markCreatePrStarted = resolve;
    });
    mockedCreatePrForRepo.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreatePr = resolve;
          markCreatePrStarted?.();
        }),
    );

    const operation = handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
      operationId: 'operation-final-boundary',
    });
    await createPrStarted;

    expect(
      cancelHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        operationId: 'operation-final-boundary',
      }),
    ).toMatchObject({ accepted: true, reason: 'cancel_requested' });
    resolveCreatePr?.({
      prNumber: 10,
      prUrl: 'https://github.com/org/single-repo/pull/10',
      created: true,
    });

    await expect(operation).resolves.toMatchObject({ cancelled: true });
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledTimes(1);
    expect(mockRecordCreatedPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 10,
        prUrl: 'https://github.com/org/single-repo/pull/10',
      }),
    );
  });

  it('emits multi-repo mutation failures before honoring cancellation', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ] as any);
    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedGetFullDiff.mockResolvedValue('diff content');
    mockedGetCommitLog.mockResolvedValue('commit log');
    mockedGeneratePrContent.mockResolvedValue({
      title: 'Test PR',
      body: 'Description',
    });
    mockedPushBranch.mockResolvedValue();

    let resolveSecondRepo: (() => void) | undefined;
    let markSecondRepoStarted: (() => void) | undefined;
    const secondRepoStarted = new Promise<void>((resolve) => {
      markSecondRepoStarted = resolve;
    });
    mockedCreatePrForRepo
      .mockRejectedValueOnce(new Error('push rejected'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondRepo = (): void =>
              resolve({
                prNumber: 2,
                prUrl: 'https://github.com/org/repo-b/pull/2',
                created: true,
              });
            markSecondRepoStarted?.();
          }),
      );

    const operation = handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      operationId: 'operation-batch-failure',
    });
    await secondRepoStarted;
    expect(
      cancelHandler({} as any, {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        operationId: 'operation-batch-failure',
      }),
    ).toMatchObject({ accepted: true, reason: 'cancel_requested' });
    resolveSecondRepo?.();

    await expect(operation).resolves.toMatchObject({ cancelled: true });
    expect(mockWindowSend).toHaveBeenCalledWith(
      IPC_CHANNELS.githubPrCreationProgress,
      expect.objectContaining({
        phase: 'error',
        repoName: 'repo-a',
        error: 'push rejected',
      }),
    );
  });

  function setupRepoForPr(repoName: string): void {
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedGetFullDiff.mockResolvedValue('diff content');
    mockedGetCommitLog.mockResolvedValue('commit log');
    mockedGetUncommittedDiff.mockResolvedValue('working tree diff');
    mockedGenerateCommitMessage.mockResolvedValue('feat: update changes');
    mockedStageAllChanges.mockResolvedValue();
    mockedCommitWithMessage.mockResolvedValue('abc123');
    mockedGeneratePrContent.mockResolvedValue({
      title: `PR for ${repoName}`,
      body: 'Description',
    });
    mockedPushBranch.mockResolvedValue();
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 1,
      prUrl: `https://github.com/org/${repoName}/pull/1`,
      created: true,
    });
  }

  it('refuses to mutate when the existing-PR lookup fails', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedFetchRepoPrTrackingData
      .mockResolvedValueOnce({
        status: null,
        snapshot: null,
        branchName: 'feature-branch',
        remote: { owner: 'org', repo: 'repo' },
      })
      .mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('Unable to verify whether "feature-branch" already has');

    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledTimes(2);
  });

  it('refuses to mutate when the origin is not a supported GitHub remote', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedGetRemoteUrl.mockResolvedValue('https://gitlab.com/org/repo.git');
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
      snapshot: null,
      branchName: 'feature-branch',
      remote: null,
    });

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('Unable to verify whether "feature-branch" already has');

    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });

  it('refuses to push when a PR appears after the commit', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    const noPr = {
      status: null,
      snapshot: null,
      branchName: 'feature-branch',
      remote: { owner: 'org', repo: 'repo' },
    };
    mockedFetchRepoPrTrackingData
      .mockResolvedValueOnce(noPr)
      .mockResolvedValueOnce(noPr)
      .mockResolvedValue({
        snapshot: null,
        branchName: 'feature-branch',
        remote: { owner: 'org', repo: 'repo' },
        status: {
          prNumber: 42,
          prUrl: 'https://github.com/org/repo/pull/42',
          state: 'open',
          title: 'Existing PR',
          checkStatus: 'passing',
          checkDetails: [],
          reviewStatus: 'approved',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-09-15T00:00:00.000Z',
        },
      });

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('Pull request #42 already exists');

    expect(mockedCommitWithMessage).toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedCreatePrForRepo).not.toHaveBeenCalled();
  });

  it('refuses to mutate when a fresh lookup finds an open PR', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      snapshot: null,
      branchName: 'feature-branch',
      remote: { owner: 'org', repo: 'repo' },
      status: {
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
        state: 'open',
        title: 'Existing PR',
        checkStatus: 'passing',
        checkDetails: [],
        reviewStatus: 'approved',
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-09-15T00:00:00.000Z',
      },
    });

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('Pull request #42 already exists');

    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });

  it('skips repos without changes in multi-repo project', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
      makeDirent('repo-c'),
    ] as any);

    // repo-a has uncommitted changes, repo-b has commits ahead, repo-c has nothing
    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    mockedHasUncommittedChanges
      .mockResolvedValueOnce(true) // repo-a precheck
      .mockResolvedValueOnce(false) // repo-b precheck
      .mockResolvedValueOnce(false) // repo-c precheck
      .mockResolvedValueOnce(true) // repo-a repoHasChanges
      .mockResolvedValueOnce(false) // repo-b repoHasChanges
      .mockResolvedValueOnce(false); // repo-c repoHasChanges
    mockedHasCommitsAhead
      .mockResolvedValueOnce(true) // repo-b: has commits ahead
      .mockResolvedValueOnce(false); // repo-c: no commits ahead

    // Setup for repos that will be processed (repo-a, repo-b)
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedGetFullDiff.mockResolvedValue('diff content');
    mockedGetCommitLog.mockResolvedValue('commit log');
    mockedGeneratePrContent.mockResolvedValue({
      title: 'Test PR',
      body: 'Description',
    });
    mockedPushBranch.mockResolvedValue();
    mockedCreatePrForRepo.mockImplementation((repoPath: string) => {
      if (repoPath.endsWith('/repo-a')) {
        return Promise.resolve({
          prNumber: 1,
          prUrl: 'https://github.com/org/repo-a/pull/1',
          created: true,
        });
      }
      return Promise.resolve({
        prNumber: 2,
        prUrl: 'https://github.com/org/repo-b/pull/2',
        created: true,
      });
    });

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toHaveLength(2);
    expect(result.repos[0].repoId).toBe('repo-a');
    expect(result.repos[1].repoId).toBe('repo-b');
    expect(result.skippedRepos).toHaveLength(1);
    expect(result.localOnlyCommittedRepos).toEqual([]);
    expect(result.skippedRepos[0]).toEqual({
      repoId: 'repo-c',
      repoName: 'repo-c',
      reason: 'no_changes',
    });
    expect(mockRecordCreatedPullRequest).toHaveBeenCalledTimes(2);
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledTimes(2);
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledWith({
      projectId: 'workspace-a',
      source: 'manual',
      flow: 'pull_request',
      repoCount: 3,
    });
    expect(mockRecordCreatedPullRequest).toHaveBeenCalledWith({
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      repoId: 'repo-a',
      repoLabel: 'repo-a',
      provider: 'claude',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo-a/pull/1',
    });
    expect(mockRecordCreatedPullRequest).toHaveBeenCalledWith({
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      repoId: 'repo-b',
      repoLabel: 'repo-b',
      provider: 'claude',
      prNumber: 2,
      prUrl: 'https://github.com/org/repo-b/pull/2',
    });
    expect(mockedGeneratePrContent).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: {
          projectId: 'workspace-a',
          worktreeId: 'wt-1',
          repoId: 'repo-a',
          repoLabel: 'repo-a',
        },
      }),
    );
  });

  it('respects repoIds filter', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
      makeDirent('repo-c'),
    ] as any);

    // All repos have changes (via commits ahead, not uncommitted)
    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedGetFullDiff.mockResolvedValue('diff content');
    mockedGetCommitLog.mockResolvedValue('commit log');
    mockedGeneratePrContent.mockResolvedValue({
      title: 'Test PR',
      body: 'Description',
    });
    mockedPushBranch.mockResolvedValue();
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 5,
      prUrl: 'https://github.com/org/repo-b/pull/5',
      created: true,
    });

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      repoIds: ['repo-b'],
    });

    // Only repo-b should be processed, no skipped (since we only asked for repo-b)
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].repoId).toBe('repo-b');
    expect(result.skippedRepos).toHaveLength(0);
    expect(result.localOnlyCommittedRepos).toEqual([]);

    // repo-b is checked during the precheck and again before auto-commit in processRepoForPr.
    expect(mockedHasUncommittedChanges).toHaveBeenCalledTimes(2);
  });

  it('preserves a selected multi-repo preflight failure', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ] as any);
    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedFetchOrigin.mockImplementation((_repoPath, options) =>
      options?.signal === undefined
        ? Promise.resolve()
        : Promise.reject(new Error('network unavailable')),
    );

    await expect(
      handler({} as any, {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        repoIds: ['repo-b'],
      }),
    ).rejects.toThrow(
      'Unable to verify whether "feature-branch" is current with origin',
    );

    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });

  it('throws when all repos are skipped', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ] as any);

    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasCommitsAhead.mockResolvedValue(false);

    await expect(
      handler({} as any, {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('No repos have changes');
  });

  it('preserves original target count when PR creation resumes a subset', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    await handler(
      {},
      {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        source: 'chat',
        telemetryRepoCount: 3,
      },
    );
    const expected = {
      projectId: 'project-a',
      source: 'chat',
      flow: 'pull_request',
      repoCount: 3,
    };
    expect(recordGitCommitTelemetry).toHaveBeenCalledWith(expected);
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledWith(expected);
  });

  it('counts a pre-PR commit when its later push fails, but no PR outcome', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedPushBranch.mockRejectedValueOnce(new Error('push failed'));
    await expect(
      handler(
        {},
        { projectId: 'project-a', worktreeId: 'wt-1', source: 'chat' },
      ),
    ).rejects.toThrow('push failed');
    expect(recordGitCommitTelemetry).toHaveBeenCalledTimes(1);
    expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
  });

  it('preserves PR creation when the injected recorder throws', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    jest.mocked(recordPullRequestOpenedTelemetry).mockImplementationOnce(() => {
      throw new Error('telemetry');
    });
    await expect(
      handler({}, { projectId: 'project-a', worktreeId: 'wt-1' }),
    ).resolves.toMatchObject({
      repos: [expect.objectContaining({ prNumber: 1 })],
    });
  });

  it('preserves chat attribution for pre-PR commits and counts PR success before bookkeeping failure', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 10,
      prUrl: 'https://github.com/org/repo/pull/10',
      created: true,
    });
    mockRecordCreatedPullRequest.mockImplementationOnce(() => {
      throw new Error('bookkeeping failed');
    });
    await expect(
      handler(
        {},
        { projectId: 'project-a', worktreeId: 'wt-1', source: 'chat' },
      ),
    ).rejects.toThrow('bookkeeping failed');
    const input = {
      projectId: 'project-a',
      source: 'chat',
      flow: 'pull_request',
      repoCount: 1,
    };
    expect(recordGitCommitTelemetry).toHaveBeenCalledWith(input);
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledTimes(1);
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledWith(input);
  });

  it('returns empty skippedRepos for single-repo project', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/source/repos/underlying-repo',
      repos: [],
    });

    setupRepoForPr('underlying-repo');
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 10,
      prUrl: 'https://github.com/org/underlying-repo/pull/10',
      created: true,
    });

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toHaveLength(1);
    expect(result.skippedRepos).toHaveLength(0);
    expect(result.localOnlyCommittedRepos).toEqual([]);
    expect(result.repos[0]).toEqual({
      repoId: SINGLE_REPO_USAGE_REPO_ID,
      repoName: 'underlying-repo',
      prNumber: 10,
      prUrl: 'https://github.com/org/underlying-repo/pull/10',
    });
    expect(mockedGeneratePrContent).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: {
          projectId: 'project-a',
          worktreeId: 'wt-1',
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoLabel: 'underlying-repo',
        },
      }),
    );
  });

  it('does not record PR activity when GitHub returns an existing PR', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');

    setupRepoForPr('single-repo');
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 10,
      prUrl: 'https://github.com/org/single-repo/pull/10',
      created: false,
    });

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        prNumber: 10,
        prUrl: 'https://github.com/org/single-repo/pull/10',
      },
    ]);
    expect(mockRecordCreatedPullRequest).not.toHaveBeenCalled();
    expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
  });

  it('uses a remote-backed worktree base branch when creating a PR', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'develop',
      existsLocally: true,
      existsInRemote: true,
    });

    setupRepoForPr('single-repo');

    await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(mockedHasCommitsAhead).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'develop',
    );
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/workspace/single-repo');
    expect(mockedFetchOrigin.mock.invocationCallOrder[0]).toBeLessThan(
      mockedHasCommitsAhead.mock.invocationCallOrder[0],
    );
    expect(mockedGetFullDiff).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'develop',
    );
    const lastFetchCallOrder =
      mockedFetchOrigin.mock.invocationCallOrder[
        mockedFetchOrigin.mock.invocationCallOrder.length - 1
      ];
    expect(lastFetchCallOrder).toBeLessThan(
      mockedGetFullDiff.mock.invocationCallOrder[0],
    );
    expect(mockedGetCommitLog).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'develop',
    );
    expect(mockedGeneratePrContent).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'develop',
      }),
    );
    expect(mockedCreatePrForRepo).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'feature-branch',
      'PR for single-repo',
      'Description',
      'develop',
    );
  });

  it('uses a remote-backed worktree base when the default cannot be resolved', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'develop',
      existsLocally: true,
      existsInRemote: true,
    });
    setupRepoForPr('single-repo');
    mockedResolveRepoDefaultBranch.mockResolvedValue(null);

    await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(mockedCreatePrForRepo).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'feature-branch',
      'PR for single-repo',
      'Description',
      'develop',
    );
  });

  it('falls back to the remote default branch when the worktree base is not remote-backed', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'release/local-only',
      existsLocally: true,
      existsInRemote: false,
    });

    setupRepoForPr('single-repo');

    await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(mockedHasCommitsAhead).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'main',
    );
    expect(mockedGeneratePrContent).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'main',
      }),
    );
    expect(mockedCreatePrForRepo).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'feature-branch',
      'PR for single-repo',
      'Description',
      'main',
    );
  });

  it('fails instead of silently targeting main when no default branch can be resolved', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'release/local-only',
      existsLocally: true,
      existsInRemote: false,
    });
    setupRepoForPr('single-repo');
    mockedResolveRepoDefaultBranch.mockResolvedValue(null);

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('Unable to resolve the default branch');

    expect(mockedCreatePrForRepo).not.toHaveBeenCalled();
  });

  it('retries PR creation against the remote default branch when GitHub rejects the preferred base', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'develop',
      existsLocally: true,
      existsInRemote: true,
    });

    setupRepoForPr('single-repo');
    mockedGeneratePrContent
      .mockResolvedValueOnce({
        title: 'PR against develop',
        body: 'Develop description',
      })
      .mockResolvedValueOnce({
        title: 'PR against main',
        body: 'Main description',
      });
    mockedCreatePrForRepo
      .mockRejectedValueOnce(
        Object.assign(new Error('Validation Failed'), {
          status: 422,
          response: {
            data: {
              errors: [
                {
                  resource: 'PullRequest',
                  field: 'base',
                  message: 'base branch does not exist',
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce({
        prNumber: 12,
        prUrl: 'https://github.com/org/single-repo/pull/12',
        created: true,
      });

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        prNumber: 12,
        prUrl: 'https://github.com/org/single-repo/pull/12',
      },
    ]);
    expect(mockedGeneratePrContent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        baseBranch: 'develop',
      }),
    );
    expect(mockedGeneratePrContent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        baseBranch: 'main',
      }),
    );
    expect(mockedCreatePrForRepo).toHaveBeenNthCalledWith(
      1,
      '/workspace/single-repo',
      'feature-branch',
      'PR against develop',
      'Develop description',
      'develop',
    );
    expect(mockedCreatePrForRepo).toHaveBeenNthCalledWith(
      2,
      '/workspace/single-repo',
      'feature-branch',
      'PR against main',
      'Main description',
      'main',
    );
  });

  it('does not record PR activity when fallback base creation returns an existing PR', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'develop',
      existsLocally: true,
      existsInRemote: true,
    });

    setupRepoForPr('single-repo');
    mockedGeneratePrContent
      .mockResolvedValueOnce({
        title: 'PR against develop',
        body: 'Develop description',
      })
      .mockResolvedValueOnce({
        title: 'PR against main',
        body: 'Main description',
      });
    mockedCreatePrForRepo
      .mockRejectedValueOnce(
        Object.assign(new Error('Validation Failed'), {
          status: 422,
          response: {
            data: {
              errors: [
                {
                  resource: 'PullRequest',
                  field: 'base',
                  message: 'base branch does not exist',
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce({
        prNumber: 12,
        prUrl: 'https://github.com/org/single-repo/pull/12',
        created: false,
      });

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        prNumber: 12,
        prUrl: 'https://github.com/org/single-repo/pull/12',
      },
    ]);
    expect(mockRecordCreatedPullRequest).not.toHaveBeenCalled();
    expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
  });

  it('auto-commits uncommitted changes before creating a PR', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');

    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedGetUncommittedDiff.mockResolvedValue('working tree diff');
    mockedGenerateCommitMessage.mockResolvedValue('feat: commit before pr');
    mockedStageAllChanges.mockResolvedValue();
    mockedCommitWithMessage.mockResolvedValue('abc123');
    mockedGetFullDiff.mockResolvedValue('diff content');
    mockedGetCommitLog.mockResolvedValue('commit log');
    mockedGeneratePrContent.mockResolvedValue({
      title: 'Test PR',
      body: 'Description',
    });
    mockedPushBranch.mockResolvedValue();
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 11,
      prUrl: 'https://github.com/org/single-repo/pull/11',
      created: true,
    });

    await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(mockedGenerateCommitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/workspace/single-repo',
        branchName: 'feature-branch',
        diff: 'working tree diff',
        model: 'claude-sonnet-4-6',
        fallbackModels: ['gpt-5.5'],
      }),
    );
    expect(mockedStageAllChanges).toHaveBeenCalledWith(
      '/workspace/single-repo',
    );
    expect(mockedCommitWithMessage).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'feat: commit before pr',
    );
  });

  it('revalidates remote divergence before committing dirty work', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedReadBranchPublication.mockResolvedValue(true);
    mockedGetAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('behind origin');

    expect(mockedFetchOrigin).toHaveBeenCalled();
    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });

  it('rejects a remote create when the displayed branch changed before mutation', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('different-feature');

    await expect(
      handler(
        {},
        {
          projectId: 'project-a',
          worktreeId: 'wt-1',
          expectedBaseBranch: 'main',
          expectedHeadBranch: 'feature-branch',
        },
      ),
    ).rejects.toThrow('PR state changed');

    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedCreatePrForRepo).not.toHaveBeenCalled();
  });

  it('blocks before mutation when branch publication is unknown', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedReadBranchPublication.mockResolvedValue(null);

    await expect(
      handler({}, { projectId: 'project-a', worktreeId: 'wt-1' }),
    ).rejects.toThrow('Unable to verify');

    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedCreatePrForRepo).not.toHaveBeenCalled();
  });

  it('allows a never-pushed branch whose configured upstream is another branch', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasRemoteTrackingBranch.mockResolvedValue(true);
    mockedReadBranchPublication.mockResolvedValue(false);
    mockedGetAheadBehindCounts.mockRejectedValue(
      new Error('unknown revision origin/feature-branch'),
    );

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).resolves.toMatchObject({
      repos: [expect.objectContaining({ prNumber: 1 })],
    });

    expect(mockedGetAheadBehindCounts).not.toHaveBeenCalled();
    expect(mockedPushBranch).toHaveBeenCalled();
  });

  it('blocks a behind origin branch even when no upstream is configured', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedReadBranchPublication.mockResolvedValue(true);
    mockedGetAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('behind origin');

    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });

  it('blocks before mutation when origin cannot be refreshed', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    setupRepoForPr('single-repo');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedFetchOrigin.mockImplementation((_repoPath, options) =>
      options?.signal === undefined
        ? Promise.resolve()
        : Promise.reject(new Error('network unavailable')),
    );

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow(
      'Unable to verify whether "feature-branch" is current with origin',
    );

    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedFetchOrigin).toHaveBeenCalledWith(
      '/workspace/single-repo',
      expect.anything(),
    );
    expect(
      mockedFetchOrigin.mock.calls.some(
        ([, options]) => options?.signal instanceof AbortSignal,
      ),
    ).toBe(true);
  });

  it('refreshes PR status even when single-repo PR creation fails', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');

    setupRepoForPr('single-repo');
    mockedCreatePrForRepo.mockRejectedValue(
      new Error('a pull request already exists for feature-branch'),
    );

    await expect(
      handler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('already exists');

    expect(mockedRefreshNow).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(mockedRequestRefresh).not.toHaveBeenCalled();
  });

  it('detects changes via getDiffStats fallback when hasCommitsAhead returns false', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ] as any);

    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    // Both repos: no uncommitted, hasCommitsAhead returns false (e.g., origin ref missing)
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasCommitsAhead.mockResolvedValue(false);

    // repo-a has changes detectable via getDiffStats, repo-b has none
    mockedGetDiffStats
      .mockResolvedValueOnce({ insertions: 10, deletions: 5 }) // repo-a
      .mockResolvedValueOnce({ insertions: 0, deletions: 0 }); // repo-b

    // Setup for repo-a processing
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedGetFullDiff.mockResolvedValue('diff content');
    mockedGetCommitLog.mockResolvedValue('commit log');
    mockedGeneratePrContent.mockResolvedValue({
      title: 'Test PR',
      body: 'Description',
    });
    mockedPushBranch.mockResolvedValue();
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 1,
      prUrl: 'https://github.com/org/repo-a/pull/1',
      created: true,
    });

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].repoId).toBe('repo-a');
    expect(result.skippedRepos).toHaveLength(1);
    expect(result.skippedRepos[0].repoId).toBe('repo-b');
    expect(result.localOnlyCommittedRepos).toEqual([]);
  });

  it('commits but does not push or create a PR for local-only repos with uncommitted changes', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedGetRemoteUrl.mockResolvedValue(null);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedGetUncommittedDiff.mockResolvedValue('working tree diff');
    mockedGenerateCommitMessage.mockResolvedValue('feat: local-only commit');
    mockedStageAllChanges.mockResolvedValue();
    mockedCommitWithMessage.mockResolvedValue('abc123');

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([]);
    expect(result.skippedRepos).toEqual([]);
    expect(result.localOnlyCommittedRepos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        commitHash: 'abc123',
      },
    ]);
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedGeneratePrContent).not.toHaveBeenCalled();
    expect(mockedCreatePrForRepo).not.toHaveBeenCalled();
  });

  it('does not block on refreshNow in multi-repo project and enqueues a fast refresh instead', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ] as any);
    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedGetFullDiff.mockResolvedValue('diff content');
    mockedGetCommitLog.mockResolvedValue('commit log');
    mockedGeneratePrContent.mockResolvedValue({
      title: 'Test PR',
      body: 'Description',
    });
    mockedPushBranch.mockResolvedValue();
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      created: true,
    });

    await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(mockedRefreshNow).not.toHaveBeenCalled();
    expect(mockedRequestRefresh).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
      true,
    );
    expect(mockedEnqueueFastRefresh).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
      false,
    );
  });

  it('returns structured authentication failures from the existing-PR safety check', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedFetchRepoPrTrackingData.mockRejectedValue(
      new GitHubBrokerError('not_authenticated', 'Login required'),
    );
    await expect(
      handler({} as any, { projectId: 'workspace-a', worktreeId: 'wt-1' }),
    ).resolves.toMatchObject({
      repos: [],
      failedRepos: [
        { failureCode: 'github_not_authenticated', error: 'Login required' },
      ],
    });
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedCreatePrForRepo).not.toHaveBeenCalled();
  });

  it('does not commit new edits when continuing PR creation after authentication', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedGetFullDiff.mockResolvedValue('committed diff');
    mockedGetCommitLog.mockResolvedValue('existing commit');
    mockedGeneratePrContent.mockResolvedValue({ title: 'PR', body: 'Body' });
    mockedPushBranch.mockResolvedValue();
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 1,
      prUrl: 'https://github.com/a/b/pull/1',
      created: true,
    });
    await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      skipCommit: true,
      expectedHeadBranch: 'feature-branch',
    });
    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit HTTPS credential failures from the initial fetch', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedFetchOrigin.mockRejectedValue(new Error('Authentication failed'));

    const result = await handler(
      {},
      { projectId: 'workspace-a', worktreeId: 'wt-1' },
    );
    expect(result.failedRepos).toEqual([
      expect.objectContaining({
        error: 'Authentication failed',
        failureCode: 'github_not_authenticated',
        commitPrepared: false,
      }),
    ]);
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedCreatePrForRepo).not.toHaveBeenCalled();
  });

  it('rejects a deleted selected repository instead of creating a PR for the root', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    await expect(
      handler(
        {},
        {
          projectId: 'workspace-a',
          worktreeId: 'wt-1',
          repoIds: ['deleted-repo'],
          skipCommit: true,
          expectedHeadBranch: 'feature-branch',
        },
      ),
    ).rejects.toThrow('repository changed');
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedCreatePrForRepo).not.toHaveBeenCalled();
  });

  it('continues after an already successful push without pushing or committing again', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedGetFullDiff.mockResolvedValue('committed diff');
    mockedGetCommitLog.mockResolvedValue('existing commit');
    mockedGeneratePrContent.mockResolvedValue({ title: 'PR', body: 'Body' });
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 1,
      prUrl: 'https://github.com/a/b/pull/1',
      created: true,
    });
    await handler(
      {},
      {
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        skipCommit: true,
        expectedHeadBranch: 'feature-branch',
        skipPush: true,
      },
    );
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCreatePrForRepo).toHaveBeenCalledTimes(1);
  });

  it('still enqueues a fast refresh when multi-repo PR creation partially fails', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/wt');
    mockedReaddir.mockResolvedValue([
      makeDirent('repo-a'),
      makeDirent('repo-b'),
    ] as any);
    mockedResolveRepoDefaultBranch.mockResolvedValue('main');
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('feature-branch');
    mockedGetFullDiff.mockResolvedValue('diff content');
    mockedGetCommitLog.mockResolvedValue('commit log');
    mockedGeneratePrContent.mockResolvedValue({
      title: 'Test PR',
      body: 'Description',
    });
    mockedPushBranch.mockResolvedValue();
    mockedCreatePrForRepo
      .mockResolvedValueOnce({
        prNumber: 1,
        prUrl: 'https://github.com/org/repo-a/pull/1',
        created: true,
      })
      .mockRejectedValueOnce(new Error('GitHub API error'));

    const result = await handler({} as any, {
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].repoId).toBe('repo-a');
    expect(mockedRefreshNow).not.toHaveBeenCalled();
    expect(mockedRequestRefresh).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
      true,
    );
    expect(mockedEnqueueFastRefresh).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
      false,
    );
  });

  it('skips local-only repos with committed changes using no_remote_origin', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/single-repo');
    mockedGetRemoteUrl.mockResolvedValue(null);
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: false,
    });
    mockedHasCommitsAhead.mockResolvedValue(true);

    const result = await handler({} as any, {
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.repos).toEqual([]);
    expect(result.localOnlyCommittedRepos).toEqual([]);
    expect(result.skippedRepos).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'single-repo',
        reason: 'no_remote_origin',
      },
    ]);
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(mockedGeneratePrContent).not.toHaveBeenCalled();
    expect(mockedCreatePrForRepo).not.toHaveBeenCalled();
  });
});
