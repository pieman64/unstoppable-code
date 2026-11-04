import {
  IPC_CHANNELS,
  type SidebarItem,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type {
  PersistedPrSnapshotFileV1,
  PrStatusData,
  PrStatusEvent,
  RepoPrTrackingData,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type { BrowserWindow } from 'electron';
import type * as GitHubPollerModule from '../lib/github-poller';
import type * as GitHubModule from '../lib/github-pr';
import type * as AppAdvisorWatchersModule from '../app-advisor/watchers';
import type * as CredentialModule from '../lib/github-preview-credential';
import type * as HookStateModule from '../lib/github-pr-hook-state';
import type {
  BranchPullRequestLookup,
  PullRequestSweptEvent,
  SweptPullRequest,
} from '../lib/github-pr-sweep';
import type { GitHubRefreshLedgerEntry } from '../lib/github-refresh-ledger';
import type * as GitHubRefreshLedgerModule from '../lib/github-refresh-ledger';

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ scriptTimeoutMinutes: 5 }),
  ),
}));
jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn(() => Promise.resolve('feature-1')),
}));
jest.mock('../lib/github-pr', () => ({
  fetchRepoPrTrackingData: jest.fn(() =>
    Promise.resolve({
      status: null,
      snapshot: null,
      branchName: 'feature-1',
      remote: null,
    }),
  ),
  fetchTrackedPullRequestData: jest.fn(),
  resolveGitHubRemoteForRepo: jest.fn(() =>
    Promise.resolve({ owner: 'acme', repo: 'repo' }),
  ),
  reusablePrGraphQlState: jest.fn((previous: RepoPrTrackingData) => ({
    unresolvedReviewThreadCount: previous.status?.unresolvedReviewThreadCount,
    mergeQueue: previous.status?.mergeQueue,
    mergeQueueSnapshot: previous.snapshot?.mergeQueue,
  })),
}));
jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(() => ({ enqueue: jest.fn() })),
}));
const mockFetchPullRequestSweep = jest.fn();
jest.mock('../lib/github-pr-sweep', () => ({
  ...jest.requireActual<object>('../lib/github-pr-sweep'),
  fetchPullRequestSweep: (...args: unknown[]): unknown =>
    mockFetchPullRequestSweep(...args),
}));
let mockCloudGeneration = 0;
let mockBrokerGeneration = 0;
let mockUseActualCredential = false;
type MockAccountRead =
  | { status: 'ok'; entry: null }
  | { status: 'unavailable' }
  | { status: 'error'; error: Error };
let mockAccountRead: MockAccountRead = { status: 'ok', entry: null };
const mockResolveGitHubToken = jest.fn(
  (): Promise<{ token: string; source: 'pat' | 'gh-cli' } | null> =>
    Promise.resolve({ token: 'ghp_test', source: 'pat' }),
);
jest.mock('../lib/github-auth', () => ({
  resolveGitHubTokenWithSource: mockResolveGitHubToken,
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<MockAccountRead> =>
    Promise.resolve(mockAccountRead),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));
jest.mock('../lib/github-preview-credential', () => {
  const actual = jest.requireActual<typeof CredentialModule>(
    '../lib/github-preview-credential',
  );
  const readGitHubPreviewCredential = jest.fn(
    (): Promise<{ token: string; scope: string } | null> =>
      mockUseActualCredential
        ? actual.readGitHubPreviewCredential()
        : Promise.resolve({ token: 'ghp_test', scope: 'account-credential' }),
  );
  return {
    ...actual,
    readGitHubPreviewCredential,
    readGitHubTrackingCredential: async (): ReturnType<
      typeof CredentialModule.readGitHubTrackingCredential
    > => {
      if (mockUseActualCredential) return actual.readGitHubTrackingCredential();
      const credential = await readGitHubPreviewCredential();
      return (
        credential && {
          ...credential,
          authenticationScope: actual.githubTrackingCredentialScope(
            credential.token,
          ),
        }
      );
    },
    getCloudAccountIdentityGeneration: jest.fn(() => mockCloudGeneration),
  };
});
jest.mock('../lib/github-broker', () => ({
  getGitHubBroker: jest.fn(() => ({
    getCredentialGeneration: (): number => mockBrokerGeneration,
  })),
}));
jest.mock('../lib/github-pr-hook-state', () => ({
  advancePrTrackingState: jest.fn(() =>
    Promise.resolve({
      triggers: [],
      currentSnapshot: null,
      currentSnapshotPath: '/tmp/current.json',
      previousSnapshotPath: '/tmp/previous.json',
    }),
  ),
  getProjectRepoStorageKey: jest.fn(() => 'project-root'),
  getWorkspaceRepoStorageKey: jest.fn((repoId: string) => repoId),
  getWorkspaceRootRepoStorageKey: jest.fn(() => '__workspace_root__'),
}));
jest.mock('../lib/hook-resolver', () => ({
  getResolvedHookActions: jest.fn(() => null),
  resolveProjectHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRepoHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRootHooks: jest.fn(() => Promise.resolve({})),
}));
jest.mock('../lib/hook-runner', () => ({
  runHook: jest.fn(() =>
    Promise.resolve({
      success: true,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 0,
    }),
  ),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(() =>
    Promise.resolve({
      version: 1,
      type: 'single-repo',
      repos: [],
      alwaysShow: true,
    }),
  ),
  readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
  updateWorkspaceWorktree: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../lib/pr-status-change-emitter', () => ({
  emitWorktreePrStatusChange: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));
type AppAdvisorWatcherService = ReturnType<
  typeof AppAdvisorWatchersModule.getAppAdvisorWatcherService
>;
type AppAdvisorWatcherList = ReturnType<AppAdvisorWatcherService['list']>;
const mockListAppAdvisorWatchers = jest.fn<
  AppAdvisorWatcherList,
  Parameters<AppAdvisorWatcherService['list']>
>(() => Promise.resolve([]));
const mockHandleHookTriggeredEvent = jest.fn();
type ReadGitHubRefreshLedgerEntry =
  typeof GitHubRefreshLedgerModule.readGitHubRefreshLedgerEntry;
const mockReadGitHubRefreshLedgerEntry = jest.fn<
  ReturnType<ReadGitHubRefreshLedgerEntry>,
  Parameters<ReadGitHubRefreshLedgerEntry>
>(() => Promise.resolve(null));
const mockRecordGitHubRefreshAttempt = jest.fn(() => Promise.resolve());
type RecordGitHubRefreshSuccess =
  typeof GitHubRefreshLedgerModule.recordGitHubRefreshSuccess;
const mockRecordGitHubRefreshSuccess = jest.fn<
  ReturnType<RecordGitHubRefreshSuccess>,
  Parameters<RecordGitHubRefreshSuccess>
>(() => Promise.resolve());
const mockRecordGitHubRefreshFailure = jest.fn(
  (args: { failedAt: number }): Promise<GitHubRefreshLedgerEntry> =>
    Promise.resolve({
      retryAfterAt: new Date(args.failedAt + 2_000).toISOString(),
      consecutiveFailures: 1,
    }),
);
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    list: mockListAppAdvisorWatchers,
    handleHookTriggeredEvent: mockHandleHookTriggeredEvent,
  })),
}));
jest.mock('../lib/github-refresh-ledger', () => ({
  readGitHubRefreshLedgerEntry: mockReadGitHubRefreshLedgerEntry,
  recordGitHubRefreshAttempt: mockRecordGitHubRefreshAttempt,
  recordGitHubRefreshSuccess: mockRecordGitHubRefreshSuccess,
  recordGitHubRefreshFailure: mockRecordGitHubRefreshFailure,
}));

/** Built from the poller's module registry so `instanceof` checks match. */
async function refusal(retryAt: number, resource: string): Promise<Error> {
  const { GitHubBrokerError } = await import('../lib/github-broker/errors');
  return new GitHubBrokerError('rate_limited', 'Background reads are paused.', {
    retriable: true,
    retryAt,
    resource,
  });
}

function sweepResult(
  kind: 'none' | 'unresolved',
): (
  client: unknown,
  remote: unknown,
  branches: readonly string[],
) => Promise<Map<string, BranchPullRequestLookup>> {
  return (_client, _remote, branches) =>
    Promise.resolve(
      new Map(
        branches.map((branch): [string, BranchPullRequestLookup] => [
          branch,
          { kind },
        ]),
      ),
    );
}

function createWindow(isFocused: () => boolean = () => false): BrowserWindow {
  const window = jest.createMockFromModule<BrowserWindow>('electron');
  Object.assign(window, {
    isDestroyed: (): boolean => false,
    isFocused,
    webContents: {
      send: jest.fn(),
      isDestroyed: (): boolean => false,
      isCrashed: (): boolean => false,
      mainFrame: { isDestroyed: (): boolean => false, detached: false },
    },
  });
  return window;
}

async function importFreshPoller(): Promise<{
  poller: typeof GitHubPollerModule;
  mockedFetchRepoPrTrackingData: jest.MockedFunction<
    typeof GitHubModule.fetchRepoPrTrackingData
  >;
}> {
  jest.resetModules();
  const poller = await import('../lib/github-poller');
  importedPollers.push(poller);
  const githubPr = await import('../lib/github-pr');
  return {
    poller,
    mockedFetchRepoPrTrackingData: jest.mocked(
      githubPr.fetchRepoPrTrackingData,
    ),
  };
}

const importedPollers: Array<typeof GitHubPollerModule> = [];

async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => {
    throw new Error('Deferred promise resolver was not initialized');
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createTrackedItem(args: {
  projectId: string;
  worktreeId: string;
  lastKnownPrStatus?: PrStatusEvent['status'];
}): SidebarItem {
  return {
    type: 'single-repo',
    id: args.projectId,
    name: args.projectId,
    repoPath: `/mock/repos/${args.projectId}`,
    color: '#123456',
    worktrees: [
      {
        id: args.worktreeId,
        branchName: args.worktreeId,
        createdAt: '2026-04-16T00:00:00.000Z',
        lastKnownPrStatus: args.lastKnownPrStatus,
      },
    ],
    collapsed: false,
    order: 0,
  };
}

function createPrSnapshot(): PersistedPrSnapshotFileV1 {
  return {
    version: 1,
    provider: 'github',
    capturedAt: '2026-04-09T00:00:00.000Z',
    includesComments: true,
    includesReviews: true,
    includesReviewComments: true,
    repository: {
      owner: 'acme',
      name: 'repo',
      fullName: 'acme/repo',
    },
    branch: {
      currentName: 'feature-1',
      headRefName: 'feature-1',
      baseRefName: 'main',
      headSha: 'head',
      baseSha: 'base',
    },
    pr: {
      id: 100,
      number: 42,
      nodeId: 'PR_node',
      htmlUrl: 'https://github.com/acme/repo/pull/42',
      apiUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
      state: 'open',
      isDraft: false,
      title: 'PR',
      body: '',
      author: null,
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
      mergedAt: null,
      closedAt: null,
      mergeCommitSha: null,
      mergedBy: null,
      isCrossRepository: false,
      labels: [],
      assignees: [],
      requestedReviewers: [],
    },
    issueComments: [],
    reviews: [],
    reviewComments: [],
  };
}

async function advanceUntilCallCount(
  mockFn: { mock: { calls: unknown[][] } },
  expectedCalls: number,
  stepMs = 1_000,
  maxSteps = 40,
): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    if (mockFn.mock.calls.length >= expectedCalls) {
      return;
    }
    await jest.advanceTimersByTimeAsync(stepMs);
    await flushMicrotasks();
  }
}

function isPrStatusEventCall(
  value: unknown[],
): value is [string, PrStatusEvent] {
  if (value.length < 2) {
    return false;
  }

  return value[0] === IPC_CHANNELS.githubPrStatusEvent;
}

