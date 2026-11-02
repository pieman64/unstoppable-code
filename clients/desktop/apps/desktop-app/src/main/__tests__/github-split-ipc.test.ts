/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await, @typescript-eslint/unbound-method */
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
  getCurrentBranch: jest.fn(),
  getDiffStats: jest.fn(),
  getFullDiff: jest.fn(),
  getCommitLog: jest.fn(),
  fetchOrigin: jest.fn(),
  pushBranch: jest.fn(),
  pullBranchFastForward: jest.fn(),
  pullBranchRebase: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
  getRemoteUrl: jest.fn(),
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
  fetchRepoPrTrackingData: jest.fn(),
  mergePrForRepo: jest.fn(),
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

jest.mock('../lib/pr-split-planner', () => {
  class PrSplitPlanningError extends Error {
    code: string;
    issues: unknown[];
    constructor(code: string, message: string, issues: unknown[] = []) {
      super(message);
      this.name = 'PrSplitPlanningError';
      this.code = code;
      this.issues = issues;
    }
  }
  return {
    planPrSplit: jest.fn(),
    PrSplitPlanningError,
  };
});

jest.mock('../lib/github-pr-splitter', () => {
  class SplitPrExecutionError extends Error {
    code?: string;
    childIndex?: number;
    verifyTail?: string;
    constructor(
      message: string,
      options: { code?: string; childIndex?: number; verifyTail?: string } = {},
    ) {
      super(message);
      this.name = 'SplitPrExecutionError';
      this.code = options.code;
      this.childIndex = options.childIndex;
      this.verifyTail = options.verifyTail;
    }
  }
  return {
    executePrSplit: jest.fn(),
    SplitPrExecutionError,
  };
});

jest.mock('../lib/split-pr-persistence', () => ({
  readSplitPrMap: jest.fn(),
  deleteSplitPrMapForWorktree: jest.fn(),
}));

// The split lock service is intentionally NOT mocked: the workflow handler
// tests exercise real acquire/release/broadcast behavior.
jest.mock('../terminal/worker-terminal', () => ({
  workerTerminal: {
    killWorktree: jest.fn(),
  },
}));

jest.mock('../browser/browser-service-registry', () => ({
  getBrowserService: jest.fn(),
}));

jest.mock('../services/scripts-service', () => ({
  stopWorktreeScripts: jest.fn(() => Promise.resolve()),
}));

jest.mock('../lib/hook-runner', () => ({
  stopHooksForWorktree: jest.fn(() => Promise.resolve()),
}));

jest.mock('../agents/session-manager', () => ({
  hasActiveChatTurnsForWorktree: jest.fn(() => false),
  hasActiveChatWorkForWorktree: jest.fn(() => false),
}));

jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/execution-state',
  () => ({
    listExecutionSummaries: jest.fn(() => Promise.resolve([])),
  }),
);

jest.mock('../lib/paths', () => ({
  getDataDir: jest.fn(() => '/tmp/canopy-test-data'),
}));

import { validateId } from '../lib/validation';
import { registerIpcHandler } from '../ipc/register';
import { planPrSplit, PrSplitPlanningError } from '../lib/pr-split-planner';
import type { SplitPlanIssue } from '@canopy/desktop-shared/types/pr-split-plan';
import {
  executePrSplit,
  SplitPrExecutionError,
} from '../lib/github-pr-splitter';
import {
  readSplitPrMap,
  deleteSplitPrMapForWorktree,
} from '../lib/split-pr-persistence';
import { getGitHubClient } from '../lib/github-client';
import { workerTerminal } from '../terminal/worker-terminal';
import { getBrowserService } from '../browser/browser-service-registry';
import { stopWorktreeScripts } from '../services/scripts-service';
import { stopHooksForWorktree } from '../lib/hook-runner';
import {
  isSplitLocked,
  releaseSplitLock,
  acquireSplitLock,
  SplitLockError,
  SplitStartBlockedError,
} from '../services/split-lock-service';
import {
  hasActiveChatTurnsForWorktree,
  hasActiveChatWorkForWorktree,
} from '../agents/session-manager';
import { listExecutionSummaries } from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { getSplitPrRuntimeProjection } from '../services/split-pr-runtime-projection';
import {
  beginGitActionCancellationScope,
  finishGitActionCancellationScope,
} from '../ipc/git-action-cancellation';
import type {
  SplitPrPlanRequest,
  SplitPrPlanResponse,
  SplitPrPlanResult,
  SplitPrExecuteResponse,
  SplitPrCancelRequest,
  SplitPrDiscardRequest,
  SplitPrDiscardResponse,
  SplitPrMap,
  SplitPrProgressEvent,
  SplitWorkflowStartRequest,
  SplitWorkflowStartResult,
  SplitWorkflowApproveRequest,
  SplitWorkflowExitRequest,
} from '@canopy/desktop-shared/types/github';

const mockedValidateId = jest.mocked(validateId);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedPlanPrSplit = jest.mocked(planPrSplit);
const mockedExecutePrSplit = jest.mocked(executePrSplit);
const mockedReadSplitPrMap = jest.mocked(readSplitPrMap);
const mockedDeleteSplitPrMap = jest.mocked(deleteSplitPrMapForWorktree);

