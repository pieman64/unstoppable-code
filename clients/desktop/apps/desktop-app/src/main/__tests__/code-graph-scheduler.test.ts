const mockExistsSync = jest.fn<boolean, [string]>();
jest.mock('node:fs', () => ({
  existsSync: (path: string): boolean => mockExistsSync(path),
}));

const mockIsE2eBuild = jest.fn<boolean, []>();
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockIsE2eBuild(),
}));

const mockResolveWorktreeCwd = jest.fn();
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (...args: unknown[]): unknown =>
    mockResolveWorktreeCwd(...args),
}));

const mockListWorkspaceWorktreeRepoEntries = jest.fn();
const mockResolveWorktreeCodeGraphRepositories = jest.fn();
jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: (...args: unknown[]): unknown =>
    mockListWorkspaceWorktreeRepoEntries(...args),
  resolveWorktreeCodeGraphRepositories: (...args: unknown[]): unknown =>
    mockResolveWorktreeCodeGraphRepositories(...args),
}));

const mockFingerprintCodeGraphWorktree = jest.fn<Promise<string>, unknown[]>();
const mockCancelCodeGraphFingerprint = jest.fn();
jest.mock('../code-graph/fingerprint-runner', () => ({
  cancelCodeGraphFingerprint: (...args: unknown[]): unknown =>
    mockCancelCodeGraphFingerprint(...args),
  runCodeGraphWorkerFingerprint: async (
    ...args: unknown[]
  ): Promise<unknown> => ({
    ok: true,
    fingerprint: await mockFingerprintCodeGraphWorktree(...args),
  }),
}));
const mockReadPersistedCodeGraphWorktreeFingerprint = jest.fn<
  string | null,
  unknown[]
>();
const mockPersistedFingerprintReadFailed = jest.fn<boolean, []>();
const mockPersistedSchemaVersion = jest.fn<number | null, []>();
const mockPersistedExtractorVersion = jest.fn<number | null, []>();
const mockPersistedCompleted = jest.fn<boolean, []>();
const mockPersistedDerivedPending = jest.fn<boolean | undefined, []>();
const mockPersistedCacheHit = jest.fn<boolean, []>(() => false);
const mockClearCodeGraphWorktreeFingerprintCache = jest.fn();
jest.mock('../lib/code-graph-worktree-fingerprint', () => ({
  clearCodeGraphWorktreeFingerprintCache: (...args: unknown[]): unknown =>
    mockClearCodeGraphWorktreeFingerprintCache(...args),
  readPersistedCodeGraphWorktreeFingerprintSnapshot: (
    ...args: unknown[]
  ): unknown => ({
    fingerprint: mockReadPersistedCodeGraphWorktreeFingerprint(...args),
    schemaVersion: mockPersistedSchemaVersion(),
    extractorVersion: mockPersistedExtractorVersion(),
    completed: mockPersistedCompleted(),
    derivedPending: mockPersistedDerivedPending(),
    cacheHit: mockPersistedCacheHit(),
    readFailed: mockPersistedFingerprintReadFailed(),
    durationMs: 2,
  }),
}));

const mockRecordCodeGraphRefreshTelemetry = jest.fn();
jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphRefreshTelemetry: (...args: unknown[]): unknown =>
    mockRecordCodeGraphRefreshTelemetry(...args),
}));

interface MockScheduledBuildInput {
  projectId: string;
  worktreeId: string;
  reason: 'worktree-created' | 'refresh';
  observedFingerprint?: string;
  observedFingerprintMs?: number;
}

const mockRunWorktreeCodeGraphBuild = jest.fn<
  Promise<unknown>,
  [MockScheduledBuildInput]
>();
const mockCancelBuild = jest.fn();
const mockIsCodeGraphBuildPending = jest.fn<boolean, [string]>();
jest.mock('../code-graph/build-runner', () => ({
  cancelBuild: (...args: unknown[]): unknown => mockCancelBuild(...args),
  isCodeGraphBuildPending: (key: string): boolean =>
    mockIsCodeGraphBuildPending(key),
}));
const mockCancelScheduledCodeGraphBuilds = jest.fn();
// The scheduler's builds run as initiated work (CAN-5617); this stands in
// for the run: its gates, its start, and the worker build it dispatches.
jest.mock('../code-graph/scheduled-builds', () => ({
  startScheduledCodeGraphBuild: async (build: {
    projectId: string;
    worktreeId: string;
    trigger: 'worktree-created' | 'refresh';
    observedFingerprint: string;
    observedFingerprintMs: number;
    available(): boolean;
    canceled(): boolean;
    onStarted?(): void;
  }): Promise<string> => {
    if (!build.available() || build.canceled()) return 'skipped';
    build.onStarted?.();
    await mockRunWorktreeCodeGraphBuild({
      projectId: build.projectId,
      worktreeId: build.worktreeId,
      reason: build.trigger,
      observedFingerprint: build.observedFingerprint,
      observedFingerprintMs: build.observedFingerprintMs,
    });
    return 'succeeded';
  },
  cancelScheduledCodeGraphBuilds: (...args: unknown[]): unknown =>
    mockCancelScheduledCodeGraphBuilds(...args),
}));
const mockReadAllSidebarItems = jest.fn<Promise<unknown>, []>();
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> => mockReadAllSidebarItems(),
}));