describe('github-poller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    jest.clearAllMocks();
    mockCloudGeneration = 0;
    mockBrokerGeneration = 0;
    mockUseActualCredential = false;
    mockAccountRead = { status: 'ok', entry: null };
    mockResolveGitHubToken.mockResolvedValue({
      token: 'ghp_test',
      source: 'pat',
    });
    mockRecordGitHubRefreshFailure.mockImplementation((args) =>
      Promise.resolve({
        retryAfterAt: new Date(args.failedAt + 2_000).toISOString(),
        consecutiveFailures: 1,
      }),
    );
    mockListAppAdvisorWatchers.mockResolvedValue([]);
    mockHandleHookTriggeredEvent.mockResolvedValue(undefined);
    mockFetchPullRequestSweep.mockImplementation(sweepResult('none'));
  });

  afterEach(() => {
    for (const poller of importedPollers.splice(0)) {
      poller.stopPolling();
    }
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  describe.each([
    { status: 'unavailable', source: 'pat' },
    { status: 'error', source: 'pat' },
    { status: 'unavailable', source: 'gh-cli' },
    { status: 'error', source: 'gh-cli' },
  ] as const)(
    'degraded account $status with $source authentication',
    ({ status, source }) => {
      beforeEach(() => {
        mockUseActualCredential = true;
        mockAccountRead =
          status === 'unavailable'
            ? { status }
            : { status, error: new Error('Account decryption failed') };
        mockResolveGitHubToken.mockResolvedValue({
          token: 'ghp_degraded',
          source,
        });
      });

      async function prepareTracking(): Promise<{
        poller: typeof GitHubPollerModule;
        mockedFetchRepoPrTrackingData: jest.MockedFunction<
          typeof GitHubModule.fetchRepoPrTrackingData
        >;
        hookState: typeof HookStateModule;
      }> {
        const { poller, mockedFetchRepoPrTrackingData } =
          await importFreshPoller();
        const hookState = await import('../lib/github-pr-hook-state');
        const snapshot = createPrSnapshot();
        mockedFetchRepoPrTrackingData.mockResolvedValue({
          status: {
            prNumber: 42,
            prUrl: snapshot.pr.htmlUrl,
            state: 'open',
            title: 'PR',
            checkStatus: 'passing',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-04-16T00:00:00.000Z',
          },
          snapshot,
          branchName: 'feature-1',
          remote: { owner: 'acme', repo: 'repo' },
        });
        jest.mocked(hookState.advancePrTrackingState).mockResolvedValue({
          triggers: ['pr:create'],
          currentSnapshot: snapshot,
          currentSnapshotPath: '/tmp/current.json',
          previousSnapshotPath: '/tmp/previous.json',
        });
        return { poller, mockedFetchRepoPrTrackingData, hookState };
      }

      function expectUnscopedTracking(hookState: typeof HookStateModule): void {
        expect(hookState.advancePrTrackingState).toHaveBeenCalledTimes(1);
        const snapshot = jest.mocked(hookState.advancePrTrackingState).mock
          .calls[0]?.[0].currentSnapshot;
        expect(snapshot).toBeTruthy();
        expect(snapshot?.credentialScope).toBeUndefined();
        expect(mockHandleHookTriggeredEvent).toHaveBeenCalledTimes(1);
        expect(mockRecordGitHubRefreshSuccess).toHaveBeenCalledTimes(1);
        expect(mockRecordGitHubRefreshFailure).not.toHaveBeenCalled();
      }

      it('refreshes interactively and dispatches hooks without preview provenance', async () => {
        const { poller, mockedFetchRepoPrTrackingData, hookState } =
          await prepareTracking();
        const result = await poller.refreshNow('project-a', 'worktree-a');
        expect(result?.repos[0]?.status?.prNumber).toBe(42);
        expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledWith(
          expect.any(String),
          'feature-1',
          expect.objectContaining({ authenticationToken: 'ghp_degraded' }),
        );
        expectUnscopedTracking(hookState);
        const identity = jest.requireActual<typeof CredentialModule>(
          '../lib/github-preview-credential',
        );
        expect(await identity.readGitHubPreviewCredential()).toBeNull();
      });

      it('sweeps and dispatches hooks without preview provenance', async () => {
        const { poller, mockedFetchRepoPrTrackingData, hookState } =
          await prepareTracking();
        mockFetchPullRequestSweep.mockImplementation(sweepResult('unresolved'));
        poller.startPolling(() => createWindow());
        poller.requestRefresh('project-a', 'worktree-a');
        await jest.advanceTimersByTimeAsync(35_000);
        await flushMicrotasks(30);
        expect(mockFetchPullRequestSweep).toHaveBeenCalledTimes(1);
        expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledWith(
          expect.any(String),
          'feature-1',
          expect.objectContaining({
            authenticationToken: 'ghp_degraded',
            priority: 'normal',
          }),
        );
        expectUnscopedTracking(hookState);
      });
    },
  );

  it('refreshes a non-GitHub repository without resolving credentials', async () => {
    const { poller } = await importFreshPoller();
    const identity = await import('../lib/github-preview-credential');
    const pr = await import('../lib/github-pr');
    jest.mocked(identity.readGitHubPreviewCredential).mockResolvedValue(null);
    jest.mocked(pr.resolveGitHubRemoteForRepo).mockResolvedValue(null);
    const result = await poller.refreshNow('project-a', 'worktree-a');
    expect(result?.repos[0]?.prLookupAvailable).toBe(false);
    expect(identity.readGitHubPreviewCredential).not.toHaveBeenCalled();
    expect(mockRecordGitHubRefreshSuccess).toHaveBeenCalledTimes(1);
  });

  it('records missing-credential sweep failures and honors their backoff', async () => {
    const { poller } = await importFreshPoller();
    const identity = await import('../lib/github-preview-credential');
    jest.mocked(identity.readGitHubPreviewCredential).mockResolvedValue(null);
    mockRecordGitHubRefreshFailure.mockImplementation((args) =>
      Promise.resolve({
        retryAfterAt: new Date(args.failedAt + 10 * 60_000).toISOString(),
        consecutiveFailures: 1,
      }),
    );
    poller.startPolling(() => createWindow());
    poller.requestRefresh('project-a', 'worktree-a');
    await jest.advanceTimersByTimeAsync(35_000);
    await flushMicrotasks(30);
    expect(mockRecordGitHubRefreshFailure).toHaveBeenCalledTimes(1);
    expect(mockFetchPullRequestSweep).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks(30);
    expect(identity.readGitHubPreviewCredential).toHaveBeenCalledTimes(1);
    expect(mockRecordGitHubRefreshFailure).toHaveBeenCalledTimes(1);
  });

  it('passes verified observation scope when an interactive read sees no PR', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const hookState = await import('../lib/github-pr-hook-state');
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
      snapshot: null,
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'repo' },
    });
    await poller.refreshNow('project-a', 'worktree-a');
    expect(hookState.advancePrTrackingState).toHaveBeenCalledWith(
      expect.objectContaining({
        currentSnapshot: null,
        credentialScope: 'account-credential',
      }),
    );
  });

  it('preflights every repository identity before committing any hook snapshot', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const registry = await import('../lib/workspace-registry');
    const entries = await import('../lib/worktree-repo-entries');
    const hookState = await import('../lib/github-pr-hook-state');
    const identity = await import('../lib/github-preview-credential');
    jest.mocked(registry.isMultiRepoWorkspace).mockReturnValue(true);
    jest.mocked(entries.listWorkspaceWorktreeRepoEntries).mockResolvedValue([
      { repoId: 'first', repoName: 'First', repoPath: '/mock/first' },
      { repoId: 'second', repoName: 'Second', repoPath: '/mock/second' },
    ]);
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
      snapshot: createPrSnapshot(),
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'repo' },
    });
    jest
      .mocked(identity.readGitHubPreviewCredential)
      .mockResolvedValueOnce({ token: 'ghp_test', scope: 'account-credential' })
      .mockResolvedValueOnce({ token: 'ghp_test', scope: 'account-credential' })
      .mockRejectedValueOnce(new Error('Account read unavailable'));
    await expect(poller.refreshNow('project-a', 'worktree-a')).rejects.toThrow(
      'Account read unavailable',
    );
    expect(hookState.advancePrTrackingState).not.toHaveBeenCalled();
    expect(mockHandleHookTriggeredEvent).not.toHaveBeenCalled();
  });

  it('delivers accepted hook transitions when identity changes between repository commits', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const registry = await import('../lib/workspace-registry');
    const entries = await import('../lib/worktree-repo-entries');
    const hookState = await import('../lib/github-pr-hook-state');
    jest.mocked(registry.isMultiRepoWorkspace).mockReturnValue(true);
    jest.mocked(entries.listWorkspaceWorktreeRepoEntries).mockResolvedValue([
      { repoId: 'first', repoName: 'First', repoPath: '/mock/first' },
      { repoId: 'second', repoName: 'Second', repoPath: '/mock/second' },
    ]);
    const snapshot = createPrSnapshot();
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
      snapshot,
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'repo' },
    });
    jest.mocked(hookState.advancePrTrackingState).mockImplementationOnce(() => {
      mockBrokerGeneration += 1;
      return Promise.resolve({
        triggers: ['pr:create'],
        currentSnapshot: snapshot,
        currentSnapshotPath: '/tmp/current.json',
        previousSnapshotPath: '/tmp/previous.json',
      });
    });
    await expect(poller.refreshNow('project-a', 'worktree-a')).rejects.toThrow(
      'identity changed',
    );
    expect(hookState.advancePrTrackingState).toHaveBeenCalledTimes(1);
    expect(mockHandleHookTriggeredEvent).toHaveBeenCalledTimes(1);
  });

  it('starts hooks earlier repositories accepted when a later repository cannot advance', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const registry = await import('../lib/workspace-registry');
    const entries = await import('../lib/worktree-repo-entries');
    const hookState = await import('../lib/github-pr-hook-state');
    jest.mocked(registry.isMultiRepoWorkspace).mockReturnValue(true);
    jest.mocked(entries.listWorkspaceWorktreeRepoEntries).mockResolvedValue([
      { repoId: 'first', repoName: 'First', repoPath: '/mock/first' },
      { repoId: 'second', repoName: 'Second', repoPath: '/mock/second' },
    ]);
    const snapshot = createPrSnapshot();
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
      snapshot,
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'repo' },
    });
    jest
      .mocked(hookState.advancePrTrackingState)
      .mockResolvedValueOnce({
        triggers: ['pr:create'],
        currentSnapshot: snapshot,
        currentSnapshotPath: '/tmp/current.json',
        previousSnapshotPath: '/tmp/previous.json',
      })
      .mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(poller.refreshNow('project-a', 'worktree-a')).rejects.toThrow(
      'ledger unavailable',
    );
    expect(hookState.advancePrTrackingState).toHaveBeenCalledTimes(2);
    expect(mockHandleHookTriggeredEvent).toHaveBeenCalledTimes(1);
  });

  it('sweeps every due worktree with one batched lookup after the minimum spacing', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();

    poller.startPolling(() => createWindow());
    poller.requestRefresh('project-a', 'worktree-a');
    poller.requestRefresh('project-b', 'worktree-b');

    await jest.advanceTimersByTimeAsync(29_000);
    expect(mockFetchPullRequestSweep).not.toHaveBeenCalled();

    await advanceUntilCallCount(mockRecordGitHubRefreshSuccess, 2);

    expect(mockFetchPullRequestSweep).toHaveBeenCalledTimes(1);
    expect(mockFetchPullRequestSweep).toHaveBeenCalledWith(
      expect.anything(),
      { owner: 'acme', repo: 'repo' },
      ['feature-1', 'feature-1'],
    );
    expect(
      mockRecordGitHubRefreshSuccess.mock.calls.map(
        ([args]) => args.worktreeId,
      ),
    ).toEqual(['worktree-a', 'worktree-b']);
    expect(mockedFetchRepoPrTrackingData).not.toHaveBeenCalled();
  });

  it('uses a durable unchanged success to suppress a redundant fast refresh', async () => {
    mockReadGitHubRefreshLedgerEntry.mockResolvedValueOnce({
      lastSuccessAt: new Date(0).toISOString(),
      consecutiveFailures: 0,
    });
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();

    poller.enqueueFastRefresh('project-a', 'worktree-a', true);
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(2_000);

    expect(mockReadGitHubRefreshLedgerEntry).toHaveBeenCalledWith(
      'project-a',
      'worktree-a',
      undefined,
    );
    expect(mockedFetchRepoPrTrackingData).not.toHaveBeenCalled();
  });

  it('skips the durable ledger read when in-memory freshness is sufficient', async () => {
    jest.setSystemTime(1_000);
    const { poller } = await importFreshPoller();
    poller.syncTrackedWorktrees([
      createTrackedItem({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        lastKnownPrStatus: {
          repos: [],
          lastCheckedAt: new Date(1_000).toISOString(),
        },
      }),
    ]);
    await flushMicrotasks();
    mockReadGitHubRefreshLedgerEntry.mockClear();

    poller.enqueueFastRefresh('project-a', 'worktree-a', true);
    await flushMicrotasks();

    expect(mockReadGitHubRefreshLedgerEntry).not.toHaveBeenCalled();
  });

  it('hydrates durable due time before sweeping after relaunch', async () => {
    const ledgerRead = createDeferred<GitHubRefreshLedgerEntry | null>();
    mockReadGitHubRefreshLedgerEntry.mockReturnValueOnce(ledgerRead.promise);
    const { poller } = await importFreshPoller();

    poller.startPolling(() => createWindow());
    poller.syncTrackedWorktrees([
      createTrackedItem({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
      }),
    ]);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockFetchPullRequestSweep).not.toHaveBeenCalled();

    ledgerRead.resolve({
      lastSuccessAt: new Date(30_000).toISOString(),
      nextDueAt: new Date(60_000).toISOString(),
      consecutiveFailures: 0,
    });
    await flushMicrotasks();

    await jest.advanceTimersByTimeAsync(29_000);
    expect(mockFetchPullRequestSweep).not.toHaveBeenCalled();
    await advanceUntilCallCount(mockFetchPullRequestSweep, 1);
    expect(mockFetchPullRequestSweep).toHaveBeenCalledTimes(1);
    expect(jest.now()).toBe(60_000);
  });

  it('coalesces worktrees due within 30 seconds into one sweep', async () => {
    mockReadGitHubRefreshLedgerEntry
      .mockResolvedValueOnce({
        lastSuccessAt: new Date(0).toISOString(),
        nextDueAt: new Date(40_000).toISOString(),
        consecutiveFailures: 0,
      })
      .mockResolvedValueOnce({
        lastSuccessAt: new Date(0).toISOString(),
        nextDueAt: new Date(65_000).toISOString(),
        consecutiveFailures: 0,
      })
      .mockResolvedValueOnce({
        lastSuccessAt: new Date(0).toISOString(),
        nextDueAt: new Date(80_000).toISOString(),
        consecutiveFailures: 0,
      });
    const { poller } = await importFreshPoller();

    poller.startPolling(() => createWindow());
    poller.syncTrackedWorktrees([
      createTrackedItem({ projectId: 'project-a', worktreeId: 'worktree-a' }),
      createTrackedItem({ projectId: 'project-b', worktreeId: 'worktree-b' }),
      createTrackedItem({ projectId: 'project-c', worktreeId: 'worktree-c' }),
    ]);
    await flushMicrotasks();

    await advanceUntilCallCount(mockRecordGitHubRefreshSuccess, 2);
    expect(jest.now()).toBe(40_000);
    expect(mockFetchPullRequestSweep).toHaveBeenCalledTimes(1);
    expect(
      mockRecordGitHubRefreshSuccess.mock.calls.map(
        ([args]) => args.worktreeId,
      ),
    ).toEqual(['worktree-a', 'worktree-b']);

    await advanceUntilCallCount(mockRecordGitHubRefreshSuccess, 3);
    expect(mockFetchPullRequestSweep).toHaveBeenCalledTimes(2);
    expect(jest.now()).toBe(80_000);
  });

  it('keeps sweeping healthy worktrees when one worktree read fails', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    mockFetchPullRequestSweep.mockImplementation(sweepResult('unresolved'));
    mockedFetchRepoPrTrackingData.mockImplementation((repoPath) => {
      if (repoPath.includes('project-a')) {
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve({
        status: null,
        snapshot: null,
        branchName: 'feature-1',
        remote: { owner: 'acme', repo: 'repo' },
      });
    });

    poller.startPolling(() => createWindow());
    poller.syncTrackedWorktrees([
      createTrackedItem({ projectId: 'project-a', worktreeId: 'worktree-a' }),
      createTrackedItem({ projectId: 'project-b', worktreeId: 'worktree-b' }),
    ]);
    await flushMicrotasks();

    await advanceUntilCallCount(mockedFetchRepoPrTrackingData, 2);
    await flushMicrotasks(50);

    expect(
      mockedFetchRepoPrTrackingData.mock.calls.map(([cwd, , options]) => [
        cwd,
        options?.priority,
      ]),
    ).toEqual([
      ['/mock/workspaces/project-a/worktrees/worktree-a', 'normal'],
      ['/mock/workspaces/project-b/worktrees/worktree-b', 'normal'],
    ]);
    expect(mockRecordGitHubRefreshFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordGitHubRefreshSuccess).toHaveBeenCalledTimes(1);
  });

  it('sweeps the focused foreground worktree at the active cadence', async () => {
    const { poller } = await importFreshPoller();
    let focused = true;

    poller.startPolling(() => createWindow(() => focused));
    poller.requestRefresh('project-a', 'worktree-a');
    poller.requestRefresh('project-b', 'worktree-b');
    poller.setForegroundWorktree('project-b', 'worktree-b');

    await advanceUntilCallCount(mockRecordGitHubRefreshSuccess, 2);
    expect(jest.now()).toBe(30_000);

    await advanceUntilCallCount(mockRecordGitHubRefreshSuccess, 3, 1_000, 80);
    expect(jest.now()).toBe(90_000);
    expect(mockRecordGitHubRefreshSuccess.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ worktreeId: 'worktree-b' }),
    );

    focused = false;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockRecordGitHubRefreshSuccess).toHaveBeenCalledTimes(3);
  });

  it('retains tracked worktrees preserved after a partial load', async () => {
    const { poller } = await importFreshPoller();

    poller.syncTrackedWorktrees([
      createTrackedItem({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
      }),
    ]);
    poller.setForegroundWorktree('project-a', 'worktree-a');

    poller.syncTrackedWorktrees([], new Set(['project-a']));

    expect(poller.getForegroundWorktreeKey()).toBe('project-a/worktree-a');
  });

  it('schedules each worktree by its PR: 60s with CI in flight, 2 minutes open, 5 minutes otherwise', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    mockFetchPullRequestSweep.mockImplementation(sweepResult('unresolved'));
    const openStatus = (checkStatus: 'pending' | 'passing'): PrStatusData => ({
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42',
      state: 'open' as const,
      title: 'PR',
      checkStatus,
      checkDetails: [],
      reviewStatus: 'none' as const,
      reviewers: [],
      hasConflicts: false,
      commentCount: 0,
      updatedAt: '2026-04-16T00:00:00.000Z',
    });
    mockedFetchRepoPrTrackingData.mockImplementation((repoPath) =>
      Promise.resolve({
        status: repoPath.includes('active-ci')
          ? openStatus('pending')
          : repoPath.includes('known')
            ? openStatus('passing')
            : null,
        snapshot: null,
        branchName: 'feature-1',
        remote: { owner: 'acme', repo: 'repo' },
      }),
    );

    poller.startPolling(() => createWindow());
    poller.syncTrackedWorktrees([
      createTrackedItem({
        projectId: 'project-active-ci',
        worktreeId: 'worktree-active-ci',
      }),
      createTrackedItem({
        projectId: 'project-known',
        worktreeId: 'worktree-known',
      }),
      createTrackedItem({
        projectId: 'project-none',
        worktreeId: 'worktree-none',
      }),
    ]);
    await flushMicrotasks();

    const sweeps: Array<{ at: number; projects: string[] }> = [];
    let seen = 0;
    for (let second = 0; second < 340; second += 1) {
      await jest.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();
      const calls = mockedFetchRepoPrTrackingData.mock.calls.slice(seen);
      if (calls.length > 0) {
        seen += calls.length;
        sweeps.push({
          at: jest.now(),
          projects: calls.map(([cwd]) => cwd.split('/')[3] ?? cwd),
        });
      }
    }

    expect(sweeps).toEqual([
      {
        at: 30_000,
        projects: ['project-active-ci', 'project-known', 'project-none'],
      },
      { at: 90_000, projects: ['project-active-ci'] },
      { at: 150_000, projects: ['project-active-ci', 'project-known'] },
      { at: 210_000, projects: ['project-active-ci'] },
      { at: 270_000, projects: ['project-active-ci', 'project-known'] },
      { at: 330_000, projects: ['project-active-ci', 'project-none'] },
    ]);
  });

  it('prioritizes a fast refresh only when a worktree has a known PR', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const workspacePersistence = await import('../lib/workspace-persistence');
    const knownPrStatus: WorktreePrStatus = {
      repos: [
        {
          repoId: 'project-known',
          repoName: 'project-known',
          status: {
            prNumber: 42,
            prUrl: 'https://github.com/acme/repo/pull/42',
            state: 'merged',
            title: 'PR',
            checkStatus: 'none',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-04-16T00:00:00.000Z',
          },
        },
      ],
      lastCheckedAt: '2026-04-16T00:00:00.000Z',
    };

    const window = {
      isDestroyed: (): boolean => false,
      isFocused: (): boolean => false,
      webContents: {
        send: jest.fn(),
        isDestroyed: (): boolean => false,
        isCrashed: (): boolean => false,
        mainFrame: { isDestroyed: (): boolean => false, detached: false },
      },
    };

    poller.startPolling(() => window as never);
    poller.syncTrackedWorktrees([
      createTrackedItem({
        projectId: 'project-known',
        worktreeId: 'worktree-known',
        lastKnownPrStatus: knownPrStatus,
      }),
      createTrackedItem({
        projectId: 'project-unknown',
        worktreeId: 'worktree-unknown',
        lastKnownPrStatus: null,
      }),
      createTrackedItem({
        projectId: 'project-persisted',
        worktreeId: 'worktree-persisted',
        lastKnownPrStatus: null,
      }),
    ]);

    await expect(
      poller.enqueueKnownPrFastRefresh('project-known', 'worktree-known'),
    ).resolves.toBe(true);
    await expect(
      poller.enqueueKnownPrFastRefresh('project-unknown', 'worktree-unknown'),
    ).resolves.toBe(false);

    await jest.advanceTimersByTimeAsync(999);
    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledTimes(0);

    await advanceUntilCallCount(mockedFetchRepoPrTrackingData, 1, 1);
    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledTimes(1);
    expect(mockedFetchRepoPrTrackingData.mock.calls[0]?.[0]).toContain(
      'project-known',
    );

    jest.mocked(workspacePersistence.readWorkspaceWorktrees).mockResolvedValue([
      {
        id: 'worktree-persisted',
        branchName: 'worktree-persisted',
        createdAt: '2026-04-16T00:00:00.000Z',
        lastKnownPrStatus: knownPrStatus,
      },
    ]);

    await expect(
      poller.enqueueKnownPrFastRefresh(
        'project-persisted',
        'worktree-persisted',
      ),
    ).resolves.toBe(true);

    await advanceUntilCallCount(mockedFetchRepoPrTrackingData, 2);
    expect(mockedFetchRepoPrTrackingData.mock.calls[1]?.[0]).toContain(
      'project-persisted',
    );

    poller.stopPolling();
  });

  it('forces an interactive refresh through the immediate queue even when just swept', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();

    poller.startPolling(() => createWindow());
    poller.requestRefresh('project-a', 'worktree-a');

    await advanceUntilCallCount(mockFetchPullRequestSweep, 1);
    await flushMicrotasks(50);

    poller.requestRefresh('project-a', 'worktree-a');
    await jest.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(mockedFetchRepoPrTrackingData).not.toHaveBeenCalled();

    poller.requestRefresh('project-a', 'worktree-a', true);
    await advanceUntilCallCount(mockedFetchRepoPrTrackingData, 1);

    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledWith(
      '/mock/workspaces/project-a/worktrees/worktree-a',
      'feature-1',
      expect.objectContaining({ priority: 'high', caller: 'pr-poller' }),
    );
    expect(mockFetchPullRequestSweep).toHaveBeenCalledTimes(1);
  });

  it('still fetches PR status when hook resolution fails', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const hookResolver = await import('../lib/hook-resolver');
    const mockedResolveProjectHooks = jest.mocked(
      hookResolver.resolveProjectHooks,
    );
    mockedResolveProjectHooks.mockRejectedValueOnce(
      new Error('hook resolution failed'),
    );
    mockedFetchRepoPrTrackingData.mockResolvedValueOnce({
      status: {
        prNumber: 109,
        prUrl: 'https://github.com/acme/example-repo/pull/109',
        state: 'open',
        title: 'Example PR',
        checkStatus: 'passing',
        checkDetails: [],
        reviewStatus: 'none',
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-04-13T00:00:00.000Z',
      },
      snapshot: null,
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'example-repo' },
    });

    const window = {
      isDestroyed: (): boolean => false,
      isFocused: (): boolean => false,
      webContents: {
        send: jest.fn(),
        isDestroyed: (): boolean => false,
        isCrashed: (): boolean => false,
        mainFrame: { isDestroyed: (): boolean => false, detached: false },
      },
    };

    poller.startPolling(() => window as never);
    poller.requestRefresh('whois-cache', 'aardvark', true);

    await advanceUntilCallCount(mockedFetchRepoPrTrackingData, 1);

    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledWith(
      '/mock/workspaces/whois-cache/worktrees/aardvark',
      'feature-1',
      expect.objectContaining({
        includeCommentCollections: false,
      }),
    );
    const prStatusCall =
      window.webContents.send.mock.calls.find(isPrStatusEventCall);
    expect(prStatusCall).toBeDefined();
    if (!prStatusCall) {
      throw new Error('Expected githubPrStatusEvent call');
    }

    const [, event] = prStatusCall;
    expect(event.projectId).toBe('whois-cache');
    expect(event.worktreeId).toBe('aardvark');
    expect(event.status?.repos[0]?.status?.prNumber).toBe(109);

    poller.stopPolling();
  });

  it('fetches comment collections when review hook triggers are configured', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const hookResolver = await import('../lib/hook-resolver');

    jest
      .mocked(hookResolver.getResolvedHookActions)
      .mockImplementation((_resolvedHooks, triggerName) =>
        triggerName === 'pr:reviews:new:has-comments'
          ? [{ type: 'command', command: 'echo review comment' }]
          : null,
      );

    mockedFetchRepoPrTrackingData.mockResolvedValueOnce({
      status: null,
      snapshot: null,
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'example-repo' },
    });

    await poller.refreshNow('project-a', 'worktree-a');

    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledWith(
      '/mock/workspaces/project-a/worktrees/worktree-a',
      'feature-1',
      expect.objectContaining({
        includeCommentCollections: true,
      }),
    );
  });

  it('fetches comment collections when an active hook watcher targets PR comments', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();

    mockListAppAdvisorWatchers.mockResolvedValue([
      {
        id: 'watcher-1',
        trigger: 'worktree_hook_triggered',
        status: 'active',
        label: 'PR comments',
        target: {
          kind: 'worktree_hook',
          projectId: 'project-a',
          worktreeId: 'worktree-a',
          triggerName: 'pr:update:comments',
        },
        destination: {
          projectId: 'project-a',
          worktreeId: 'worktree-a',
          chatId: 'chat-1',
        },
        createdAt: '2026-04-13T00:00:00.000Z',
      },
    ]);

    mockedFetchRepoPrTrackingData.mockResolvedValueOnce({
      status: null,
      snapshot: null,
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'example-repo' },
    });

    await poller.refreshNow('project-a', 'worktree-a');

    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledWith(
      '/mock/workspaces/project-a/worktrees/worktree-a',
      'feature-1',
      expect.objectContaining({
        includeCommentCollections: true,
      }),
    );
  });

  it('forwards the comment-fetch rate-limit reset window to the renderer', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    jest.setSystemTime(120_000);
    const send = jest.fn();

    mockListAppAdvisorWatchers.mockResolvedValue([
      {
        id: 'watcher-1',
        trigger: 'worktree_hook_triggered',
        status: 'active',
        label: 'PR comments',
        target: {
          kind: 'worktree_hook',
          projectId: 'project-a',
          worktreeId: 'worktree-a',
          triggerName: 'pr:update:comments',
        },
        destination: {
          projectId: 'project-a',
          worktreeId: 'worktree-a',
          chatId: 'chat-1',
        },
        createdAt: '2026-04-13T00:00:00.000Z',
      },
    ]);
    mockedFetchRepoPrTrackingData.mockImplementationOnce(
      (_repoPath, _branchName, options) => {
        options?.onCommentFetchSkipped?.('GitHub budget is low.', {
          kind: 'primary',
          retryAt: '2026-07-22T18:30:00.000Z',
          retryAfterSeconds: 120,
          resource: 'core',
        });
        return Promise.resolve({
          status: null,
          snapshot: null,
          branchName: 'feature-1',
          remote: { owner: 'acme', repo: 'example-repo' },
        });
      },
    );
    const window = jest.createMockFromModule<BrowserWindow>('electron');
    Object.assign(window, {
      isDestroyed: (): boolean => false,
      isFocused: (): boolean => false,
      webContents: {
        send,
        isDestroyed: (): boolean => false,
        isCrashed: (): boolean => false,
        mainFrame: { isDestroyed: (): boolean => false, detached: false },
      },
    });

    poller.startPolling(() => window);
    await poller.refreshNow('project-a', 'worktree-a');

    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.githubRateLimitEvent, {
      kind: 'primary',
      message: 'GitHub budget is low.',
      retryAt: '2026-07-22T18:30:00.000Z',
      retryAfterSeconds: 120,
      resource: 'core',
    });
    poller.stopPolling();
  });

  it('preserves the project root repo id in multi-repo refresh results', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const workspaceRegistry = await import('../lib/workspace-registry');
    const worktreeRepoEntries = await import('../lib/worktree-repo-entries');
    const git = await import('../lib/git');

    jest.mocked(workspaceRegistry.isMultiRepoWorkspace).mockReturnValue(true);
    jest
      .mocked(worktreeRepoEntries.listWorkspaceWorktreeRepoEntries)
      .mockResolvedValue([
        {
          repoId: '__workspace_root__',
          repoName: 'Workspace root',
          repoPath: '/mock/workspaces/project-a/worktrees/worktree-a',
        },
      ]);
    jest.mocked(git.getCurrentBranch).mockResolvedValue('feature-1');
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
      snapshot: null,
      branchName: 'feature-1',
      remote: null,
    });

    const result = await poller.refreshNow('project-a', 'worktree-a');

    expect(result?.repos).toEqual([
      {
        repoId: '__workspace_root__',
        repoName: 'Workspace root',
        status: null,
        prLookupAvailable: false,
      },
    ]);
  });

  it('records transient repo fetch failures without clearing PR tracking state', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const githubPrHookState = await import('../lib/github-pr-hook-state');

    mockedFetchRepoPrTrackingData.mockRejectedValue(
      new Error('network failed'),
    );

    await expect(poller.refreshNow('project-a', 'worktree-a')).rejects.toThrow(
      'network failed',
    );

    expect(githubPrHookState.advancePrTrackingState).not.toHaveBeenCalled();
    expect(mockRecordGitHubRefreshFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
      }),
    );
    expect(mockRecordGitHubRefreshSuccess).not.toHaveBeenCalled();
  });

  it('does not advance earlier repo snapshots when a later repo fetch fails', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const githubPrHookState = await import('../lib/github-pr-hook-state');
    const workspaceRegistry = await import('../lib/workspace-registry');
    const worktreeRepoEntries = await import('../lib/worktree-repo-entries');
    const git = await import('../lib/git');

    jest.mocked(workspaceRegistry.isMultiRepoWorkspace).mockReturnValue(true);
    jest
      .mocked(worktreeRepoEntries.listWorkspaceWorktreeRepoEntries)
      .mockResolvedValue([
        {
          repoId: 'first-repo',
          repoName: 'First Repo',
          repoPath: '/mock/worktrees/first',
        },
        {
          repoId: 'second-repo',
          repoName: 'Second Repo',
          repoPath: '/mock/worktrees/second',
        },
      ]);
    jest
      .mocked(git.getCurrentBranch)
      .mockResolvedValueOnce('feature/first')
      .mockResolvedValueOnce('feature/second');
    mockedFetchRepoPrTrackingData
      .mockResolvedValueOnce({
        status: null,
        snapshot: null,
        branchName: 'feature/first',
        remote: null,
      })
      .mockRejectedValueOnce(new Error('second repo unavailable'));

    await expect(poller.refreshNow('project-a', 'worktree-a')).rejects.toThrow(
      'second repo unavailable',
    );

    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledTimes(2);
    expect(githubPrHookState.advancePrTrackingState).not.toHaveBeenCalled();
    expect(mockRecordGitHubRefreshFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordGitHubRefreshSuccess).not.toHaveBeenCalled();
  });

  it('does not clear persisted PR status when refresh target resolution fails', async () => {
    const { poller } = await importFreshPoller();
    const resolveWorktree = await import('../lib/resolve-worktree');
    const workspacePersistence = await import('../lib/workspace-persistence');

    jest.mocked(resolveWorktree.resolveWorktreeCwd).mockImplementation(() => {
      throw new Error('worktree missing');
    });

    await expect(poller.refreshNow('project-a', 'worktree-a')).rejects.toThrow(
      'worktree missing',
    );
    expect(workspacePersistence.updateWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it('backfills done for an unchanged merged PR status without emitting telemetry', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const workspacePersistence = await import('../lib/workspace-persistence');
    const prStatusChangeEmitter =
      await import('../lib/pr-status-change-emitter');

    const mergedStatus: WorktreePrStatus = {
      repos: [
        {
          repoId: 'worktree-a',
          repoName: 'worktree-a',
          status: {
            prNumber: 42,
            prUrl: 'https://github.com/acme/repo/pull/42',
            state: 'merged',
            title: 'PR',
            checkStatus: 'none',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-04-16T00:00:00.000Z',
          },
          prLookupAvailable: true,
        },
      ],
      lastCheckedAt: '2026-04-16T00:00:00.000Z',
    };

    poller.syncTrackedWorktrees([
      createTrackedItem({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        lastKnownPrStatus: mergedStatus,
      }),
    ]);

    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: mergedStatus.repos[0]?.status ?? null,
      snapshot: null,
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'repo' },
    });

    await poller.refreshNow('project-a', 'worktree-a');

    const updater = jest.mocked(workspacePersistence.updateWorkspaceWorktree)
      .mock.calls[0]?.[2];
    expect(updater).toBeDefined();
    if (!updater) {
      throw new Error('Expected worktree persistence updater');
    }
    expect(
      updater({
        id: 'worktree-a',
        branchName: 'worktree-a',
        createdAt: '2026-04-16T00:00:00.000Z',
        lastKnownPrStatus: mergedStatus,
      }),
    ).toEqual(
      expect.objectContaining({
        status: 'done',
      }),
    );
    expect(
      prStatusChangeEmitter.emitWorktreePrStatusChange,
    ).not.toHaveBeenCalled();
  });

  it('clears done when an open PR returns and emits telemetry', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const workspacePersistence = await import('../lib/workspace-persistence');
    const prStatusChangeEmitter =
      await import('../lib/pr-status-change-emitter');

    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: {
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo/pull/42',
        state: 'open',
        title: 'PR',
        checkStatus: 'none',
        checkDetails: [],
        reviewStatus: 'none',
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-04-16T00:00:00.000Z',
      },
      snapshot: null,
      branchName: 'feature-1',
      remote: null,
    });

    await poller.refreshNow('project-a', 'worktree-a');

    const updater = jest.mocked(workspacePersistence.updateWorkspaceWorktree)
      .mock.calls[0]?.[2];
    expect(updater).toBeDefined();
    if (!updater) {
      throw new Error('Expected worktree persistence updater');
    }
    const updated = updater({
      id: 'worktree-a',
      branchName: 'worktree-a',
      createdAt: '2026-04-16T00:00:00.000Z',
      status: 'done',
    });
    expect(updated.status).toBeUndefined();
    expect(
      prStatusChangeEmitter.emitWorktreePrStatusChange,
    ).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['disappeared', (): Promise<boolean> => Promise.resolve(false)],
    [
      'failed to persist',
      (): Promise<boolean> => Promise.reject(new Error('disk full')),
    ],
  ])(
    'does not announce a PR status for a worktree whose row %s',
    async (_label, persist) => {
      const { poller, mockedFetchRepoPrTrackingData } =
        await importFreshPoller();
      const workspacePersistence = await import('../lib/workspace-persistence');
      const prStatusChangeEmitter =
        await import('../lib/pr-status-change-emitter');
      jest
        .mocked(workspacePersistence.updateWorkspaceWorktree)
        .mockImplementationOnce(persist);
      mockedFetchRepoPrTrackingData.mockResolvedValue({
        status: null,
        snapshot: null,
        branchName: 'feature-1',
        remote: null,
      });

      await poller.refreshNow('project-a', 'worktree-a');

      expect(
        prStatusChangeEmitter.emitWorktreePrStatusChange,
      ).not.toHaveBeenCalled();
    },
  );

  it('emits lookup availability when a polled repo has no usable remote', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const prStatusChangeEmitter =
      await import('../lib/pr-status-change-emitter');

    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
      snapshot: null,
      branchName: 'feature-1',
      remote: null,
    });

    await poller.refreshNow('project-a', 'worktree-a');

    expect(
      prStatusChangeEmitter.emitWorktreePrStatusChange,
    ).toHaveBeenCalledWith(
      'project-a',
      'worktree-a',
      expect.objectContaining({
        repos: [
          expect.objectContaining({
            status: null,
            prLookupAvailable: false,
          }),
        ],
      }),
    );
  });

  it('emits a clearing change when a saved PR status becomes null', async () => {
    const { poller } = await importFreshPoller();
    const workspaceRegistry = await import('../lib/workspace-registry');
    const prStatusChangeEmitter =
      await import('../lib/pr-status-change-emitter');
    const previousStatus: WorktreePrStatus = {
      repos: [
        {
          repoId: 'repo',
          repoName: 'repo',
          status: {
            prNumber: 42,
            prUrl: 'https://github.com/acme/repo/pull/42',
            state: 'open',
            title: 'PR',
            checkStatus: 'none',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-04-16T00:00:00.000Z',
          },
        },
      ],
      lastCheckedAt: '2026-04-16T00:00:00.000Z',
    };
    jest.mocked(workspaceRegistry.isMultiRepoWorkspace).mockReturnValue(true);
    poller.syncTrackedWorktrees([
      createTrackedItem({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        lastKnownPrStatus: previousStatus,
      }),
    ]);

    await poller.refreshNow('project-a', 'worktree-a');

    expect(
      prStatusChangeEmitter.emitWorktreePrStatusChange,
    ).toHaveBeenCalledWith('project-a', 'worktree-a', null);
  });

  it('returns the same worktree for fully unchanged persisted state without emitting telemetry', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const workspacePersistence = await import('../lib/workspace-persistence');
    const prStatusChangeEmitter =
      await import('../lib/pr-status-change-emitter');
    const mergedStatus: WorktreePrStatus = {
      repos: [
        {
          repoId: 'worktree-a',
          repoName: 'worktree-a',
          status: {
            prNumber: 42,
            prUrl: 'https://github.com/acme/repo/pull/42',
            state: 'merged',
            title: 'PR',
            checkStatus: 'none',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-04-16T00:00:00.000Z',
          },
          prLookupAvailable: true,
        },
      ],
      lastCheckedAt: '2026-04-16T00:00:00.000Z',
    };
    poller.syncTrackedWorktrees([
      createTrackedItem({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        lastKnownPrStatus: mergedStatus,
      }),
    ]);
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: mergedStatus.repos[0]?.status ?? null,
      snapshot: null,
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'repo' },
    });

    await poller.refreshNow('project-a', 'worktree-a');

    const updater = jest.mocked(workspacePersistence.updateWorkspaceWorktree)
      .mock.calls[0]?.[2];
    expect(updater).toBeDefined();
    if (!updater) {
      throw new Error('Expected worktree persistence updater');
    }
    const persistedWorktree: WorktreeData = {
      id: 'worktree-a',
      branchName: 'worktree-a',
      createdAt: '2026-04-16T00:00:00.000Z',
      status: 'done',
      lastKnownPrStatus: mergedStatus,
    };
    expect(updater(persistedWorktree)).toBe(persistedWorktree);
    expect(
      prStatusChangeEmitter.emitWorktreePrStatusChange,
    ).not.toHaveBeenCalled();
    expect(mockRecordGitHubRefreshSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        dataChanged: false,
      }),
    );
  });

  it('continues refreshing healthy repos when one project repo has stale hook config', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const workspaceRegistry = await import('../lib/workspace-registry');
    const worktreeRepoEntries = await import('../lib/worktree-repo-entries');
    const git = await import('../lib/git');
    const hookResolver = await import('../lib/hook-resolver');

    jest.mocked(workspaceRegistry.isMultiRepoWorkspace).mockReturnValue(true);
    jest
      .mocked(worktreeRepoEntries.listWorkspaceWorktreeRepoEntries)
      .mockResolvedValue([
        {
          repoId: 'stale-repo',
          repoName: 'Stale Repo',
          repoPath:
            '/mock/workspaces/project-a/worktrees/worktree-a/repos/stale',
        },
        {
          repoId: 'healthy-repo',
          repoName: 'Healthy Repo',
          repoPath:
            '/mock/workspaces/project-a/worktrees/worktree-a/repos/healthy',
        },
      ]);
    jest
      .mocked(git.getCurrentBranch)
      .mockResolvedValueOnce('feature/stale')
      .mockResolvedValueOnce('feature/healthy');
    jest
      .mocked(hookResolver.resolveWorkspaceRepoHooks)
      .mockRejectedValueOnce(new Error('missing repo config'))
      .mockResolvedValueOnce({});
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
      snapshot: null,
      branchName: 'feature/healthy',
      remote: null,
    });

    const result = await poller.refreshNow('project-a', 'worktree-a');

    expect(result?.repos).toEqual([
      {
        repoId: 'stale-repo',
        repoName: 'Stale Repo',
        status: null,
        prLookupAvailable: false,
      },
      {
        repoId: 'healthy-repo',
        repoName: 'Healthy Repo',
        status: null,
        prLookupAvailable: false,
      },
    ]);
    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledTimes(2);
    expect(mockedFetchRepoPrTrackingData).toHaveBeenNthCalledWith(
      1,
      '/mock/workspaces/project-a/worktrees/worktree-a/repos/stale',
      'feature/stale',
      expect.any(Object),
    );
    expect(mockedFetchRepoPrTrackingData).toHaveBeenNthCalledWith(
      2,
      '/mock/workspaces/project-a/worktrees/worktree-a/repos/healthy',
      'feature/healthy',
      expect.any(Object),
    );
  });

  it.each([false, true])(
    'leaves paused automatic hooks to the core hook source (multi-repo: %s)',
    async (multiRepo) => {
      const { poller, mockedFetchRepoPrTrackingData } =
        await importFreshPoller();
      const githubPrHookState = await import('../lib/github-pr-hook-state');
      const hookResolver = await import('../lib/hook-resolver');
      const hookRunner = await import('../lib/hook-runner');
      const workspacePersistence = await import('../lib/workspace-persistence');
      const workspaceRegistry = await import('../lib/workspace-registry');
      const worktreeRepoEntries = await import('../lib/worktree-repo-entries');
      jest
        .mocked(workspaceRegistry.isMultiRepoWorkspace)
        .mockReturnValue(multiRepo);
      const repoIds = ['canopy', 'ud-internal-hub'];
      if (multiRepo) {
        jest
          .mocked(worktreeRepoEntries.listWorkspaceWorktreeRepoEntries)
          .mockResolvedValue(
            repoIds.map((repoId) => ({
              repoId,
              repoName: repoId,
              repoPath: `/mock/repos/${repoId}`,
            })),
          );
      }
      const pausedKeys = multiRepo
        ? repoIds.map((repoId) => `workspace-repo:${repoId}:pr:create`)
        : ['project:pr:create'];
      const snapshot = createPrSnapshot();

      mockedFetchRepoPrTrackingData.mockResolvedValue({
        status: {
          prNumber: 42,
          prUrl: 'https://github.com/acme/repo/pull/42',
          state: 'open',
          title: 'PR',
          checkStatus: 'none',
          checkDetails: [],
          reviewStatus: 'none',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
        snapshot,
        branchName: 'feature-1',
        remote: { owner: 'acme', repo: 'repo' },
      });
      jest
        .mocked(hookResolver.getResolvedHookActions)
        .mockImplementation((_resolvedHooks, triggerName) =>
          triggerName === 'pr:create'
            ? [{ type: 'command', command: 'echo hook' }]
            : null,
        );
      jest.mocked(githubPrHookState.advancePrTrackingState).mockResolvedValue({
        triggers: ['pr:create'],
        currentSnapshot: snapshot,
        currentSnapshotPath: '/tmp/current.json',
        previousSnapshotPath: '/tmp/previous.json',
      });
      jest
        .mocked(workspacePersistence.readWorkspaceWorktrees)
        .mockResolvedValue([
          {
            id: 'worktree-a',
            branchName: 'feature-1',
            createdAt: '2026-04-16T00:00:00.000Z',
            pausedHookKeys: pausedKeys,
          },
        ]);

      const window = {
        isDestroyed: (): boolean => false,
        isFocused: (): boolean => false,
        webContents: {
          send: jest.fn(),
          isDestroyed: (): boolean => false,
          isCrashed: (): boolean => false,
          mainFrame: { isDestroyed: (): boolean => false, detached: false },
        },
      };

      poller.startPolling(() => window as never);
      await poller.refreshNow('project-a', 'worktree-a');

      // The pause is decided where every hook fires (CAN-4146): each paused
      // hook goes to the runner under the worktree's pause, and the poller
      // tells the window nothing itself.
      expect(
        jest
          .mocked(hookRunner.runHook)
          .mock.calls.map(([options]) => [options.hook.hookKey, options.pause]),
      ).toEqual(pausedKeys.map((hookKey) => [hookKey, 'enforce']));
      expect(window.webContents.send).not.toHaveBeenCalledWith(
        IPC_CHANNELS.hookSkippedPaused,
        expect.anything(),
      );
      poller.stopPolling();
    },
  );

  it('fires merge queue hook watchers in dispatch order with configured, paused, and queue variables', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const githubPrHookState = await import('../lib/github-pr-hook-state');
    const hookResolver = await import('../lib/hook-resolver');
    const hookRunner = await import('../lib/hook-runner');
    const workspacePersistence = await import('../lib/workspace-persistence');
    const snapshot: PersistedPrSnapshotFileV1 = {
      ...createPrSnapshot(),
      mergeQueue: {
        required: true,
        membership: {
          inQueue: true,
          entryId: 'MQE_2',
          phase: 'queued',
          enqueuedAt: null,
          position: 1,
        },
        lastEntered: {
          entryId: 'MQE_2',
          enqueuedAt: null,
          phase: 'queued',
          position: 1,
          reentry: true,
          observedAt: '2026-04-09T00:00:00.000Z',
        },
        lastRemoved: {
          entryId: 'MQE_1',
          removedAt: '2026-04-09T00:00:00.000Z',
          reason: 'failed_checks',
          evidence: 'timeline',
          requeued: true,
          observedAt: '2026-04-09T00:00:00.000Z',
        },
      },
    };
    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: null,
      snapshot,
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'repo' },
    });
    jest
      .mocked(hookResolver.getResolvedHookActions)
      .mockImplementation((_resolvedHooks, triggerName) =>
        triggerName === 'pr:queue:entered'
          ? [{ type: 'command', command: 'echo entered' }]
          : null,
      );
    jest.mocked(githubPrHookState.advancePrTrackingState).mockResolvedValue({
      triggers: ['pr:queue:entered', 'pr:queue:removed'],
      currentSnapshot: snapshot,
      currentSnapshotPath: '/tmp/current.json',
      previousSnapshotPath: '/tmp/previous.json',
    });
    jest.mocked(workspacePersistence.readWorkspaceWorktrees).mockResolvedValue([
      {
        id: 'worktree-a',
        branchName: 'feature-1',
        createdAt: '2026-04-16T00:00:00.000Z',
        pausedHookKeys: ['project:pr:queue:entered'],
      },
    ]);
    const window = {
      isDestroyed: (): boolean => false,
      isFocused: (): boolean => false,
      webContents: {
        send: jest.fn(),
        isDestroyed: (): boolean => false,
        isCrashed: (): boolean => false,
        mainFrame: { isDestroyed: (): boolean => false, detached: false },
      },
    };

    poller.startPolling(() => window as never);
    await poller.refreshNow('project-a', 'worktree-a');

    const events = mockHandleHookTriggeredEvent.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(events).toMatchObject([
      {
        triggerName: 'pr:queue:removed',
        hookKey: 'project:pr:queue:removed',
        configured: false,
        paused: false,
        variables: {
          PR_QUEUE_ENTRY_ID: 'MQE_1',
          PR_QUEUE_REMOVAL_REASON: 'failed_checks',
        },
      },
      {
        triggerName: 'pr:queue:entered',
        hookKey: 'project:pr:queue:entered',
        configured: true,
        paused: true,
        variables: {
          PR_QUEUE_ENTRY_ID: 'MQE_2',
          PR_QUEUE_REMOVAL_REASON: '',
        },
      },
    ]);
    expect(events).toHaveLength(2);
    // Watchers fire whatever the pause; the core hook source decides it.
    expect(
      jest
        .mocked(hookRunner.runHook)
        .mock.calls.map(([options]) => [options.hook.hookKey, options.pause]),
    ).toEqual([['project:pr:queue:entered', 'enforce']]);

    poller.stopPolling();
  });

  it('emits PR status updates without waiting for automatic hooks to finish', async () => {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const githubPrHookState = await import('../lib/github-pr-hook-state');
    const hookResolver = await import('../lib/hook-resolver');
    const hookRunner = await import('../lib/hook-runner');

    mockedFetchRepoPrTrackingData.mockResolvedValue({
      status: {
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo/pull/42',
        state: 'open',
        title: 'PR',
        checkStatus: 'none',
        checkDetails: [],
        reviewStatus: 'none',
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-04-09T00:00:00.000Z',
      },
      snapshot: {
        version: 1,
        provider: 'github',
        capturedAt: '2026-04-09T00:00:00.000Z',
        includesComments: true,
        includesReviews: true,
        includesReviewComments: true,
        repository: {
          owner: 'acme',
          name: 'repo',
          fullName: 'acme/repo',
        },
        branch: {
          currentName: 'feature-1',
          headRefName: 'feature-1',
          baseRefName: 'main',
          headSha: 'head',
          baseSha: 'base',
        },
        pr: {
          id: 100,
          number: 42,
          nodeId: 'PR_node',
          htmlUrl: 'https://github.com/acme/repo/pull/42',
          apiUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
          state: 'open',
          isDraft: false,
          title: 'PR',
          body: '',
          author: null,
          createdAt: '2026-04-09T00:00:00.000Z',
          updatedAt: '2026-04-09T00:00:00.000Z',
          mergedAt: null,
          closedAt: null,
          mergeCommitSha: null,
          mergedBy: null,
          isCrossRepository: false,
          labels: [],
          assignees: [],
          requestedReviewers: [],
        },
        issueComments: [],
        reviews: [],
        reviewComments: [],
      },
      branchName: 'feature-1',
      remote: { owner: 'acme', repo: 'repo' },
    });
    jest
      .mocked(hookResolver.getResolvedHookActions)
      .mockImplementation((_resolvedHooks, triggerName) =>
        triggerName === 'pr:create'
          ? [{ type: 'command', command: 'echo hook' }]
          : null,
      );
    jest.mocked(githubPrHookState.advancePrTrackingState).mockResolvedValue({
      triggers: ['pr:create'],
      currentSnapshot: {
        version: 1,
        provider: 'github',
        capturedAt: '2026-04-09T00:00:00.000Z',
        includesComments: true,
        includesReviews: true,
        includesReviewComments: true,
        repository: {
          owner: 'acme',
          name: 'repo',
          fullName: 'acme/repo',
        },
        branch: {
          currentName: 'feature-1',
          headRefName: 'feature-1',
          baseRefName: 'main',
          headSha: 'head',
          baseSha: 'base',
        },
        pr: {
          id: 100,
          number: 42,
          nodeId: 'PR_node',
          htmlUrl: 'https://github.com/acme/repo/pull/42',
          apiUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
          state: 'open',
          isDraft: false,
          title: 'PR',
          body: '',
          author: null,
          createdAt: '2026-04-09T00:00:00.000Z',
          updatedAt: '2026-04-09T00:00:00.000Z',
          mergedAt: null,
          closedAt: null,
          mergeCommitSha: null,
          mergedBy: null,
          isCrossRepository: false,
          labels: [],
          assignees: [],
          requestedReviewers: [],
        },
        issueComments: [],
        reviews: [],
        reviewComments: [],
      },
      currentSnapshotPath: '/tmp/current.json',
      previousSnapshotPath: '/tmp/previous.json',
    });
    let releaseHookRun: (() => void) | null = null;
    jest.mocked(hookRunner.runHook).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseHookRun = (): void =>
            resolve({
              success: true,
              exitCode: 0,
              output: '',
              timedOut: false,
              durationMs: 0,
            });
        }),
    );

    const window = {
      isDestroyed: (): boolean => false,
      isFocused: (): boolean => false,
      webContents: {
        send: jest.fn(),
        isDestroyed: (): boolean => false,
        isCrashed: (): boolean => false,
        mainFrame: { isDestroyed: (): boolean => false, detached: false },
      },
    };

    poller.startPolling(() => window as never);
    await poller.refreshNow('project-a', 'worktree-a');

    expect(window.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.githubPrStatusEvent,
      expect.objectContaining({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
      }),
    );
    expect(hookRunner.runHook).toHaveBeenCalledTimes(1);
    expect(hookRunner.runHook).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutSeconds: 300,
      }),
    );

    const releasePendingHookRun = releaseHookRun as (() => void) | null;
    if (typeof releasePendingHookRun === 'function') {
      releasePendingHookRun();
    }
    await flushMicrotasks(20);
    poller.stopPolling();
  });
  it('reconciles additions and removals within one project', async () => {
    const { poller } = await importFreshPoller();
    poller.stopPolling();
    const worktree: WorktreeData = {
      id: 'worktree-a',
      branchName: 'feature-a',
      createdAt: '2026-07-30T00:00:00.000Z',
      trackedRepoBaseBranches: {},
    };

    expect(
      poller.reconcileTrackedWorkspaceWorktrees('workspace-a', [worktree]),
    ).toEqual({
      addedWorktreeIds: ['worktree-a'],
      removedWorktreeIds: [],
    });
    expect(
      poller.reconcileTrackedWorkspaceWorktrees('workspace-a', [worktree]),
    ).toEqual({ addedWorktreeIds: [], removedWorktreeIds: [] });
    poller.reconcileTrackedWorkspaceWorktrees('workspace-b', [
      { ...worktree, id: 'worktree-b' },
    ]);
    poller.setForegroundWorktree('workspace-a', 'worktree-a');

    expect(
      poller.reconcileTrackedWorkspaceWorktrees('workspace-a', []),
    ).toEqual({
      addedWorktreeIds: [],
      removedWorktreeIds: ['worktree-a'],
    });
    expect(poller.getForegroundWorktreeKey()).toBeNull();
    expect(
      poller.reconcileTrackedWorkspaceWorktrees('workspace-b', [
        { ...worktree, id: 'worktree-b' },
      ]),
    ).toEqual({ addedWorktreeIds: [], removedWorktreeIds: [] });
  });
});