type PlanHandlerFn = (
  event: any,
  request: SplitPrPlanRequest,
) => Promise<SplitPrPlanResult>;
type CancelHandlerFn = (
  event: any,
  request: SplitPrCancelRequest,
) => Promise<void>;
type GetMapHandlerFn = (
  event: any,
  request: { projectId: string; worktreeId: string },
) => Promise<SplitPrMap | null>;
type DiscardHandlerFn = (
  event: any,
  request: SplitPrDiscardRequest,
) => Promise<SplitPrDiscardResponse>;

function findHandler<T>(channel: string): T {
  // Use the LAST matching registration: some tests re-register handlers
  // against a fresh mock window to inspect `sendToWindow` calls in isolation.
  const call = [...mockedRegisterIpcHandler.mock.calls]
    .reverse()
    .find((entry: any[]) => entry[0] === channel);
  if (!call) {
    throw new Error(`${channel} handler not registered`);
  }
  return call[1] as unknown as T;
}

function buildPlan(): SplitPrPlanResponse['plan'] {
  return {
    finalGoal: 'Split the PR',
    concerns: [],
    children: [],
    parallelizable: '',
    landOrder: '',
    buildTestCommand: '',
    unassignedHunks: [],
  };
}

function buildSnapshot(): SplitPrPlanResponse['snapshot'] {
  return {
    baseRef: 'base-sha',
    headRef: 'head-sha',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

function buildSplitPrMap(overrides: Partial<SplitPrMap> = {}): SplitPrMap {
  return {
    version: 1,
    originalPrNumber: 42,
    originalPrUrl: 'https://github.com/org/repo/pull/42',
    originalBaseBranch: 'main',
    originalHeadBranch: 'feature',
    originalHeadSha: 'abc123',
    integrationBranch: 'split-pr/integration-42',
    originalWorktreeId: 'wt-1',
    children: [],
    status: 'executing',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

type StartWorkflowHandlerFn = (
  event: any,
  request: SplitWorkflowStartRequest,
) => Promise<SplitWorkflowStartResult>;
type ApproveWorkflowHandlerFn = (
  event: any,
  request: SplitWorkflowApproveRequest,
) => Promise<SplitPrExecuteResponse>;
type ExitWorkflowHandlerFn = (
  event: any,
  request: SplitWorkflowExitRequest,
) => void;

const mockedGetBrowserService = jest.mocked(getBrowserService);
const mockedStopWorktreeScripts = jest.mocked(stopWorktreeScripts);
const mockedStopHooksForWorktree = jest.mocked(stopHooksForWorktree);
const mockedKillWorktreeTerminals = jest.mocked(workerTerminal.killWorktree);
const mockedHasActiveChatWork = jest.mocked(hasActiveChatWorkForWorktree);
const mockedHasActiveChatTurns = jest.mocked(hasActiveChatTurnsForWorktree);
const mockedListExecutionSummaries = jest.mocked(listExecutionSummaries);
const windowSend = jest.fn();

describe('split PR IPC handlers', () => {
  let planHandler: PlanHandlerFn;
  let cancelHandler: CancelHandlerFn;
  let getMapHandler: GetMapHandlerFn;
  let discardHandler: DiscardHandlerFn;
  let startWorkflowHandler: StartWorkflowHandlerFn;
  let approveWorkflowHandler: ApproveWorkflowHandlerFn;
  let exitWorkflowHandler: ExitWorkflowHandlerFn;
  let lockStateHandler: (event: any) => { locked: Array<any> };
  let releaseIdleSplitLocksForRendererLifecycle: () => number;

  beforeAll(async () => {
    jest.mocked(getGitHubClient).mockReturnValue({} as any);

    const githubModule = await import('../ipc/github');
    const { registerGitHubHandlers } = githubModule;
    releaseIdleSplitLocksForRendererLifecycle =
      githubModule.releaseIdleSplitLocksForRendererLifecycle;
    const mockWindow = {
      isDestroyed: (): boolean => false,
      webContents: {
        send: windowSend,
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

    planHandler = findHandler<PlanHandlerFn>(IPC_CHANNELS.githubSplitPrPlan);
    cancelHandler = findHandler<CancelHandlerFn>(
      IPC_CHANNELS.githubSplitPrCancel,
    );
    getMapHandler = findHandler<GetMapHandlerFn>(
      IPC_CHANNELS.githubSplitPrGetMap,
    );
    discardHandler = findHandler<DiscardHandlerFn>(
      IPC_CHANNELS.githubSplitPrDiscard,
    );
    startWorkflowHandler = findHandler<StartWorkflowHandlerFn>(
      IPC_CHANNELS.githubSplitWorkflowStart,
    );
    approveWorkflowHandler = findHandler<ApproveWorkflowHandlerFn>(
      IPC_CHANNELS.githubSplitWorkflowApprove,
    );
    exitWorkflowHandler = findHandler<ExitWorkflowHandlerFn>(
      IPC_CHANNELS.githubSplitWorkflowExit,
    );
    lockStateHandler = findHandler<(event: any) => { locked: Array<any> }>(
      IPC_CHANNELS.githubSplitLockState,
    );
  });

  beforeEach(() => {
    mockedValidateId.mockClear();
    mockedPlanPrSplit.mockReset();
    mockedExecutePrSplit.mockReset();
    mockedReadSplitPrMap.mockReset();
    mockedDeleteSplitPrMap.mockReset();
    mockedDeleteSplitPrMap.mockResolvedValue(undefined);
    mockedGetBrowserService.mockReset();
    mockedGetBrowserService.mockReturnValue(null);
    mockedStopWorktreeScripts.mockReset();
    mockedStopWorktreeScripts.mockResolvedValue(undefined);
    mockedKillWorktreeTerminals.mockReset();
    mockedHasActiveChatWork.mockReset();
    mockedHasActiveChatWork.mockReturnValue(false);
    mockedHasActiveChatTurns.mockReset();
    mockedHasActiveChatTurns.mockReturnValue(false);
    mockedListExecutionSummaries.mockReset();
    mockedListExecutionSummaries.mockResolvedValue([]);
    windowSend.mockClear();
    // Ensure no lock leaks between tests.
    releaseSplitLock('project-a', 'wt-1');
  });

  it('rejects every recipient split mutation before planning or execution', async () => {
    const scope = {
      projectId: 'shared-container-viewer',
      worktreeId: 'container-1',
    };
    await expect(planHandler({} as any, scope)).rejects.toThrow(
      'Shared-container recipient workspaces are read-only',
    );
    expect(() => cancelHandler({} as any, scope)).toThrow(
      'Shared-container recipient workspaces are read-only',
    );
    await expect(discardHandler({} as any, scope)).rejects.toThrow(
      'Shared-container recipient workspaces are read-only',
    );
    await expect(
      startWorkflowHandler({} as any, { ...scope, mode: 'plan' }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');
    await expect(
      approveWorkflowHandler({} as any, {
        ...scope,
        plan: buildPlan(),
        snapshot: buildSnapshot(),
      }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');
    expect(() => exitWorkflowHandler({} as any, scope)).toThrow(
      'Shared-container recipient workspaces are read-only',
    );
    expect(mockedPlanPrSplit).not.toHaveBeenCalled();
    expect(mockedExecutePrSplit).not.toHaveBeenCalled();
  });

  describe('plan', () => {
    it('validates ids and delegates to planPrSplit, wrapping its response in an ok envelope', async () => {
      const response: SplitPrPlanResponse = {
        plan: buildPlan(),
        snapshot: buildSnapshot(),
        originalPr: {
          prNumber: 42,
          prUrl: 'https://github.com/org/repo/pull/42',
          baseBranch: 'main',
          headBranch: 'feature',
          headSha: 'abc123',
        },
      };
      mockedPlanPrSplit.mockResolvedValue(response);

      const result = await planHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });

      expect(mockedValidateId).toHaveBeenCalledWith('project-a', 'projectId');
      expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
      expect(mockedPlanPrSplit).toHaveBeenCalledWith({
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });
      expect(result).toEqual({ status: 'ok', response });
    });

    it('resolves a refused envelope when planPrSplit throws PrSplitPlanningError', async () => {
      mockedPlanPrSplit.mockRejectedValue(
        new PrSplitPlanningError(
          'head_out_of_sync',
          'Your local branch is behind the PR head. Push your branch to continue.',
        ),
      );

      const result = await planHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });

      expect(result).toEqual({
        status: 'refused',
        code: 'head_out_of_sync',
        message:
          'Your local branch is behind the PR head. Push your branch to continue.',
      });
    });

    it('still rejects when planPrSplit throws an unexpected error', async () => {
      mockedPlanPrSplit.mockRejectedValue(new Error('boom'));

      await expect(
        planHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-1',
        }),
      ).rejects.toThrow('boom');
    });

    it('forwards issues on the refused envelope for invalid_plan failures', async () => {
      const issues: SplitPlanIssue[] = [
        {
          code: 'unassigned-hunk',
          severity: 'error',
          message: 'hunk 2 of foo.ts is not assigned to any child',
        },
        {
          code: 'duplicate-hunk',
          severity: 'error',
          message: 'hunk 0 of bar.ts is assigned to multiple children',
          childIndex: 1,
        },
      ];
      mockedPlanPrSplit.mockRejectedValue(
        new PrSplitPlanningError(
          'invalid_plan',
          'Split plan fixture failed validation: hunk 2 of foo.ts is not assigned to any child; hunk 0 of bar.ts is assigned to multiple children',
          issues,
        ),
      );

      const result = await planHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });

      expect(result).toEqual({
        status: 'refused',
        code: 'invalid_plan',
        message:
          'Split plan fixture failed validation: hunk 2 of foo.ts is not assigned to any child; hunk 0 of bar.ts is assigned to multiple children',
        issues,
      });
    });

    it('omits issues on the refused envelope when the error carries none', async () => {
      mockedPlanPrSplit.mockRejectedValue(
        new PrSplitPlanningError(
          'no_open_pr',
          'There is no open pull request.',
        ),
      );

      const result = await planHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });

      expect(result).toEqual({
        status: 'refused',
        code: 'no_open_pr',
        message: 'There is no open pull request.',
      });
    });
  });

  describe('cancel', () => {
    it('aborts the in-flight controller signal', async () => {
      let capturedSignal: AbortSignal | undefined;
      mockedExecutePrSplit.mockImplementation(
        (options) =>
          new Promise((resolve) => {
            capturedSignal = options.signal;
            options.signal.addEventListener('abort', () => {
              resolve(buildSplitPrMap({ status: 'cancelled' }));
            });
          }),
      );

      // Establish an in-flight execute via the lockdown approve path (the only
      // remaining execute entry point); it populates the same abort-controller
      // registry cancel targets.
      acquireSplitLock('project-c', 'wt-cancel');
      const executePromise = approveWorkflowHandler({} as any, {
        projectId: 'project-c',
        worktreeId: 'wt-cancel',
        plan: buildPlan(),
        snapshot: buildSnapshot(),
      });

      await Promise.resolve();

      await Promise.resolve(
        cancelHandler({} as any, {
          projectId: 'project-c',
          worktreeId: 'wt-cancel',
        }),
      );

      expect(capturedSignal?.aborted).toBe(true);
      await executePromise;
    });

    it('resolves when nothing is in flight', async () => {
      await expect(
        Promise.resolve(
          cancelHandler({} as any, {
            projectId: 'project-d',
            worktreeId: 'wt-none',
          }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('discard', () => {
    it('deletes the map and returns its leftover artifacts', async () => {
      mockedReadSplitPrMap.mockResolvedValue(
        buildSplitPrMap({
          integrationBranch: 'split/integration',
          integrationPrNumber: 200,
          children: [
            {
              index: 1,
              title: 'refactor: a',
              type: 'refactor',
              branchName: 'split/01-a',
              baseBranch: 'split/integration',
              dependsOn: [],
              changes: [],
              prNumber: 201,
            },
            {
              index: 2,
              title: 'feat: b',
              type: 'feature',
              branchName: 'split/02-b',
              baseBranch: 'split/integration',
              dependsOn: [],
              changes: [],
            },
          ],
        }),
      );

      const result = await discardHandler({} as any, {
        projectId: 'project-discard',
        worktreeId: 'wt-discard',
      });

      expect(mockedDeleteSplitPrMap).toHaveBeenCalledWith(
        'project-discard',
        'wt-discard',
      );
      expect(result.branches).toEqual([
        'split/integration',
        'split/01-a',
        'split/02-b',
      ]);
      expect(result.prNumbers).toEqual([200, 201]);
    });

    it('returns empty artifacts when there is no map', async () => {
      mockedReadSplitPrMap.mockResolvedValue(null);

      const result = await discardHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-none',
      });

      expect(mockedDeleteSplitPrMap).toHaveBeenCalledWith(
        'project-a',
        'wt-none',
      );
      expect(result).toEqual({ branches: [], prNumbers: [] });
    });

    it('refuses while a run is in flight for the worktree', async () => {
      let releaseFirst: (() => void) | undefined;
      mockedExecutePrSplit.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseFirst = (): void =>
              resolve(buildSplitPrMap({ status: 'completed' }));
          }),
      );

      acquireSplitLock('project-inflight', 'wt-inflight');
      const firstCall = approveWorkflowHandler({} as any, {
        projectId: 'project-inflight',
        worktreeId: 'wt-inflight',
        plan: buildPlan(),
        snapshot: buildSnapshot(),
      });
      await Promise.resolve();

      await expect(
        discardHandler({} as any, {
          projectId: 'project-inflight',
          worktreeId: 'wt-inflight',
        }),
      ).rejects.toThrow(/in progress/i);
      expect(mockedDeleteSplitPrMap).not.toHaveBeenCalled();

      releaseFirst?.();
      await firstCall;
    });
  });

  describe('getSplitPrMap', () => {
    it('delegates to readSplitPrMap', async () => {
      const map = buildSplitPrMap();
      mockedReadSplitPrMap.mockResolvedValue(map);

      const result = await getMapHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });

      expect(mockedValidateId).toHaveBeenCalledWith('project-a', 'projectId');
      expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
      expect(mockedReadSplitPrMap).toHaveBeenCalledWith('project-a', 'wt-1');
      expect(result).toBe(map);
    });

    it('returns null when no map is persisted', async () => {
      mockedReadSplitPrMap.mockResolvedValue(null);

      const result = await getMapHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });

      expect(result).toBeNull();
    });
  });

  describe('invalid ids', () => {
    it('rejects plan requests with invalid ids', async () => {
      mockedValidateId.mockImplementationOnce(() => {
        throw new Error(
          'Invalid projectId: must be lowercase alphanumeric with hyphens',
        );
      });

      await expect(
        planHandler({} as any, {
          projectId: 'Bad Id',
          worktreeId: 'wt-1',
        }),
      ).rejects.toThrow(/Invalid projectId/);

      expect(mockedPlanPrSplit).not.toHaveBeenCalled();
    });

    it('rejects cancel requests with invalid ids', async () => {
      mockedValidateId.mockImplementationOnce(() => {
        throw new Error(
          'Invalid projectId: must be lowercase alphanumeric with hyphens',
        );
      });

      // Mirrors how `registerIpcHandler` wraps the (possibly synchronous)
      // handler result/throw into a promise at the real IPC boundary.
      const invoke = (): Promise<void> =>
        Promise.resolve().then(() =>
          cancelHandler({} as any, {
            projectId: 'Bad Id',
            worktreeId: 'wt-1',
          }),
        );

      await expect(invoke()).rejects.toThrow(/Invalid projectId/);
    });

    it('rejects getSplitPrMap requests with invalid ids', async () => {
      mockedValidateId.mockImplementationOnce(() => {
        throw new Error(
          'Invalid worktreeId: must be lowercase alphanumeric with hyphens',
        );
      });

      await expect(
        getMapHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'Bad Id',
        }),
      ).rejects.toThrow(/Invalid worktreeId/);

      expect(mockedReadSplitPrMap).not.toHaveBeenCalled();
    });
  });

  describe('startSplitWorkflow', () => {
    const planResponse: SplitPrPlanResponse = {
      plan: buildPlan(),
      snapshot: buildSnapshot(),
      originalPr: {
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
        baseBranch: 'main',
        headBranch: 'feature',
        headSha: 'abc123',
      },
    };

    it('acquires the lock FIRST, THEN terminates resources, THEN plans (ordering); lock held throughout', async () => {
      const calls: string[] = [];
      const destroyWorktree = jest.fn(async () => {
        // The lock must already be held while resources are torn down (the
        // guarded seams are closed up front).
        expect(isSplitLocked('project-a', 'wt-1')).toBe(true);
        calls.push('destroyBrowsers');
      });
      mockedGetBrowserService.mockReturnValue({ destroyWorktree } as any);
      mockedKillWorktreeTerminals.mockImplementation(() => {
        expect(isSplitLocked('project-a', 'wt-1')).toBe(true);
        calls.push('killTerminals');
      });
      mockedStopWorktreeScripts.mockImplementation(async () => {
        expect(isSplitLocked('project-a', 'wt-1')).toBe(true);
        calls.push('stopScripts');
      });
      mockedStopHooksForWorktree.mockImplementationOnce(async () => {
        expect(isSplitLocked('project-a', 'wt-1')).toBe(true);
        calls.push('stopHooks');
      });
      mockedPlanPrSplit.mockImplementation(async () => {
        calls.push('plan');
        expect(isSplitLocked('project-a', 'wt-1')).toBe(true);
        return planResponse;
      });

      const result = await startWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });

      expect(calls).toEqual([
        'killTerminals',
        'destroyBrowsers',
        'stopHooks',
        'stopScripts',
        'plan',
      ]);
      expect(mockedStopHooksForWorktree).toHaveBeenCalledWith({
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });
      expect(destroyWorktree).toHaveBeenCalledWith('project-a', 'wt-1', {
        clearStorage: false,
      });
      expect(result).toEqual({
        mode: 'plan',
        result: { status: 'ok', response: planResponse },
      });
      // A successful plan KEEPS the lock for the review phase.
      expect(isSplitLocked('project-a', 'wt-1')).toBe(true);
    });

    it('releases the just-acquired lock when resource termination fails', async () => {
      mockedKillWorktreeTerminals.mockImplementation(() => {
        throw new Error('terminal teardown boom');
      });

      await expect(
        startWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-1',
        }),
      ).rejects.toThrow('terminal teardown boom');
      // The lock taken before teardown must be released on the failure path.
      expect(isSplitLocked('project-a', 'wt-1')).toBe(false);
      expect(mockedPlanPrSplit).not.toHaveBeenCalled();
    });

    it('refuses with SplitStartBlockedError when a chat is active, without acquiring or terminating', async () => {
      mockedHasActiveChatTurns.mockReturnValue(true);
      mockedHasActiveChatWork.mockReturnValue(true);

      await expect(
        startWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-1',
        }),
      ).rejects.toBeInstanceOf(SplitStartBlockedError);
      expect(isSplitLocked('project-a', 'wt-1')).toBe(false);
      expect(mockedKillWorktreeTerminals).not.toHaveBeenCalled();
      expect(mockedPlanPrSplit).not.toHaveBeenCalled();
    });

    it('blocks Split PR while a background Agent runs without a foreground turn', async () => {
      mockedHasActiveChatWork.mockReturnValue(true);
      mockedHasActiveChatTurns.mockReturnValue(false);
      await expect(
        startWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-1',
        }),
      ).rejects.toBeInstanceOf(SplitStartBlockedError);
      expect(isSplitLocked('project-a', 'wt-1')).toBe(false);
      expect(mockedKillWorktreeTerminals).not.toHaveBeenCalled();
      expect(mockedPlanPrSplit).not.toHaveBeenCalled();
    });

    it('refuses while a Git action is active, without acquiring or terminating', async () => {
      const request = {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        operationId: 'git-action-1',
      };
      const scope = beginGitActionCancellationScope(request);
      try {
        await expect(
          startWorkflowHandler({} as any, {
            projectId: 'project-a',
            worktreeId: 'wt-1',
          }),
        ).rejects.toBeInstanceOf(SplitStartBlockedError);
        expect(isSplitLocked('project-a', 'wt-1')).toBe(false);
        expect(mockedKillWorktreeTerminals).not.toHaveBeenCalled();
        expect(mockedPlanPrSplit).not.toHaveBeenCalled();
      } finally {
        finishGitActionCancellationScope(request, scope);
      }
    });

    it('refuses with SplitStartBlockedError when a pipeline is running for the worktree', async () => {
      mockedListExecutionSummaries.mockResolvedValue([
        {
          id: 'exec-1',
          project_id: 'project-a',
          worktree_id: 'wt-1',
          status: 'running',
        } as any,
      ]);

      await expect(
        startWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-1',
        }),
      ).rejects.toBeInstanceOf(SplitStartBlockedError);
      expect(isSplitLocked('project-a', 'wt-1')).toBe(false);
      expect(mockedPlanPrSplit).not.toHaveBeenCalled();
    });

    it('refuses with SplitStartBlockedError when a pipeline is paused for the worktree', async () => {
      mockedListExecutionSummaries.mockResolvedValue([
        {
          id: 'exec-1',
          project_id: 'project-a',
          worktree_id: 'wt-1',
          status: 'paused',
        } as any,
      ]);

      await expect(
        startWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-1',
        }),
      ).rejects.toBeInstanceOf(SplitStartBlockedError);
      expect(isSplitLocked('project-a', 'wt-1')).toBe(false);
      expect(mockedPlanPrSplit).not.toHaveBeenCalled();
    });

    it('proceeds when a running pipeline belongs to a DIFFERENT worktree', async () => {
      mockedListExecutionSummaries.mockResolvedValue([
        {
          id: 'exec-1',
          project_id: 'project-a',
          worktree_id: 'wt-other',
          status: 'running',
        } as any,
      ]);
      mockedPlanPrSplit.mockResolvedValue(planResponse);

      const result = await startWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });

      expect(result).toEqual({
        mode: 'plan',
        result: { status: 'ok', response: planResponse },
      });
      expect(isSplitLocked('project-a', 'wt-1')).toBe(true);
    });

    it('broadcasts a locked lock event on acquire', async () => {
      mockedPlanPrSplit.mockResolvedValue(planResponse);
      await startWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });
      expect(windowSend).toHaveBeenCalledWith(
        IPC_CHANNELS.githubSplitLockEvent,
        { workspaceId: 'project-a', worktreeId: 'wt-1', locked: true },
      );
    });

    it('releases the lock when the plan is refused', async () => {
      mockedPlanPrSplit.mockRejectedValue(
        new PrSplitPlanningError('no_open_pr', 'No open PR for this worktree.'),
      );

      const result = await startWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });

      expect(result).toEqual({
        mode: 'plan',
        result: {
          status: 'refused',
          code: 'no_open_pr',
          message: 'No open PR for this worktree.',
        },
      });
      expect(isSplitLocked('project-a', 'wt-1')).toBe(false);
      expect(windowSend).toHaveBeenCalledWith(
        IPC_CHANNELS.githubSplitLockEvent,
        { workspaceId: 'project-a', worktreeId: 'wt-1', locked: false },
      );
    });

    it('releases the lock and rethrows on an unexpected plan throw', async () => {
      mockedPlanPrSplit.mockRejectedValue(new Error('kaboom'));

      await expect(
        startWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-1',
        }),
      ).rejects.toThrow('kaboom');
      expect(isSplitLocked('project-a', 'wt-1')).toBe(false);
    });

    it('refuses a second concurrent start while already locked', async () => {
      acquireSplitLock('project-a', 'wt-1');
      mockedPlanPrSplit.mockResolvedValue(planResponse);

      await expect(
        startWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-1',
        }),
      ).rejects.toBeInstanceOf(SplitLockError);
      // The original lock is preserved (not released by the failed acquire).
      expect(isSplitLocked('project-a', 'wt-1')).toBe(true);
      expect(mockedPlanPrSplit).not.toHaveBeenCalled();
    });

    describe("mode: 'resume'", () => {
      // Distinct worktree ids so the module-level abort-controller map never
      // collides with the shared `wt-1` used by the plan-mode tests above.
      afterEach(() => {
        releaseSplitLock('project-a', 'wt-res-1');
        releaseSplitLock('project-a', 'wt-res-2');
        releaseSplitLock('project-a', 'wt-res-3');
        releaseSplitLock('project-a', 'wt-rev-1');
      });

      it('skips planning, executes the stored plan under the lock, and releases on success', async () => {
        const map = buildSplitPrMap({ status: 'completed' });
        mockedExecutePrSplit.mockResolvedValue(map);

        const result = await startWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-res-1',
          mode: 'resume',
          plan: buildPlan(),
          snapshot: buildSnapshot(),
        });

        expect(mockedPlanPrSplit).not.toHaveBeenCalled();
        expect(mockedExecutePrSplit).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
          mode: 'resume',
          result: { status: 'ok', map },
        });
        // Resume releases the lock on settle, exactly like approve.
        expect(isSplitLocked('project-a', 'wt-res-1')).toBe(false);
      });

      it('maps a classified execute failure to a failed envelope and releases the lock', async () => {
        mockedExecutePrSplit.mockRejectedValue(
          new SplitPrExecutionError('carve failed', { childIndex: 2 }),
        );

        const result = await startWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-res-2',
          mode: 'resume',
          plan: buildPlan(),
          snapshot: buildSnapshot(),
        });

        expect(result).toEqual({
          mode: 'resume',
          result: { status: 'failed', message: 'carve failed', childIndex: 2 },
        });
        expect(isSplitLocked('project-a', 'wt-res-2')).toBe(false);
      });

      it('releases the lock and throws when resume is called without a stored plan', async () => {
        await expect(
          startWorkflowHandler({} as any, {
            projectId: 'project-a',
            worktreeId: 'wt-res-3',
            mode: 'resume',
          }),
        ).rejects.toThrow(/without a stored plan/);
        expect(mockedExecutePrSplit).not.toHaveBeenCalled();
        expect(isSplitLocked('project-a', 'wt-res-3')).toBe(false);
      });
    });

    describe("mode: 'review'", () => {
      afterEach(() => {
        releaseSplitLock('project-a', 'wt-rev-1');
      });

      it('skips planning and KEEPS the lock, returning a locked result', async () => {
        const result = await startWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-rev-1',
          mode: 'review',
        });

        expect(mockedPlanPrSplit).not.toHaveBeenCalled();
        expect(mockedExecutePrSplit).not.toHaveBeenCalled();
        expect(result).toEqual({
          mode: 'review',
          result: { status: 'locked' },
        });
        // Review holds the lock until approve/exit settles it.
        expect(isSplitLocked('project-a', 'wt-rev-1')).toBe(true);
      });
    });
  });

  describe('approveSplitWorkflow', () => {
    // Distinct worktree ids per test so the module-level abort-controller map
    // (keyed projectId:worktreeId) never collides across tests.
    afterEach(() => {
      releaseSplitLock('project-a', 'wt-appr-1');
      releaseSplitLock('project-a', 'wt-appr-2');
      releaseSplitLock('project-a', 'wt-appr-3');
      releaseSplitLock('project-a', 'wt-appr-4');
      releaseSplitLock('project-a', 'wt-appr-5');
    });

    it('throws a typed lock error when the worktree is not locked', async () => {
      await expect(
        approveWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-appr-1',
          plan: buildPlan(),
          snapshot: buildSnapshot(),
        }),
      ).rejects.toBeInstanceOf(SplitLockError);
      expect(mockedExecutePrSplit).not.toHaveBeenCalled();
    });

    it('runs executePrSplit and releases the lock on success', async () => {
      acquireSplitLock('project-a', 'wt-appr-2');
      const map = buildSplitPrMap({ status: 'completed' });
      mockedExecutePrSplit.mockResolvedValue(map);

      const result = await approveWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-appr-2',
        plan: buildPlan(),
        snapshot: buildSnapshot(),
      });

      expect(result).toEqual({ status: 'ok', map });
      expect(isSplitLocked('project-a', 'wt-appr-2')).toBe(false);
    });

    it('releases the lock on a classified failure envelope', async () => {
      acquireSplitLock('project-a', 'wt-appr-3');
      mockedExecutePrSplit.mockRejectedValue(
        new SplitPrExecutionError('carve failed', { childIndex: 1 }),
      );

      const result = await approveWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-appr-3',
        plan: buildPlan(),
        snapshot: buildSnapshot(),
      });

      expect(result).toEqual({
        status: 'failed',
        message: 'carve failed',
        childIndex: 1,
      });
      expect(isSplitLocked('project-a', 'wt-appr-3')).toBe(false);
    });

    it('releases the lock on a cancelled (ok) settle', async () => {
      acquireSplitLock('project-a', 'wt-appr-4');
      mockedExecutePrSplit.mockResolvedValue(
        buildSplitPrMap({ status: 'cancelled' }),
      );

      await approveWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-appr-4',
        plan: buildPlan(),
        snapshot: buildSnapshot(),
      });

      expect(isSplitLocked('project-a', 'wt-appr-4')).toBe(false);
    });

    it('releases the lock and rethrows on an unexpected error', async () => {
      acquireSplitLock('project-a', 'wt-appr-5');
      mockedExecutePrSplit.mockRejectedValue(new Error('unexpected'));

      await expect(
        approveWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-appr-5',
          plan: buildPlan(),
          snapshot: buildSnapshot(),
        }),
      ).rejects.toThrow('unexpected');
      expect(isSplitLocked('project-a', 'wt-appr-5')).toBe(false);
    });
  });

  describe('exitSplitWorkflow', () => {
    afterEach(() => {
      releaseSplitLock('project-a', 'wt-exit-1');
      releaseSplitLock('project-a', 'wt-exit-2');
      releaseSplitLock('project-a', 'wt-exit-late');
    });

    it('releases the lock and broadcasts on exit', () => {
      acquireSplitLock('project-a', 'wt-exit-1');
      windowSend.mockClear();

      exitWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-exit-1',
      });

      expect(isSplitLocked('project-a', 'wt-exit-1')).toBe(false);
      expect(windowSend).toHaveBeenCalledWith(
        IPC_CHANNELS.githubSplitLockEvent,
        { workspaceId: 'project-a', worktreeId: 'wt-exit-1', locked: false },
      );
    });

    it('does not resurrect a cleared projection from late terminal events', async () => {
      let emitProgress: ((event: SplitPrProgressEvent) => void) | undefined;
      let settleExecution: (() => void) | undefined;
      mockedExecutePrSplit.mockImplementation(
        (options) =>
          new Promise((resolve) => {
            emitProgress = options.onProgress;
            settleExecution = (): void => {
              resolve(buildSplitPrMap({ status: 'cancelled' }));
            };
          }),
      );
      acquireSplitLock('project-a', 'wt-exit-late');
      const execution = approveWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-exit-late',
        plan: buildPlan(),
        snapshot: buildSnapshot(),
      });
      await Promise.resolve();

      exitWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-exit-late',
      });
      emitProgress?.({
        projectId: 'project-a',
        worktreeId: 'wt-exit-late',
        phase: 'cancelled',
      });
      emitProgress?.({
        projectId: 'project-a',
        worktreeId: 'wt-exit-late',
        phase: 'error',
        error: 'late failure',
      });

      expect(
        getSplitPrRuntimeProjection('project-a', 'wt-exit-late'),
      ).toBeUndefined();
      settleExecution?.();
      await execution;
    });

    it('is a safe no-op when the worktree is not locked', () => {
      expect(() =>
        exitWorkflowHandler({} as any, {
          projectId: 'project-a',
          worktreeId: 'wt-exit-2',
        }),
      ).not.toThrow();
      expect(isSplitLocked('project-a', 'wt-exit-2')).toBe(false);
    });
  });

  describe('getSplitLockState (hydration)', () => {
    afterEach(() => {
      releaseSplitLock('project-a', 'wt-hydrate-1');
      releaseSplitLock('project-a', 'wt-hydrate-2');
      releaseSplitLock('project-a', 'wt-hydrate-exec');
    });

    it('returns the currently held locks with executing:false for plan/review-phase locks', () => {
      acquireSplitLock('project-a', 'wt-hydrate-1');
      acquireSplitLock('project-a', 'wt-hydrate-2');

      const response = lockStateHandler({} as any);

      expect(response.locked).toContainEqual({
        workspaceId: 'project-a',
        worktreeId: 'wt-hydrate-1',
        executing: false,
      });
      expect(response.locked).toContainEqual({
        workspaceId: 'project-a',
        worktreeId: 'wt-hydrate-2',
        executing: false,
      });
    });

    it('reports executing:true for a lock whose split execute is in flight', async () => {
      acquireSplitLock('project-a', 'wt-hydrate-exec');
      let resolveExecute: (map: SplitPrMap) => void = () => {};
      mockedExecutePrSplit.mockReturnValue(
        new Promise<SplitPrMap>((resolve) => {
          resolveExecute = resolve;
        }),
      );
      const approvePromise = approveWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-hydrate-exec',
        plan: buildPlan(),
        snapshot: buildSnapshot(),
      });
      // Let the handler register its abort controller before probing.
      await Promise.resolve();

      const response = lockStateHandler({} as any);
      expect(response.locked).toContainEqual({
        workspaceId: 'project-a',
        worktreeId: 'wt-hydrate-exec',
        executing: true,
      });

      resolveExecute(buildSplitPrMap({ status: 'completed' }));
      await approvePromise;
    });
  });

  describe('releaseIdleSplitLocksForRendererLifecycle', () => {
    // Covers the seam the main window's render-process-gone / did-navigate
    // listeners call. Handler-level simulation: acquire locks, drive an execute
    // in flight through the approve handler, then invoke the exported helper the
    // lifecycle listeners call and assert only the idle lock is released.
    afterEach(() => {
      releaseSplitLock('project-a', 'wt-life-idle');
      releaseSplitLock('project-a', 'wt-life-busy');
    });

    it('releases a lock held in plan-review (no execute in flight) and broadcasts', () => {
      acquireSplitLock('project-a', 'wt-life-idle');
      windowSend.mockClear();

      const released = releaseIdleSplitLocksForRendererLifecycle();

      expect(released).toBe(1);
      expect(isSplitLocked('project-a', 'wt-life-idle')).toBe(false);
      expect(windowSend).toHaveBeenCalledWith(
        IPC_CHANNELS.githubSplitLockEvent,
        {
          workspaceId: 'project-a',
          worktreeId: 'wt-life-idle',
          locked: false,
        },
      );
    });

    it('keeps a lock whose split execute is in flight (survives the reload)', async () => {
      acquireSplitLock('project-a', 'wt-life-busy');

      // Hang the execute so its abort controller stays registered (in-flight)
      // while we run the lifecycle release.
      let resolveExecute: (map: SplitPrMap) => void = () => {};
      mockedExecutePrSplit.mockReturnValue(
        new Promise<SplitPrMap>((resolve) => {
          resolveExecute = resolve;
        }),
      );

      const approvePromise = approveWorkflowHandler({} as any, {
        projectId: 'project-a',
        worktreeId: 'wt-life-busy',
        plan: buildPlan(),
        snapshot: buildSnapshot(),
      });
      // Let the handler register its abort controller before we probe.
      await Promise.resolve();

      const released = releaseIdleSplitLocksForRendererLifecycle();

      expect(released).toBe(0);
      expect(isSplitLocked('project-a', 'wt-life-busy')).toBe(true);

      // Settle the execute so approve's finally releases the lock and cleans up.
      resolveExecute(buildSplitPrMap({ status: 'completed' }));
      await approvePromise;
      expect(isSplitLocked('project-a', 'wt-life-busy')).toBe(false);
    });
  });
});