const mockIsEnabled = jest.fn();
jest.mock('../feature-flags', (): unknown => ({
  getFeatureFlagService: () => ({
    isEnabled: mockIsEnabled,
  }),
}));

import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
} from '@canopy/desktop-shared/types/code-graph';
import {
  cancelCodeGraphBuilds,
  deferCodeGraphRefreshUntilPostCreateSetup,
  nudgeCodeGraphRefreshAfterDiffStats,
  isCodeGraphPerformanceSchedulerEnabled,
  reconcileCodeGraphSchedulerAvailability,
  scheduleCodeGraphBuild,
  scheduleCodeGraphFollowupBuild,
} from '../lib/code-graph-scheduler';
import {
  codeGraphFirstRequestedAt,
  noteCodeGraphFirstRequest,
  resetCodeGraphBuildDiagnosticsForTests,
} from '../lib/code-graph-build-diagnostics';

describe('Code Graph performance scheduler gate', () => {
  it('requires both the E2E build and the explicit performance opt-in', () => {
    expect(
      isCodeGraphPerformanceSchedulerEnabled(true, {
        CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER: '1',
      }),
    ).toBe(true);
    expect(isCodeGraphPerformanceSchedulerEnabled(true, {})).toBe(false);
    expect(
      isCodeGraphPerformanceSchedulerEnabled(false, {
        CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER: '1',
      }),
    ).toBe(false);
  });
});

const DEFAULT_DEBOUNCE_MS = 5_000;
const REFRESH_DEBOUNCE_MS = 20_000;

function okBuildResponse(): {
  ok: true;
  result: {
    filesScanned: number;
    filesParsed: number;
    filesUnchanged: number;
    filesRemoved: number;
    filesSkipped: number;
    parseFailures: number;
    symbolCount: number;
    edgeCount: number;
    durationMs: number;
    derived: unknown[];
    customLanguages: null;
  };
} {
  return {
    ok: true,
    result: {
      filesScanned: 1,
      filesParsed: 1,
      filesUnchanged: 0,
      filesRemoved: 0,
      filesSkipped: 0,
      parseFailures: 0,
      symbolCount: 1,
      edgeCount: 0,
      durationMs: 5,
      derived: [],
      customLanguages: null,
    },
  };
}

// The scheduler also passes how long its fingerprint read took.
const anyNumber: unknown = expect.any(Number);

async function flushMicrotasks(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
}