describe('github-poller sweep reads', () => {
  const openStatus = {
    prNumber: 42,
    prUrl: 'https://github.com/acme/repo/pull/42',
    state: 'open' as const,
    title: 'PR',
    checkStatus: 'passing' as const,
    checkDetails: [],
    reviewStatus: 'none' as const,
    reviewers: [],
    hasConflicts: false,
    commentCount: 0,
    updatedAt: '2026-04-16T00:00:00.000Z',
  };

  function sweptPullRequest(
    status: string,
    remarks: string,
    checksInFlight = false,
  ): SweptPullRequest {
    return {
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
      title: 'PR',
      state: 'open',
      isDraft: false,
      headSha: 'head',
      baseRefName: 'main',
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
      mergedAt: null,
      checksInFlight,
      fingerprint: { status, remarks },
    };
  }

  function foundSweep(
    ...pullRequests: SweptPullRequest[]
  ): (
    client: unknown,
    remote: unknown,
    branches: readonly string[],
  ) => Promise<Map<string, BranchPullRequestLookup>> {
    const queue = [...pullRequests];
    let last = queue[0];
    return (_client, _remote, branches) => {
      last = queue.shift() ?? last;
      const pullRequest = last;
      return Promise.resolve(
        new Map(
          branches.map((branch): [string, BranchPullRequestLookup] => [
            branch,
            pullRequest ? { kind: 'found', pullRequest } : { kind: 'none' },
          ]),
        ),
      );
    };
  }

  async function setUpSweep(): Promise<{
    poller: typeof GitHubPollerModule;
    mockedFetchTracked: jest.MockedFunction<
      typeof GitHubModule.fetchTrackedPullRequestData
    >;
    mockedFetchRepoPrTrackingData: jest.MockedFunction<
      typeof GitHubModule.fetchRepoPrTrackingData
    >;
    advance: () => Promise<void>;
  }> {
    const { poller, mockedFetchRepoPrTrackingData } = await importFreshPoller();
    const githubPr = await import('../lib/github-pr');
    const mockedFetchTracked = jest.mocked(
      githubPr.fetchTrackedPullRequestData,
    );
    mockedFetchTracked.mockResolvedValue({
      trackingData: {
        status: openStatus,
        snapshot: createPrSnapshot(),
        branchName: 'feature-1',
        remote: { owner: 'acme', repo: 'repo' },
      },
      complete: true,
    });
    poller.startPolling(() => createWindow());
    poller.syncTrackedWorktrees([
      createTrackedItem({ projectId: 'project-a', worktreeId: 'worktree-a' }),
    ]);
    await flushMicrotasks();
    let sweeps = 0;
    const advance = async (): Promise<void> => {
      sweeps += 1;
      await advanceUntilCallCount(
        mockRecordGitHubRefreshSuccess,
        sweeps,
        5_000,
        60,
      );
      await flushMicrotasks(20);
    };
    return {
      poller,
      mockedFetchTracked,
      mockedFetchRepoPrTrackingData,
      advance,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    jest.clearAllMocks();
    mockCloudGeneration = 0;
    mockBrokerGeneration = 0;
    mockUseActualCredential = false;
    mockAccountRead = { status: 'ok', entry: null };
    mockResolveGitHubToken.mockResolvedValue({
      token: 'ghp_test',
      source: 'pat',
    });
    mockListAppAdvisorWatchers.mockResolvedValue([]);
    mockFetchPullRequestSweep.mockImplementation(sweepResult('none'));
  });

  afterEach(() => {
    for (const poller of importedPollers.splice(0)) {
      poller.stopPolling();
    }
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('passes verified observation scope when a sweep sees no PR', async () => {
    const { advance } = await setUpSweep();
    await advance();
    const hookState = await import('../lib/github-pr-hook-state');
    expect(hookState.advancePrTrackingState).toHaveBeenCalledWith(
      expect.objectContaining({
        currentSnapshot: null,
        credentialScope: 'account-credential',
      }),
    );
  });

  it('pins sweep detail reads and accepted snapshots to their acquisition credential', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(sweptPullRequest('s1', 'r1')),
    );
    const { mockedFetchTracked, advance } = await setUpSweep();
    await advance();
    expect(
      mockedFetchTracked.mock.calls[0]?.[0].options?.authenticationToken,
    ).toBe('ghp_test');
    const hookState = await import('../lib/github-pr-hook-state');
    expect(
      jest.mocked(hookState.advancePrTrackingState).mock.calls[0]?.[0]
        .currentSnapshot?.credentialScope,
    ).toBe('account-credential');
  });

  it.each(['broker', 'cloud'] as const)(
    'rejects a completed sweep after the %s generation changes',
    async (kind) => {
      mockFetchPullRequestSweep.mockImplementation(
        foundSweep(sweptPullRequest('s1', 'r1')),
      );
      const { mockedFetchTracked } = await setUpSweep();
      const sweep = await import('../lib/github-pr-sweep');
      const publication = jest.fn();
      const unsubscribe = sweep.onPullRequestSwept(publication);
      mockedFetchTracked.mockImplementationOnce(() => {
        if (kind === 'broker') mockBrokerGeneration += 1;
        else mockCloudGeneration += 1;
        return Promise.resolve({
          trackingData: {
            status: openStatus,
            snapshot: createPrSnapshot(),
            branchName: 'feature-1',
            remote: { owner: 'acme', repo: 'repo' },
          },
          complete: true,
        });
      });
      await advanceUntilCallCount(mockRecordGitHubRefreshFailure, 1, 5_000, 60);
      const hookState = await import('../lib/github-pr-hook-state');
      expect(hookState.advancePrTrackingState).not.toHaveBeenCalled();
      expect(mockRecordGitHubRefreshSuccess).not.toHaveBeenCalled();
      expect(publication).not.toHaveBeenCalled();
      unsubscribe();
    },
  );

  it('does not reuse a previous sweep snapshot under a replacement credential scope', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(sweptPullRequest('s1', 'r1')),
    );
    const { mockedFetchTracked, advance } = await setUpSweep();
    await advance();
    const identity = await import('../lib/github-preview-credential');
    jest
      .mocked(identity.readGitHubPreviewCredential)
      .mockResolvedValue({ token: 'new-token', scope: 'new-scope' });
    await advance();
    expect(mockedFetchTracked).toHaveBeenCalledTimes(2);
    expect(
      mockedFetchTracked.mock.calls[1]?.[0].options?.authenticationToken,
    ).toBe('new-token');
    const hookState = await import('../lib/github-pr-hook-state');
    expect(
      jest.mocked(hookState.advancePrTrackingState).mock.calls.at(-1)?.[0]
        .currentSnapshot?.credentialScope,
    ).toBe('new-scope');
  });

  it.each(['token replacement', 'account recovery'] as const)(
    'rereads unscoped sweep facts after %s',
    async (change) => {
      mockUseActualCredential = true;
      mockAccountRead = { status: 'unavailable' };
      mockFetchPullRequestSweep.mockImplementation(
        foundSweep(sweptPullRequest('s1', 'r1')),
      );
      const { mockedFetchTracked, advance } = await setUpSweep();
      await advance();
      const hookState = await import('../lib/github-pr-hook-state');
      const writer = jest.mocked(hookState.advancePrTrackingState);
      expect(
        writer.mock.calls[0]?.[0].currentSnapshot?.credentialScope,
      ).toBeUndefined();
      if (change === 'token replacement') {
        mockResolveGitHubToken.mockResolvedValue({
          token: 'replacement-token',
          source: 'gh-cli',
        });
      } else {
        mockAccountRead = { status: 'ok', entry: null };
      }
      await advance();
      expect(mockedFetchTracked).toHaveBeenCalledTimes(2);
      expect(
        mockedFetchTracked.mock.calls[1]?.[0].options?.authenticationToken,
      ).toBe(change === 'token replacement' ? 'replacement-token' : 'ghp_test');
      const identity = jest.requireActual<typeof CredentialModule>(
        '../lib/github-preview-credential',
      );
      expect(
        writer.mock.calls.at(-1)?.[0].currentSnapshot?.credentialScope,
      ).toBe((await identity.readGitHubPreviewCredential())?.scope);
    },
  );

  it.each([
    'token replacement',
    'account recovery',
    'account degradation',
  ] as const)(
    'handles %s during acquisition without assigning late provenance',
    async (change) => {
      mockUseActualCredential = true;
      mockAccountRead =
        change === 'account degradation'
          ? { status: 'ok', entry: null }
          : { status: 'unavailable' };
      mockFetchPullRequestSweep.mockImplementation(
        foundSweep(sweptPullRequest('s1', 'r1')),
      );
      const { mockedFetchTracked } = await setUpSweep();
      mockedFetchTracked.mockImplementationOnce(() => {
        if (change === 'token replacement')
          mockResolveGitHubToken.mockResolvedValue({
            token: 'replacement-token',
            source: 'pat',
          });
        else
          mockAccountRead =
            change === 'account recovery'
              ? { status: 'ok', entry: null }
              : { status: 'error', error: new Error('decrypt failed') };
        return Promise.resolve({
          trackingData: {
            status: openStatus,
            snapshot: createPrSnapshot(),
            branchName: 'feature-1',
            remote: { owner: 'acme', repo: 'repo' },
          },
          complete: true,
        });
      });
      await advanceUntilCallCount(
        change === 'token replacement'
          ? mockRecordGitHubRefreshFailure
          : mockRecordGitHubRefreshSuccess,
        1,
        5_000,
        60,
      );
      const hookState = await import('../lib/github-pr-hook-state');
      if (change === 'token replacement') {
        expect(hookState.advancePrTrackingState).not.toHaveBeenCalled();
        expect(mockRecordGitHubRefreshSuccess).not.toHaveBeenCalled();
      } else {
        expect(hookState.advancePrTrackingState).toHaveBeenCalledTimes(1);
        const snapshot = jest.mocked(hookState.advancePrTrackingState).mock
          .calls[0]?.[0].currentSnapshot;
        expect(snapshot).toBeTruthy();
        expect(snapshot?.credentialScope).toBeUndefined();
        expect(mockRecordGitHubRefreshFailure).not.toHaveBeenCalled();
      }
    },
  );

  it('reads a found pull request in detail only when its fingerprint moves', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(
        sweptPullRequest('s1', 'r1'),
        sweptPullRequest('s1', 'r1'),
        sweptPullRequest('s2', 'r1'),
      ),
    );
    const { mockedFetchTracked, mockedFetchRepoPrTrackingData, advance } =
      await setUpSweep();
    const hookState = await import('../lib/github-pr-hook-state');
    const advanceState = jest.mocked(hookState.advancePrTrackingState);

    await advance();
    expect(mockedFetchTracked).toHaveBeenCalledTimes(1);
    const firstRead = mockedFetchTracked.mock.calls[0]?.[0];
    expect(firstRead?.remote).toEqual({ owner: 'acme', repo: 'repo' });
    expect(firstRead?.branchName).toBe('feature-1');
    expect(firstRead?.pullRequest.number).toBe(42);
    expect(firstRead?.options?.priority).toBe('normal');
    expect(mockedFetchTracked.mock.calls[0]?.[0]).not.toHaveProperty(
      'reuseGraphQlState',
    );

    await advance();
    expect(mockedFetchTracked).toHaveBeenCalledTimes(1);
    const reused = advanceState.mock.calls[1]?.[0].currentSnapshot;
    expect(reused?.pr.number).toBe(42);
    expect(reused?.capturedAt).toBe(new Date(150_000).toISOString());

    await advance();
    expect(mockedFetchTracked).toHaveBeenCalledTimes(2);
    expect(mockedFetchRepoPrTrackingData).not.toHaveBeenCalled();
  });

  it('reads checks without the GraphQL query while only checks are in flight', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(
        sweptPullRequest('s1', 'r1', true),
        sweptPullRequest('s1', 'r1', true),
      ),
    );
    const { mockedFetchTracked, advance } = await setUpSweep();

    await advance();
    await advance();

    expect(mockedFetchTracked).toHaveBeenCalledTimes(2);
    expect(mockedFetchTracked.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        reuseGraphQlState: {
          unresolvedReviewThreadCount: undefined,
          mergeQueue: undefined,
          mergeQueueSnapshot: undefined,
        },
      }),
    );
  });

  it('reads comment collections only when remarks moved and a hook needs them', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(
        sweptPullRequest('s1', 'r1'),
        sweptPullRequest('s2', 'r1'),
        sweptPullRequest('s2', 'r2'),
      ),
    );
    const { mockedFetchTracked, advance } = await setUpSweep();
    const hookResolver = await import('../lib/hook-resolver');
    jest
      .mocked(hookResolver.getResolvedHookActions)
      .mockImplementation((_resolvedHooks, triggerName) =>
        triggerName === 'pr:update:comments'
          ? [{ type: 'command', command: 'echo comments' }]
          : null,
      );

    await advance();
    await advance();
    await advance();

    expect(
      mockedFetchTracked.mock.calls.map(
        ([args]) => args.options?.includeCommentCollections,
      ),
    ).toEqual([true, false, true]);
  });

  it('reads the comment baseline when a comment hook turns on while nothing moved', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(sweptPullRequest('s1', 'r1'), sweptPullRequest('s1', 'r1')),
    );
    const { mockedFetchTracked, advance } = await setUpSweep();
    const hookResolver = await import('../lib/hook-resolver');
    mockedFetchTracked.mockResolvedValueOnce({
      trackingData: {
        status: openStatus,
        snapshot: {
          ...createPrSnapshot(),
          includesComments: false,
          includesReviews: false,
          includesReviewComments: false,
        },
        branchName: 'feature-1',
        remote: { owner: 'acme', repo: 'repo' },
      },
      complete: true,
    });

    await advance();
    expect(
      mockedFetchTracked.mock.calls.map(
        ([args]) => args.options?.includeCommentCollections,
      ),
    ).toEqual([false]);

    jest
      .mocked(hookResolver.getResolvedHookActions)
      .mockImplementation((_resolvedHooks, triggerName) =>
        triggerName === 'pr:update:comments'
          ? [{ type: 'command', command: 'echo comments' }]
          : null,
      );
    await advance();

    expect(
      mockedFetchTracked.mock.calls.map(
        ([args]) => args.options?.includeCommentCollections,
      ),
    ).toEqual([false, true]);
  });

  it('forces a full read every 30 minutes even when nothing moved', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(sweptPullRequest('s1', 'r1')),
    );
    const { mockedFetchTracked, advance } = await setUpSweep();

    await advance();
    expect(mockedFetchTracked).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(29 * 60_000);
    await flushMicrotasks();
    expect(mockedFetchTracked).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2 * 60_000);
    await flushMicrotasks();
    expect(mockedFetchTracked).toHaveBeenCalledTimes(2);
  });

  it('reads an incompletely read pull request again on the next sweep', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(sweptPullRequest('s1', 'r1')),
    );
    const { mockedFetchTracked, advance } = await setUpSweep();
    mockedFetchTracked.mockResolvedValueOnce({
      trackingData: {
        status: openStatus,
        snapshot: null,
        branchName: 'feature-1',
        remote: { owner: 'acme', repo: 'repo' },
      },
      complete: false,
    });

    await advance();
    await advance();
    await advance();

    expect(mockedFetchTracked).toHaveBeenCalledTimes(2);
  });

  it('falls back to per-pull-request reads when the batch fails', async () => {
    mockFetchPullRequestSweep.mockRejectedValue(new Error('GraphQL failed'));
    const { mockedFetchTracked, mockedFetchRepoPrTrackingData, advance } =
      await setUpSweep();

    await advance();

    expect(mockedFetchTracked).not.toHaveBeenCalled();
    expect(mockedFetchRepoPrTrackingData).toHaveBeenCalledWith(
      '/mock/workspaces/project-a/worktrees/worktree-a',
      'feature-1',
      expect.objectContaining({ priority: 'normal', caller: 'pr-poller' }),
    );
  });

  it('backs off to the refusal retry time without falling back', async () => {
    const { mockedFetchRepoPrTrackingData } = await setUpSweep();
    mockFetchPullRequestSweep.mockRejectedValueOnce(
      await refusal(30_000 + 10 * 60_000, 'graphql'),
    );

    await advanceUntilCallCount(mockFetchPullRequestSweep, 1);
    await jest.advanceTimersByTimeAsync(9 * 60_000);
    await flushMicrotasks();
    expect(mockFetchPullRequestSweep).toHaveBeenCalledTimes(1);
    expect(mockedFetchRepoPrTrackingData).not.toHaveBeenCalled();
    expect(mockRecordGitHubRefreshFailure).not.toHaveBeenCalled();

    await advanceUntilCallCount(mockFetchPullRequestSweep, 2, 5_000, 30);
    expect(jest.now()).toBe(30_000 + 10 * 60_000);
  });

  it('reschedules a worktree whose read was refused at the refusal retry time', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(sweptPullRequest('s1', 'r1')),
    );
    const { mockedFetchTracked } = await setUpSweep();
    const retryAt = 30_000 + 7 * 60_000;
    mockedFetchTracked.mockRejectedValueOnce(await refusal(retryAt, 'core'));

    await advanceUntilCallCount(mockRecordGitHubRefreshFailure, 1);
    const hookState = await import('../lib/github-pr-hook-state');
    expect(hookState.advancePrTrackingState).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(retryAt - jest.now() - 1_000);
    await flushMicrotasks();
    expect(mockFetchPullRequestSweep).toHaveBeenCalledTimes(1);

    await advanceUntilCallCount(mockRecordGitHubRefreshSuccess, 1);
    expect(mockFetchPullRequestSweep).toHaveBeenCalledTimes(2);
    expect(jest.now()).toBe(retryAt);
  });

  it('sends one lookup per repository across a multi-repo workspace', async () => {
    const { poller } = await importFreshPoller();
    const registry = await import('../lib/workspace-registry');
    const entries = await import('../lib/worktree-repo-entries');
    const gitModule = await import('../lib/git');
    const pr = await import('../lib/github-pr');

    jest.mocked(registry.isMultiRepoWorkspace).mockReturnValue(true);
    jest
      .mocked(entries.listWorkspaceWorktreeRepoEntries)
      .mockImplementation((_projectId, cwd) =>
        Promise.resolve([
          { repoId: 'api', repoName: 'API', repoPath: `${cwd}/api` },
          { repoId: 'web', repoName: 'Web', repoPath: `${cwd}/web` },
        ]),
      );
    jest
      .mocked(gitModule.getCurrentBranch)
      .mockImplementation((repoPath) =>
        Promise.resolve(
          repoPath.includes('worktree-a') ? 'branch-a' : 'branch-b',
        ),
      );
    jest.mocked(pr.resolveGitHubRemoteForRepo).mockImplementation((repoPath) =>
      Promise.resolve({
        owner: 'acme',
        repo: repoPath.endsWith('/api') ? 'api' : 'web',
      }),
    );

    poller.startPolling(() => createWindow());
    poller.syncTrackedWorktrees([
      createTrackedItem({ projectId: 'project-a', worktreeId: 'worktree-a' }),
      createTrackedItem({ projectId: 'project-a', worktreeId: 'worktree-b' }),
    ]);
    await flushMicrotasks();
    await advanceUntilCallCount(mockRecordGitHubRefreshSuccess, 2);

    expect(
      mockFetchPullRequestSweep.mock.calls.map((call: unknown[]): unknown[] => [
        call[1],
        call[2],
      ]),
    ).toEqual([
      [{ owner: 'acme', repo: 'api' }, ['branch-a', 'branch-b']],
      [{ owner: 'acme', repo: 'web' }, ['branch-a', 'branch-b']],
    ]);
  });

  it('keeps no sweep state from a worktree refresh that failed in another repository', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(sweptPullRequest('s1', 'r1')),
    );
    const { poller } = await importFreshPoller();
    const registry = await import('../lib/workspace-registry');
    const entries = await import('../lib/worktree-repo-entries');
    const pr = await import('../lib/github-pr');
    jest.mocked(registry.isMultiRepoWorkspace).mockReturnValue(true);
    jest
      .mocked(entries.listWorkspaceWorktreeRepoEntries)
      .mockImplementation((_projectId, cwd) =>
        Promise.resolve([
          { repoId: 'api', repoName: 'API', repoPath: `${cwd}/api` },
          { repoId: 'web', repoName: 'Web', repoPath: `${cwd}/web` },
        ]),
      );
    jest.mocked(pr.resolveGitHubRemoteForRepo).mockImplementation((repoPath) =>
      Promise.resolve({
        owner: 'acme',
        repo: repoPath.endsWith('/api') ? 'api' : 'web',
      }),
    );
    const fetchTracked = jest.mocked(pr.fetchTrackedPullRequestData);
    let webFailures = 1;
    fetchTracked.mockImplementation(({ remote }) => {
      if (remote.repo === 'web' && webFailures > 0) {
        webFailures -= 1;
        return Promise.reject(new Error('GitHub is down'));
      }
      return Promise.resolve({
        trackingData: {
          status: openStatus,
          snapshot: createPrSnapshot(),
          branchName: 'feature-1',
          remote,
        },
        complete: true,
      });
    });

    poller.startPolling(() => createWindow());
    poller.syncTrackedWorktrees([
      createTrackedItem({ projectId: 'project-a', worktreeId: 'worktree-a' }),
    ]);
    await flushMicrotasks();
    await advanceUntilCallCount(mockRecordGitHubRefreshFailure, 1, 5_000, 60);
    await advanceUntilCallCount(mockRecordGitHubRefreshSuccess, 1, 5_000, 60);

    const apiReads = fetchTracked.mock.calls.filter(
      ([args]) => args.remote.repo === 'api',
    );
    expect(apiReads).toHaveLength(2);
  });

  it('reports every swept pull request to listeners', async () => {
    mockFetchPullRequestSweep.mockImplementation(
      foundSweep(sweptPullRequest('s1', 'r1')),
    );
    const { advance } = await setUpSweep();
    const sweep = await import('../lib/github-pr-sweep');
    const events: PullRequestSweptEvent[] = [];
    const unsubscribe = sweep.onPullRequestSwept((event) => events.push(event));

    await advance();
    unsubscribe();

    expect(events).toEqual([
      {
        owner: 'acme',
        repo: 'repo',
        number: 42,
        fingerprint: { status: 's1', remarks: 'r1' },
        status: openStatus,
      },
    ]);
  });
});

