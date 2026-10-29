import type {
  SessionDiagnosticRecord,
  CodeGraphReadDiagnosticRepository,
} from '../observability/service';

jest.mock('node:crypto', () => ({
  randomUUID: jest.fn(() => 'telemetry-uuid'),
}));

jest.mock('@canopy/desktop-instrumentation', () => ({
  createDesktopInstrumentationOperationKey: jest.fn(
    (seed: string) => `hashed:${seed.length}`,
  ),
}));

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  failDesktopOperation: jest.fn(),
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

jest.mock('../code-graph/build-runner', () => ({
  CodeGraphWorkerBuildError: class CodeGraphWorkerBuildError extends Error {
    public constructor(
      public readonly reason: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import {
  failDesktopOperation,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { CodeGraphWorkerBuildError } from '../code-graph/build-runner';
import {
  recordCodeGraphReadDiagnostic,
  flushCodeGraphReadDiagnostics,
  setCodeGraphReadDiagnosticRecorderForTests,
  resetCodeGraphReadDiagnosticsForTests,
  recordCodeGraphSummaryFanoutDiagnostic,
  codeGraphGenerationFailureReason,
  completeCodeGraphGenerationTelemetry,
  failCodeGraphGenerationTelemetry,
  flushCodeGraphQueryTelemetry,
  flushCodeGraphRefreshTelemetry,
  recordCodeGraphQueryTelemetry,
  recordCodeGraphRefreshTelemetry,
  startCodeGraphGenerationTelemetry,
} from '../lib/code-graph-telemetry';

describe('code graph generation telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(1_250);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits privacy-safe worktree generation counts and timings to Datadog', () => {
    const handle = startCodeGraphGenerationTelemetry({
      operationSeed: '/private/workspace/raw-worktree-id',
      scope: 'worktree',
      trigger: 'refresh',
      repositoryCount: 2,
    });
    completeCodeGraphGenerationTelemetry(handle, {
      result: {
        filesScanned: 12,
        filesParsed: 3,
        filesUnchanged: 8,
        filesSkipped: 1,
        filesRemoved: 2,
        parseFailures: 1,
        symbolCount: 40,
        edgeCount: 50,
        durationMs: 200,
        factsChanged: true,
        customLanguages: null,
        derived: [
          {
            repoId: 'private-repo-id',
            computed: true,
            communityCount: 4,
            flowCount: 5,
            communitiesSkipped: false,
            flowsGlobalCapReached: false,
            warnings: [],
          },
        ],
      },
      fusionDurationMs: 25,
      seededRepositoryCount: 1,
      coldFallbackRepositoryCount: 1,
      reusedRepositoryCount: 0,
      preparationFailed: false,
    });

    const startCall = jest.mocked(startDesktopOperation).mock.calls[0];
    expect(startCall?.[0]).toBe('canopy.code_graph_generation');
    expect(startCall?.[1]?.operationKey?.startsWith('hashed:')).toBe(true);
    expect(startCall?.[1]?.context).toMatchObject({
      scope: 'worktree',
      trigger: 'refresh',
      repository_count: 2,
    });
    const successCall = jest.mocked(succeedDesktopOperation).mock.calls[0];
    expect(successCall?.[0]).toBe('canopy.code_graph_generation');
    expect(successCall?.[1]?.operationKey).toBe(handle.operationKey);
    expect(successCall?.[1]?.context).toMatchObject({
      status: 'success',
      duration_ms: 250,
      reconciliation_duration_ms: 200,
      fusion_duration_ms: 25,
      files_parsed: 3,
      parse_failure_count: 1,
      symbol_count: 40,
      edge_count: 50,
      seeded_repository_count: 1,
      cold_fallback_repository_count: 1,
      community_count: 4,
      flow_count: 5,
    });
    const completionContext = successCall?.[1]?.context;
    expect(completionContext).not.toHaveProperty('operationSeed');
    expect(completionContext).not.toHaveProperty('repoId');
    expect(completionContext).not.toHaveProperty('projectId');
    expect(completionContext).not.toHaveProperty('worktreeId');
  });

  it('reports derived counts as unknown for a build that published before its derived analysis', () => {
    const handle = startCodeGraphGenerationTelemetry({
      operationSeed: '/private/workspace/raw-worktree-id',
      scope: 'worktree',
      trigger: 'refresh',
      repositoryCount: 1,
    });
    completeCodeGraphGenerationTelemetry(handle, {
      result: {
        filesScanned: 12,
        filesParsed: 3,
        filesUnchanged: 9,
        filesSkipped: 0,
        filesRemoved: 0,
        parseFailures: 0,
        symbolCount: 40,
        edgeCount: 50,
        durationMs: 200,
        factsChanged: true,
        customLanguages: null,
        derived: [],
        derivedDeferred: true,
      },
    });
    const context = jest.mocked(succeedDesktopOperation).mock.calls[0]?.[1]
      ?.context;
    expect(context).toMatchObject({ files_parsed: 3, symbol_count: 40 });
    expect(context?.derived_repository_count).toBeUndefined();
    expect(context?.derived_computed_repository_count).toBeUndefined();
    expect(context?.community_count).toBeUndefined();
    expect(context?.flow_count).toBeUndefined();
  });

  it('emits only typed failure categories and maps cancellation to abandonment', () => {
    const error = new CodeGraphWorkerBuildError(
      'canceled',
      '/private/path and raw repository details',
    );
    expect(codeGraphGenerationFailureReason(error)).toBe('canceled');
    expect(
      codeGraphGenerationFailureReason(
        new Error('/private/path and raw repository details'),
      ),
    ).toBe('unknown');

    const handle = startCodeGraphGenerationTelemetry({
      operationSeed: '/private/repository',
      scope: 'base',
      trigger: 'shadow-maintenance',
      repositoryCount: 1,
      repositoryRole: 'child',
      mode: 'incremental',
    });
    failCodeGraphGenerationTelemetry(handle, {
      stage: 'worker-build',
      reason: codeGraphGenerationFailureReason(error),
    });

    const failureCall = jest.mocked(failDesktopOperation).mock.calls[0];
    expect(failureCall?.[0]).toBe('canopy.code_graph_generation');
    expect(failureCall?.[1]).toBe('abandoned');
    expect(failureCall?.[2]?.context).toMatchObject({
      scope: 'base',
      repository_role: 'child',
      failure_stage: 'worker-build',
      failure_reason: 'canceled',
    });
    expect(
      JSON.stringify(jest.mocked(failDesktopOperation).mock.calls),
    ).not.toContain('/private');
  });

  it('emits aggregated low-cardinality refresh measures to Datadog', () => {
    recordCodeGraphRefreshTelemetry({
      source: 'diff-stats',
      outcome: 'requested',
    });
    recordCodeGraphRefreshTelemetry({
      source: 'diff-stats',
      outcome: 'fingerprint-unchanged',
      fingerprintDurationMs: 40,
      metadataReadDurationMs: 3,
      metadataCacheHit: false,
    });
    recordCodeGraphRefreshTelemetry({
      source: 'diff-stats',
      outcome: 'fingerprint-unchanged',
      fingerprintDurationMs: 60,
      metadataReadDurationMs: 0.1,
      metadataCacheHit: true,
    });

    flushCodeGraphRefreshTelemetry();

    const startCall = jest.mocked(startDesktopOperation).mock.calls[0];
    expect(startCall?.[0]).toBe('canopy.code_graph_refresh_metrics');
    expect(startCall?.[1]?.context).toMatchObject({
      source: 'diff-stats',
      request_count: 1,
      fingerprint_unchanged_count: 2,
      fingerprint_changed_count: 0,
      build_started_count: 0,
      fingerprint_duration_ms_total: 100,
      fingerprint_duration_ms_max: 60,
      sqlite_metadata_read_count: 2,
      sqlite_metadata_cache_hit_count: 1,
      sqlite_metadata_cache_miss_count: 1,
      sqlite_metadata_read_duration_ms_total: 3.1,
      sqlite_metadata_read_duration_ms_max: 3,
    });
    expect(jest.mocked(succeedDesktopOperation).mock.calls[0]?.[0]).toBe(
      'canopy.code_graph_refresh_metrics',
    );
    expect(JSON.stringify(startCall)).not.toContain('project');
    expect(JSON.stringify(startCall)).not.toContain('worktree');
    expect(JSON.stringify(startCall)).not.toContain('fingerprint-value');
  });

  it('aggregates off-main query latency without targets, paths, or ids', () => {
    recordCodeGraphQueryTelemetry({
      kind: 'query',
      outcome: 'success',
      queueDurationMs: 5,
      executionDurationMs: 40,
    });
    recordCodeGraphQueryTelemetry({
      kind: 'query',
      outcome: 'timeout',
      queueDurationMs: 10,
      executionDurationMs: 30_000,
    });

    flushCodeGraphQueryTelemetry();

    const startCall = jest.mocked(startDesktopOperation).mock.calls[0];
    expect(startCall?.[0]).toBe('canopy.code_graph_query_metrics');
    expect(startCall?.[1]?.context).toMatchObject({
      kind: 'query',
      request_count: 2,
      success_count: 1,
      error_count: 0,
      timeout_count: 1,
      canceled_count: 0,
      queue_duration_ms_total: 15,
      queue_duration_ms_max: 10,
      execution_duration_ms_total: 30_040,
      execution_duration_ms_max: 30_000,
    });
    expect(JSON.stringify(startCall)).not.toContain('/private');
    expect(JSON.stringify(startCall)).not.toContain('target');
    expect(JSON.stringify(startCall)).not.toContain('workspace');
  });
});

/** PRIVATE CANDIDATE: local bounds/privacy regressions, unrun. */
describe('local code_graph_read bounded diagnostics', () => {
  const records: SessionDiagnosticRecord[] = [];
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    records.length = 0;
    resetCodeGraphReadDiagnosticsForTests();
    setCodeGraphReadDiagnosticRecorderForTests((record) => {
      records.push(record);
    });
  });
  afterEach(() => {
    resetCodeGraphReadDiagnosticsForTests();
    jest.useRealTimers();
  });
  it('coalesces local keys until 60s without adding remote fields or buckets', () => {
    for (let index = 0; index < 10; index += 1)
      recordCodeGraphReadDiagnostic({
        key: 'workspace/worktree',
        kind: 'context',
        outcome: 'timeout',
        queueDurationMs: 5,
        executionDurationMs: 10,
        readFailure: 'queue-timeout',
      });
    jest.advanceTimersByTime(59_999);
    expect(records).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.codeGraphRead).toMatchObject({
      requestCount: 10,
      queueDurationMsTotal: 50,
      executionDurationMsTotal: 100,
      failureCounts: { 'queue-timeout': 10 },
    });
    expect(startDesktopOperation).not.toHaveBeenCalled();
    expect(succeedDesktopOperation).not.toHaveBeenCalled();
    expect(failDesktopOperation).not.toHaveBeenCalled();
  });
  it('admits at most 256 keys per60s and reports omitted admissions without unbounded IO', () => {
    for (let index = 0; index < 257; index += 1)
      recordCodeGraphReadDiagnostic({
        key: `workspace-${index}/worktree`,
        kind: 'context',
        outcome: 'error',
        queueDurationMs: 0,
        executionDurationMs: 0,
        readFailure: 'busy',
      });
    expect(records).toHaveLength(0);
    flushCodeGraphReadDiagnostics();
    expect(records).toHaveLength(256);
    expect(records[0]?.projectId).toBe('workspace-0');
    expect(records[0]?.codeGraphRead?.omittedKeyCount).toBe(1);
  });
  it('retains mixed outcomes bounded to64 without raw targets/paths/SQL', () => {
    recordCodeGraphSummaryFanoutDiagnostic({
      projectId: 'workspace',
      worktreeId: '',
      outcomes: Array.from(
        { length: 70 },
        (_, index): CodeGraphReadDiagnosticRepository => ({
          repoId: index === 0 ? '/private/root' : `repo-${index}`,
          state: 'error',
          readFailure: 'database-error',
        }),
      ),
    });
    expect(records).toHaveLength(0);
    flushCodeGraphReadDiagnostics();
    expect(records[0]?.codeGraphRead?.repositories).toHaveLength(64);
    expect(records[0]?.codeGraphRead?.omittedRepositoryCount).toBe(6);
    expect(JSON.stringify(records)).not.toContain('/private/root');
  });
});