describe('code graph scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockIsE2eBuild.mockReturnValue(false);
    mockExistsSync.mockReturnValue(true);
    mockResolveWorktreeCwd.mockReturnValue('/repo');
    mockListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      { repoId: 'fixture', repoName: 'Fixture', repoPath: '/repo' },
    ]);
    mockResolveWorktreeCodeGraphRepositories.mockResolvedValue([
      { repoId: 'fixture', rootPath: '/repo' },
    ]);
    mockFingerprintCodeGraphWorktree.mockReset();
    mockFingerprintCodeGraphWorktree.mockResolvedValue('current-fingerprint');
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'prior-fingerprint',
    );
    mockPersistedFingerprintReadFailed.mockReturnValue(false);
    mockPersistedSchemaVersion.mockReturnValue(CODE_GRAPH_SCHEMA_VERSION);
    mockPersistedExtractorVersion.mockReturnValue(CODE_GRAPH_EXTRACTOR_VERSION);
    mockPersistedCompleted.mockReturnValue(false);
    mockRunWorktreeCodeGraphBuild.mockResolvedValue(okBuildResponse());
    mockReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    resetCodeGraphBuildDiagnosticsForTests();
  });

  afterEach(() => {
    cancelCodeGraphBuilds('proj', 'wt');
    cancelCodeGraphBuilds('nudge-project', 'nudge-worktree');
    jest.useRealTimers();
  });

  it('fires once after the debounce interval', async () => {
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
      observedFingerprint: 'current-fingerprint',
      observedFingerprintMs: anyNumber,
    });
  });

  it('remembers the earliest request for a graph the worktree never completed', async () => {
    const firstRequestedAt = Date.now();
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });
    await jest.advanceTimersByTimeAsync(1_000);
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'refresh',
    });
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
    expect(codeGraphFirstRequestedAt('proj/wt')).toBe(firstRequestedAt);
  });

  it('forgets a first-graph request once the worktree has a completed graph', async () => {
    mockPersistedCompleted.mockReturnValue(true);
    noteCodeGraphFirstRequest('proj/wt', 1);
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(codeGraphFirstRequestedAt('proj/wt')).toBeUndefined();
  });

  it('forgets a first-graph request when the worktree builds are canceled', () => {
    noteCodeGraphFirstRequest('proj/wt', 1);
    cancelCodeGraphBuilds('proj', 'wt');
    expect(codeGraphFirstRequestedAt('proj/wt')).toBeUndefined();
  });

  it('coalesces multiple rapid schedules into one build', async () => {
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });

    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('uses a trailing debounce for repeated observed refreshes', async () => {
    scheduleCodeGraphBuild({
      projectId: 'trailing-project',
      worktreeId: 'trailing-worktree',
      reason: 'refresh',
      source: 'turn-diff',
    });
    await jest.advanceTimersByTimeAsync(10_000);
    scheduleCodeGraphBuild({
      projectId: 'trailing-project',
      worktreeId: 'trailing-worktree',
      reason: 'refresh',
      source: 'turn-diff',
    });

    await jest.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('fingerprint-gates direct automatic refresh requests', async () => {
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'current-fingerprint',
    );

    scheduleCodeGraphBuild({
      projectId: 'direct-refresh-project',
      worktreeId: 'direct-refresh-worktree',
      reason: 'refresh',
      source: 'turn-diff',
    });
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
    expect(mockRecordCodeGraphRefreshTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'turn-diff',
        outcome: 'fingerprint-unchanged',
      }),
    );
  });

  it('rebuilds an unchanged worktree when graph versions are stale', async () => {
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'current-fingerprint',
    );
    mockPersistedExtractorVersion.mockReturnValue(
      CODE_GRAPH_EXTRACTOR_VERSION - 1,
    );

    scheduleCodeGraphBuild({
      projectId: 'stale-version-project',
      worktreeId: 'stale-version-worktree',
      reason: 'refresh',
      source: 'turn-diff',
      debounceMs: 0,
    });
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledWith({
      projectId: 'stale-version-project',
      worktreeId: 'stale-version-worktree',
      reason: 'refresh',
      observedFingerprint: 'current-fingerprint',
      observedFingerprintMs: anyNumber,
    });
  });

  it('rebuilds an unchanged worktree whose graph predates the schema version', async () => {
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'current-fingerprint',
    );
    mockPersistedSchemaVersion.mockReturnValue(CODE_GRAPH_SCHEMA_VERSION - 1);

    scheduleCodeGraphBuild({
      projectId: 'stale-schema-project',
      worktreeId: 'stale-schema-worktree',
      reason: 'refresh',
      source: 'turn-diff',
      debounceMs: 0,
    });
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledWith({
      projectId: 'stale-schema-project',
      worktreeId: 'stale-schema-worktree',
      reason: 'refresh',
      observedFingerprint: 'current-fingerprint',
      observedFingerprintMs: anyNumber,
    });
  });

  it('does not rebuild over a graph written by a newer schema', async () => {
    mockPersistedSchemaVersion.mockReturnValue(CODE_GRAPH_SCHEMA_VERSION + 1);
    mockPersistedCompleted.mockReturnValue(true);

    scheduleCodeGraphBuild({
      projectId: 'newer-schema-project',
      worktreeId: 'newer-schema-worktree',
      reason: 'refresh',
      source: 'turn-diff',
      debounceMs: 0,
    });
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
    expect(mockRecordCodeGraphRefreshTelemetry).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'build-started' }),
    );
  });

  it('rebuilds an unchanged worktree whose derived analysis was left pending (phase 20)', async () => {
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'current-fingerprint',
    );
    mockPersistedDerivedPending.mockReturnValue(true);
    mockIsCodeGraphBuildPending.mockReturnValue(false);

    scheduleCodeGraphBuild({
      projectId: 'derived-pending-project',
      worktreeId: 'derived-pending-worktree',
      reason: 'refresh',
      source: 'turn-diff',
      debounceMs: 0,
    });
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledWith({
      projectId: 'derived-pending-project',
      worktreeId: 'derived-pending-worktree',
      reason: 'refresh',
      observedFingerprint: 'current-fingerprint',
      observedFingerprintMs: anyNumber,
    });
    mockPersistedDerivedPending.mockReset();
  });

  it('rereads a cached pending derived marker before rebuilding, so a finished analysis is not rebuilt (phase 20)', async () => {
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'current-fingerprint',
    );
    // The cached snapshot predates the drain that finished the analysis:
    // the drain's WAL writes left graph.db's stat, the cache key, unchanged.
    mockPersistedCacheHit.mockReturnValueOnce(true);
    mockPersistedDerivedPending
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    mockIsCodeGraphBuildPending.mockReturnValue(false);

    scheduleCodeGraphBuild({
      projectId: 'derived-cached-project',
      worktreeId: 'derived-cached-worktree',
      reason: 'refresh',
      source: 'turn-diff',
      debounceMs: 0,
    });
    await flushMicrotasks();

    expect(mockClearCodeGraphWorktreeFingerprintCache).toHaveBeenCalled();
    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
    mockPersistedDerivedPending.mockReset();
    mockPersistedCacheHit.mockReset();
    mockPersistedCacheHit.mockReturnValue(false);
  });

  it('leaves a pending derived analysis to the build or drain already running for the worktree (phase 20)', async () => {
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'current-fingerprint',
    );
    mockPersistedDerivedPending.mockReturnValue(true);
    mockIsCodeGraphBuildPending.mockReturnValue(true);

    scheduleCodeGraphBuild({
      projectId: 'derived-draining-project',
      worktreeId: 'derived-draining-worktree',
      reason: 'refresh',
      source: 'turn-diff',
      debounceMs: 0,
    });
    await flushMicrotasks();

    expect(mockIsCodeGraphBuildPending).toHaveBeenCalledWith(
      'derived-draining-project/derived-draining-worktree',
    );
    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
    expect(mockRecordCodeGraphRefreshTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'fingerprint-unchanged' }),
    );
    mockPersistedDerivedPending.mockReset();
    mockIsCodeGraphBuildPending.mockReset();
  });

  it('does not start a build when SQLite fingerprint metadata cannot be read', async () => {
    mockPersistedFingerprintReadFailed.mockReturnValue(true);

    scheduleCodeGraphBuild({
      projectId: 'metadata-error-project',
      worktreeId: 'metadata-error-worktree',
      reason: 'worktree-created',
      debounceMs: 0,
    });
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
    expect(mockRecordCodeGraphRefreshTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'worktree-created',
        outcome: 'fingerprint-error',
        metadataCacheHit: false,
      }),
    );
  });

  it('does not postpone an initial build when a refresh arrives', async () => {
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });
    await jest.advanceTimersByTimeAsync(1_000);

    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'refresh',
    });
    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS - 1_000);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
      observedFingerprint: 'current-fingerprint',
      observedFingerprintMs: anyNumber,
    });
  });

  it('does not schedule any build under the E2E build', async () => {
    mockIsE2eBuild.mockReturnValue(true);
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });

    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('does not schedule any build when the code-graph feature flag is off', async () => {
    mockIsEnabled.mockReturnValue(false);
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });

    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('rechecks availability when an already-created debounce timer fires', async () => {
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });
    mockIsEnabled.mockReturnValue(false);

    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('cancels newly unavailable work and reschedules existing worktrees on re-enable', async () => {
    scheduleCodeGraphBuild({
      projectId: 'reconcile-project',
      worktreeId: 'reconcile-worktree',
      reason: 'worktree-created',
      debounceMs: 60_000,
    });
    mockIsEnabled.mockReturnValue(false);
    await reconcileCodeGraphSchedulerAvailability();

    expect(mockCancelBuild).toHaveBeenCalledWith(
      'reconcile-project/reconcile-worktree',
      expect.objectContaining({ reason: 'unavailable' }),
    );
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();

    mockIsEnabled.mockReturnValue(true);
    mockReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'reconcile-project',
          worktrees: [{ id: 'reconcile-worktree' }],
        },
      ],
    });
    await reconcileCodeGraphSchedulerAvailability();
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'reconcile-project',
        worktreeId: 'reconcile-worktree',
        reason: 'worktree-created',
        observedFingerprint: 'current-fingerprint',
      }),
    );
  });

  it('does not rebuild an unchanged graph during availability reconciliation', async () => {
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'current-fingerprint',
    );
    mockReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'reconcile-project',
          worktrees: [{ id: 'reconcile-worktree' }],
        },
      ],
    });

    await reconcileCodeGraphSchedulerAvailability();
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
    expect(mockRecordCodeGraphRefreshTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'availability-reconcile',
        outcome: 'fingerprint-unchanged',
      }),
    );
  });

  it('schedules a build when the code-graph feature flag is on', async () => {
    mockIsEnabled.mockReturnValue(true);
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });

    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('skips scheduling for cowork projects', async () => {
    scheduleCodeGraphBuild({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'home',
      reason: 'worktree-created',
    });

    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('skips scheduling for the App Advisor assistant sentinel', async () => {
    scheduleCodeGraphBuild({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      reason: 'worktree-created',
    });

    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('clears the pending timer when canceled', async () => {
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });
    cancelCodeGraphBuilds('proj', 'wt');

    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('cancelCodeGraphBuilds also cancels any in-flight worker build for the same key', () => {
    // Composition, not replacement: cancelling a scheduled build must cancel
    // the off-main worker build routed through the same
    // `${projectId}/${worktreeId}` key, not just clear the debounce timer.
    cancelCodeGraphBuilds('proj', 'wt');

    expect(mockCancelBuild).toHaveBeenCalledWith('proj/wt');
  });

  it('never throws out of the scheduled block when the instrumented build service throws', async () => {
    mockRunWorktreeCodeGraphBuild.mockRejectedValue(
      new Error('no target registered'),
    );

    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });

    await expect(
      (async (): Promise<void> => {
        await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
        await flushMicrotasks();
      })(),
    ).resolves.toBeUndefined();
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('refires a build requested mid-build from the finally block', async () => {
    let resolveFirstBuild: (value: unknown) => void = () => {};
    const firstBuild = new Promise((resolve) => {
      resolveFirstBuild = resolve;
    });
    mockRunWorktreeCodeGraphBuild
      .mockReturnValueOnce(firstBuild)
      .mockResolvedValueOnce(okBuildResponse());

    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);

    // A second schedule arrives while the first build is still in flight.
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'refresh',
    });
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();

    // The second build must not run concurrently with the first.
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);

    resolveFirstBuild(okBuildResponse());
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(2);
  });

  it('never runs a pending build after cancellation (worktree deletion path)', async () => {
    // Worktree created → build debounced (pending timer).
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });
    // Worktree deleted → cleanup's 'code graph engine' task cancels builds.
    cancelCodeGraphBuilds('proj', 'wt');

    // The full debounce window elapses; the timer must be dead, so the
    // worker runner is never asked to build (which would resurrect graph.db
    // for the just-deleted worktree).
    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('suppresses an in-flight build refire when canceled mid-build', async () => {
    let resolveFirstBuild: (value: unknown) => void = () => {};
    const firstBuild = new Promise((resolve) => {
      resolveFirstBuild = resolve;
    });
    mockRunWorktreeCodeGraphBuild.mockReturnValueOnce(firstBuild);

    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'worktree-created',
    });
    await jest.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);

    // A refire is requested while the first build is still running.
    scheduleCodeGraphBuild({
      projectId: 'proj',
      worktreeId: 'wt',
      reason: 'refresh',
    });
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);

    // The worktree is deleted (cleanup cancels) before the first build settles.
    cancelCodeGraphBuilds('proj', 'wt');
    resolveFirstBuild(okBuildResponse());
    await flushMicrotasks();

    // The pending refire must be suppressed — no second build resurrects the
    // deleted worktree's graph.
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('fingerprint-gates diff-stat refresh nudges', async () => {
    scheduleCodeGraphBuild({
      projectId: 'nudge-project',
      worktreeId: 'nudge-worktree',
      reason: 'worktree-created',
      debounceMs: 60_000,
    });
    nudgeCodeGraphRefreshAfterDiffStats('nudge-project', 'nudge-worktree');
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledWith({
      projectId: 'nudge-project',
      worktreeId: 'nudge-worktree',
      reason: 'refresh',
      observedFingerprint: 'current-fingerprint',
      observedFingerprintMs: anyNumber,
    });

    mockRunWorktreeCodeGraphBuild.mockClear();
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'current-fingerprint',
    );
    nudgeCodeGraphRefreshAfterDiffStats('nudge-project', 'nudge-worktree');
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('does not let a diff-stat nudge own the first graph build', async () => {
    mockExistsSync.mockReturnValue(false);

    nudgeCodeGraphRefreshAfterDiffStats('nudge-project', 'nudge-worktree');
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockFingerprintCodeGraphWorktree).not.toHaveBeenCalled();
    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('defers eager-graph refresh nudges until post-create setup settles', async () => {
    const release = deferCodeGraphRefreshUntilPostCreateSetup(
      'nudge-project',
      'nudge-worktree',
    );

    nudgeCodeGraphRefreshAfterDiffStats('nudge-project', 'nudge-worktree');
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    expect(mockFingerprintCodeGraphWorktree).not.toHaveBeenCalled();

    scheduleCodeGraphBuild({
      projectId: 'nudge-project',
      worktreeId: 'nudge-worktree',
      reason: 'worktree-created',
      debounceMs: 0,
    });
    await flushMicrotasks();
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);

    release();

    mockRunWorktreeCodeGraphBuild.mockClear();
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'older-fingerprint',
    );
    nudgeCodeGraphRefreshAfterDiffStats('nudge-project', 'nudge-worktree');
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('releases a post-create refresh deferral when setup never starts', async () => {
    const release = deferCodeGraphRefreshUntilPostCreateSetup(
      'release-project',
      'release-worktree',
    );

    release();
    nudgeCodeGraphRefreshAfterDiffStats('release-project', 'release-worktree');
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('does not retain a pre-build fingerprint after a successful build', async () => {
    mockFingerprintCodeGraphWorktree.mockResolvedValue('fingerprint-a');
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'prior-fingerprint',
    );

    scheduleCodeGraphBuild({
      projectId: 'nudge-project',
      worktreeId: 'nudge-worktree',
      reason: 'worktree-created',
      debounceMs: 60_000,
    });
    nudgeCodeGraphRefreshAfterDiffStats('nudge-project', 'nudge-worktree');
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);

    mockRunWorktreeCodeGraphBuild.mockClear();
    mockReadPersistedCodeGraphWorktreeFingerprint.mockReturnValue(
      'fingerprint-b',
    );
    nudgeCodeGraphRefreshAfterDiffStats('nudge-project', 'nudge-worktree');
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('does not let a fingerprint check or build follow-up resurrect a canceled worktree', async () => {
    let resolveFingerprint: (value: string) => void = () => undefined;
    mockFingerprintCodeGraphWorktree.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveFingerprint = resolve;
      }),
    );
    scheduleCodeGraphBuild({
      projectId: 'nudge-project',
      worktreeId: 'nudge-worktree',
      reason: 'worktree-created',
      debounceMs: 0,
    });
    await flushMicrotasks();
    expect(mockFingerprintCodeGraphWorktree).toHaveBeenCalledTimes(1);
    cancelCodeGraphBuilds('nudge-project', 'nudge-worktree');
    scheduleCodeGraphFollowupBuild({
      projectId: 'nudge-project',
      worktreeId: 'nudge-worktree',
    });
    resolveFingerprint('late-fingerprint');
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(mockRunWorktreeCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('does not let an old fingerprint check race a newly recreated worktree', async () => {
    let resolveOldFingerprint: (value: string) => void = () => undefined;
    mockFingerprintCodeGraphWorktree.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveOldFingerprint = resolve;
      }),
    );
    scheduleCodeGraphBuild({
      projectId: 'recreated-project',
      worktreeId: 'recreated-worktree',
      reason: 'refresh',
      debounceMs: 0,
    });
    await flushMicrotasks();
    expect(mockFingerprintCodeGraphWorktree).toHaveBeenCalledTimes(1);

    cancelCodeGraphBuilds('recreated-project', 'recreated-worktree');
    scheduleCodeGraphBuild({
      projectId: 'recreated-project',
      worktreeId: 'recreated-worktree',
      reason: 'worktree-created',
      debounceMs: 0,
    });
    await flushMicrotasks();

    resolveOldFingerprint('stale-fingerprint');
    await flushMicrotasks();
    await flushMicrotasks();

    const recreatedCalls = mockRunWorktreeCodeGraphBuild.mock.calls.filter(
      ([input]) => input.projectId === 'recreated-project',
    );
    expect(recreatedCalls).toHaveLength(1);
    expect(mockRunWorktreeCodeGraphBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'recreated-project',
        worktreeId: 'recreated-worktree',
        reason: 'worktree-created',
        observedFingerprint: 'current-fingerprint',
      }),
    );
  });
});