describe('isPrHookActiveForRepo', () => {
  const QUEUE_REMOVED = 'pr:queue:removed';

  async function setup(options: {
    multiRepo?: boolean;
    configuredFor?: string[];
    pausedHookKeys?: string[];
  }): Promise<typeof GitHubPollerModule> {
    const { poller } = await importFreshPoller();
    const hookResolver = await import('../lib/hook-resolver');
    const workspacePersistence = await import('../lib/workspace-persistence');
    const registry = await import('../lib/workspace-registry');
    const repoEntries = await import('../lib/worktree-repo-entries');
    jest
      .mocked(registry.isMultiRepoWorkspace)
      .mockReturnValue(options.multiRepo === true);
    jest
      .mocked(repoEntries.listWorkspaceWorktreeRepoEntries)
      .mockResolvedValue([
        { repoId: 'repo-a', repoName: 'a', repoPath: '/w/a' },
        { repoId: 'repo-b', repoName: 'b', repoPath: '/w/b' },
      ] as never);
    // Each resolver call returns a marker naming its scope, and only the
    // configured scopes report actions for the trigger.
    jest
      .mocked(hookResolver.resolveProjectHooks)
      .mockResolvedValue({ scope: 'project' } as never);
    jest
      .mocked(hookResolver.resolveWorkspaceRepoHooks)
      .mockImplementation((_projectId, repoId) =>
        Promise.resolve({ scope: repoId } as never),
      );
    jest
      .mocked(hookResolver.getResolvedHookActions)
      .mockImplementation((resolvedHooks, triggerName) => {
        const scope = (resolvedHooks as unknown as { scope: string }).scope;
        return triggerName === QUEUE_REMOVED &&
          (options.configuredFor ?? []).includes(scope)
          ? [{ type: 'command', command: 'echo requeue' }]
          : null;
      });
    jest.mocked(workspacePersistence.readWorkspaceWorktrees).mockResolvedValue([
      {
        id: 'worktree-a',
        branchName: 'feature-1',
        createdAt: '2026-04-16T00:00:00.000Z',
        pausedHookKeys: options.pausedHookKeys ?? [],
      },
    ]);
    return poller;
  }

  const target = {
    projectId: 'project-a',
    worktreeId: 'worktree-a',
    triggerName: QUEUE_REMOVED,
  };

  it('is true for a configured, unpaused project hook', async () => {
    const poller = await setup({ configuredFor: ['project'] });
    await expect(poller.isPrHookActiveForRepo(target)).resolves.toBe(true);
  });

  it('is false when the hook is paused in the worktree', async () => {
    const poller = await setup({
      configuredFor: ['project'],
      pausedHookKeys: ['project:pr:queue:removed'],
    });
    await expect(poller.isPrHookActiveForRepo(target)).resolves.toBe(false);
  });

  it('is false when no hook is configured', async () => {
    const poller = await setup({});
    await expect(poller.isPrHookActiveForRepo(target)).resolves.toBe(false);
  });

  it("resolves the PR repository's own scope in a multi-repo project", async () => {
    const poller = await setup({ multiRepo: true, configuredFor: ['repo-a'] });
    await expect(
      poller.isPrHookActiveForRepo({ ...target, repoId: 'repo-a' }),
    ).resolves.toBe(true);
    await expect(
      poller.isPrHookActiveForRepo({ ...target, repoId: 'repo-b' }),
    ).resolves.toBe(false);
  });
});
