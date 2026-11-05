import type {
  CodeGraphQueryKind,
  CodeGraphQueryOutcome,
} from '@canopy/code-graph/host/read-scheduler';
import type { CodeGraphReadFailure } from '@canopy/desktop-shared/types/code-graph-tools';
import type {
  CodeGraphReadDiagnosticDetail,
  SessionDiagnosticRecord,
} from '../observability/service';
import { randomUUID } from 'node:crypto';
import {
  createDesktopInstrumentationOperationKey,
  type DesktopInstrumentationContext,
  type DesktopInstrumentationFailureReason,
} from '@canopy/desktop-instrumentation';
import {
  failDesktopOperation,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import type { CodeGraphBuildResult } from '@canopy/desktop-shared/types/code-graph';
import {
  codeGraphGenerationFailureReason as sharedCodeGraphGenerationFailureReason,
  codeGraphGenerationResultContext,
} from '@canopy/core-runtime/node/code-graph';
import type { CodeGraphWorkerBuildErrorReason } from '../code-graph/build-runner';

const CODE_GRAPH_GENERATION_OPERATION = 'canopy.code_graph_generation';
const CODE_GRAPH_REFRESH_METRICS_OPERATION =
  'canopy.code_graph_refresh_metrics';
const CODE_GRAPH_QUERY_METRICS_OPERATION = 'canopy.code_graph_query_metrics';
const CODE_GRAPH_REFRESH_METRICS_INTERVAL_MS = 60_000;
const CODE_GRAPH_QUERY_METRICS_INTERVAL_MS = 60_000;

export type CodeGraphRefreshSource =
  | 'worktree-created'
  | 'turn-diff'
  | 'diff-stats'
  | 'edit-during-build'
  | 'availability-reconcile'
  | 'unspecified';

export type CodeGraphRefreshOutcome =
  | 'requested'
  | 'timer-coalesced'
  | 'inflight-coalesced'
  | 'fingerprint-changed'
  | 'fingerprint-unchanged'
  | 'fingerprint-error'
  | 'build-started';

interface CodeGraphRefreshMetricsBucket {
  windowStartedAtMs: number;
  counts: Record<CodeGraphRefreshOutcome, number>;
  fingerprintDurationMsTotal: number;
  fingerprintDurationMsMax: number;
  metadataReadCount: number;
  metadataCacheHitCount: number;
  metadataReadDurationMsTotal: number;
  metadataReadDurationMsMax: number;
}

const refreshMetricsBuckets = new Map<
  CodeGraphRefreshSource,
  CodeGraphRefreshMetricsBucket
>();
let refreshMetricsTimer: ReturnType<typeof setTimeout> | null = null;

export type { CodeGraphQueryKind, CodeGraphQueryOutcome };

interface CodeGraphQueryMetricsBucket {
  windowStartedAtMs: number;
  counts: Record<CodeGraphQueryOutcome, number>;
  queueDurationMsTotal: number;
  queueDurationMsMax: number;
  executionDurationMsTotal: number;
  executionDurationMsMax: number;
}

const queryMetricsBuckets = new Map<
  CodeGraphQueryKind,
  CodeGraphQueryMetricsBucket
>();
let queryMetricsTimer: ReturnType<typeof setTimeout> | null = null;

function emptyRefreshMetricsCounts(): Record<CodeGraphRefreshOutcome, number> {
  return {
    requested: 0,
    'timer-coalesced': 0,
    'inflight-coalesced': 0,
    'fingerprint-changed': 0,
    'fingerprint-unchanged': 0,
    'fingerprint-error': 0,
    'build-started': 0,
  };
}

function scheduleRefreshMetricsFlush(): void {
  if (refreshMetricsTimer !== null) {
    return;
  }
  refreshMetricsTimer = setTimeout(() => {
    refreshMetricsTimer = null;
    flushCodeGraphRefreshTelemetry();
  }, CODE_GRAPH_REFRESH_METRICS_INTERVAL_MS);
  refreshMetricsTimer.unref?.();
}

function scheduleQueryMetricsFlush(): void {
  if (queryMetricsTimer !== null) return;
  queryMetricsTimer = setTimeout(() => {
    queryMetricsTimer = null;
    flushCodeGraphQueryTelemetry();
  }, CODE_GRAPH_QUERY_METRICS_INTERVAL_MS);
  queryMetricsTimer.unref?.();
}

/**
 * Records one off-main graph read into a bounded, per-kind aggregate. Targets,
 * paths, ids, query text, and worker error messages are deliberately excluded.
 */
export function recordCodeGraphQueryTelemetry(input: {
  kind: CodeGraphQueryKind;
  outcome: CodeGraphQueryOutcome;
  queueDurationMs: number;
  executionDurationMs: number;
}): void {
  const bucket = queryMetricsBuckets.get(input.kind) ?? {
    windowStartedAtMs: Date.now(),
    counts: { success: 0, error: 0, timeout: 0, canceled: 0 },
    queueDurationMsTotal: 0,
    queueDurationMsMax: 0,
    executionDurationMsTotal: 0,
    executionDurationMsMax: 0,
  };
  const queueDurationMs = Math.max(0, input.queueDurationMs);
  const executionDurationMs = Math.max(0, input.executionDurationMs);
  bucket.counts[input.outcome] += 1;
  bucket.queueDurationMsTotal += queueDurationMs;
  bucket.queueDurationMsMax = Math.max(
    bucket.queueDurationMsMax,
    queueDurationMs,
  );
  bucket.executionDurationMsTotal += executionDurationMs;
  bucket.executionDurationMsMax = Math.max(
    bucket.executionDurationMsMax,
    executionDurationMs,
  );
  queryMetricsBuckets.set(input.kind, bucket);
  scheduleQueryMetricsFlush();
}

export function flushCodeGraphQueryTelemetry(): void {
  if (queryMetricsTimer !== null) {
    clearTimeout(queryMetricsTimer);
    queryMetricsTimer = null;
  }
  const completedAtMs = Date.now();
  const buckets = Array.from(queryMetricsBuckets.entries());
  queryMetricsBuckets.clear();
  for (const [kind, bucket] of buckets) {
    const operationKey = createDesktopInstrumentationOperationKey(
      `code-graph-query-metrics:${kind}:${randomUUID()}`,
    );
    const context: DesktopInstrumentationContext = {
      kind,
      aggregation_window_ms: Math.max(
        0,
        completedAtMs - bucket.windowStartedAtMs,
      ),
      request_count:
        bucket.counts.success +
        bucket.counts.error +
        bucket.counts.timeout +
        bucket.counts.canceled,
      success_count: bucket.counts.success,
      error_count: bucket.counts.error,
      timeout_count: bucket.counts.timeout,
      canceled_count: bucket.counts.canceled,
      queue_duration_ms_total: bucket.queueDurationMsTotal,
      queue_duration_ms_max: bucket.queueDurationMsMax,
      execution_duration_ms_total: bucket.executionDurationMsTotal,
      execution_duration_ms_max: bucket.executionDurationMsMax,
    };
    safelyEmit(() => {
      startDesktopOperation(CODE_GRAPH_QUERY_METRICS_OPERATION, {
        operationKey,
        context,
      });
      succeedDesktopOperation(CODE_GRAPH_QUERY_METRICS_OPERATION, {
        operationKey,
        context,
      });
    });
  }
}

/**
 * Accumulates low-cardinality refresh decisions for a single periodic Datadog
 * operation. Raw workspace ids, paths, fingerprints, and exception messages
 * never enter the bucket or emitted context.
 */
export function recordCodeGraphRefreshTelemetry(input: {
  source: CodeGraphRefreshSource;
  outcome: CodeGraphRefreshOutcome;
  fingerprintDurationMs?: number;
  metadataReadDurationMs?: number;
  metadataCacheHit?: boolean;
}): void {
  const bucket = refreshMetricsBuckets.get(input.source) ?? {
    windowStartedAtMs: Date.now(),
    counts: emptyRefreshMetricsCounts(),
    fingerprintDurationMsTotal: 0,
    fingerprintDurationMsMax: 0,
    metadataReadCount: 0,
    metadataCacheHitCount: 0,
    metadataReadDurationMsTotal: 0,
    metadataReadDurationMsMax: 0,
  };
  bucket.counts[input.outcome] += 1;
  if (input.fingerprintDurationMs !== undefined) {
    const durationMs = Math.max(0, input.fingerprintDurationMs);
    bucket.fingerprintDurationMsTotal += durationMs;
    bucket.fingerprintDurationMsMax = Math.max(
      bucket.fingerprintDurationMsMax,
      durationMs,
    );
  }
  if (input.metadataReadDurationMs !== undefined) {
    const durationMs = Math.max(0, input.metadataReadDurationMs);
    bucket.metadataReadCount += 1;
    bucket.metadataCacheHitCount += input.metadataCacheHit === true ? 1 : 0;
    bucket.metadataReadDurationMsTotal += durationMs;
    bucket.metadataReadDurationMsMax = Math.max(
      bucket.metadataReadDurationMsMax,
      durationMs,
    );
  }
  refreshMetricsBuckets.set(input.source, bucket);
  scheduleRefreshMetricsFlush();
}

/** Emits and resets the current aggregate window, including during graph shutdown. */
export function flushCodeGraphRefreshTelemetry(): void {
  if (refreshMetricsTimer !== null) {
    clearTimeout(refreshMetricsTimer);
    refreshMetricsTimer = null;
  }
  const completedAtMs = Date.now();
  const buckets = Array.from(refreshMetricsBuckets.entries());
  refreshMetricsBuckets.clear();
  for (const [source, bucket] of buckets) {
    const operationKey = createDesktopInstrumentationOperationKey(
      `code-graph-refresh-metrics:${source}:${randomUUID()}`,
    );
    const context: DesktopInstrumentationContext = {
      source,
      aggregation_window_ms: Math.max(
        0,
        completedAtMs - bucket.windowStartedAtMs,
      ),
      request_count: bucket.counts.requested,
      timer_coalesced_count: bucket.counts['timer-coalesced'],
      inflight_coalesced_count: bucket.counts['inflight-coalesced'],
      fingerprint_changed_count: bucket.counts['fingerprint-changed'],
      fingerprint_unchanged_count: bucket.counts['fingerprint-unchanged'],
      fingerprint_error_count: bucket.counts['fingerprint-error'],
      build_started_count: bucket.counts['build-started'],
      fingerprint_duration_ms_total: bucket.fingerprintDurationMsTotal,
      fingerprint_duration_ms_max: bucket.fingerprintDurationMsMax,
      sqlite_metadata_read_count: bucket.metadataReadCount,
      sqlite_metadata_cache_hit_count: bucket.metadataCacheHitCount,
      sqlite_metadata_cache_miss_count:
        bucket.metadataReadCount - bucket.metadataCacheHitCount,
      sqlite_metadata_read_duration_ms_total:
        bucket.metadataReadDurationMsTotal,
      sqlite_metadata_read_duration_ms_max: bucket.metadataReadDurationMsMax,
    };
    safelyEmit(() => {
      startDesktopOperation(CODE_GRAPH_REFRESH_METRICS_OPERATION, {
        operationKey,
        context,
      });
      succeedDesktopOperation(CODE_GRAPH_REFRESH_METRICS_OPERATION, {
        operationKey,
        context,
      });
    });
  }
}

export type CodeGraphGenerationFailureReason =
  | CodeGraphWorkerBuildErrorReason
  | 'unavailable'
  | 'worker-response'
  | 'unknown';

export type CodeGraphGenerationFailureStage =
  | 'preflight'
  | 'custom-language-snapshot'
  | 'shadow-refresh'
  | 'seed-preparation'
  | 'worker-build'
  | 'publication'
  | 'fingerprint-persistence';

export interface StartCodeGraphGenerationTelemetryInput {
  operationSeed: string;
  scope: 'base' | 'worktree';
  trigger:
    | 'shadow-maintenance'
    | 'custom-language-snapshot'
    | 'worktree-created'
    | 'refresh'
    | 'tool-request'
    | 'manual';
  repositoryCount?: number;
  repositoryRole?: 'workspace-root' | 'child';
  mode?: 'cold' | 'incremental';
  customLanguagesConfigured?: boolean;
  priorGenerationAgeMs?: number;
}

export interface CodeGraphGenerationTelemetryHandle {
  operationKey: string;
  startedAtMs: number;
  context: DesktopInstrumentationContext;
}

export interface CompleteCodeGraphGenerationTelemetryInput {
  result: CodeGraphBuildResult;
  fusionDurationMs?: number;
  seededRepositoryCount?: number;
  coldFallbackRepositoryCount?: number;
  reusedRepositoryCount?: number;
  preparationFailed?: boolean;
  generationPublished?: boolean;
}

function safelyEmit(callback: () => void): void {
  try {
    callback();
  } catch {
    // Telemetry must never affect graph generation or publication.
  }
}

export function codeGraphGenerationFailureReason(
  error: unknown,
): CodeGraphGenerationFailureReason {
  return sharedCodeGraphGenerationFailureReason(error);
}

export function startCodeGraphGenerationTelemetry(
  input: StartCodeGraphGenerationTelemetryInput,
): CodeGraphGenerationTelemetryHandle {
  const startedAtMs = Date.now();
  const operationKey = createDesktopInstrumentationOperationKey(
    `code-graph:${input.operationSeed}:${randomUUID()}`,
  );
  const context: DesktopInstrumentationContext = {
    scope: input.scope,
    trigger: input.trigger,
    status: 'started',
    ...(input.repositoryCount === undefined
      ? {}
      : { repository_count: input.repositoryCount }),
    repository_role: input.repositoryRole,
    mode: input.mode,
    custom_languages_configured: input.customLanguagesConfigured,
    has_prior_generation:
      input.mode === undefined ? undefined : input.mode === 'incremental',
    prior_generation_age_ms: input.priorGenerationAgeMs,
  };
  safelyEmit(() => {
    startDesktopOperation(CODE_GRAPH_GENERATION_OPERATION, {
      operationKey,
      context,
    });
  });
  return { operationKey, startedAtMs, context };
}

export function completeCodeGraphGenerationTelemetry(
  handle: CodeGraphGenerationTelemetryHandle,
  input: CompleteCodeGraphGenerationTelemetryInput,
): void {
  succeedCodeGraphGenerationTelemetry(
    handle,
    codeGraphGenerationResultContext(input),
  );
}

/**
 * A successful generation with its result values. `durationMs` replaces the
 * handle's own clock for a generation another host measured (CAN-5627).
 */
export function succeedCodeGraphGenerationTelemetry(
  handle: CodeGraphGenerationTelemetryHandle,
  resultContext: DesktopInstrumentationContext,
  durationMs?: number,
): void {
  safelyEmit(() => {
    succeedDesktopOperation(CODE_GRAPH_GENERATION_OPERATION, {
      operationKey: handle.operationKey,
      context: {
        ...handle.context,
        ...resultContext,
        status: 'success',
        duration_ms: durationMs ?? Math.max(0, Date.now() - handle.startedAtMs),
      },
    });
  });
}

export function failCodeGraphGenerationTelemetry(
  handle: CodeGraphGenerationTelemetryHandle,
  input: {
    stage: CodeGraphGenerationFailureStage;
    reason: CodeGraphGenerationFailureReason;
  },
  durationMs?: number,
): void {
  const failureReason: DesktopInstrumentationFailureReason =
    input.reason === 'canceled' ? 'abandoned' : 'error';
  safelyEmit(() => {
    failDesktopOperation(CODE_GRAPH_GENERATION_OPERATION, failureReason, {
      operationKey: handle.operationKey,
      context: {
        ...handle.context,
        status: 'failure',
        failure_stage: input.stage,
        failure_reason: input.reason,
        duration_ms: durationMs ?? Math.max(0, Date.now() - handle.startedAtMs),
      },
    });
  });
}

/** Local-only bounded diagnostics. Never adds a remote telemetry property. */
const READ_DIAGNOSTIC_LIMIT = 256;
const READ_DIAGNOSTIC_WINDOW_MS = 60_000;
interface ReadDiagnosticBucket {
  projectId: string;
  worktreeId: string;
  detail: CodeGraphReadDiagnosticDetail;
}
const readDiagnosticBuckets = new Map<string, ReadDiagnosticBucket>();
let omittedReadDiagnosticKeys = 0;
let readDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
type ReadDiagnosticRecorder = (record: SessionDiagnosticRecord) => void;
let readDiagnosticRecorder: ReadDiagnosticRecorder | null = null;

function safeDiagnosticDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 86_400_000)) : 0;
}

function emitLocalReadDiagnostic(bucket: ReadDiagnosticBucket): void {
  const record: SessionDiagnosticRecord = {
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'code_graph_read',
    projectId: bucket.projectId,
    worktreeId: bucket.worktreeId,
    chatId: '',
    providerType: 'unknown',
    sessionKey: `${bucket.projectId}/${bucket.worktreeId}/`,
    codeGraphRead: bucket.detail,
  };
  if (readDiagnosticRecorder !== null) {
    try {
      readDiagnosticRecorder(record);
    } catch {
      /* Observability cannot affect reads. */
    }
    return;
  }
  void import('../observability')
    .then(({ peekObservabilityService }) =>
      peekObservabilityService()?.recordSessionDiagnostic(record),
    )
    .catch(() => undefined);
}

function readDiagnosticOwner(
  key: string,
): { projectId: string; worktreeId: string } | null {
  const [projectId, worktreeId = ''] = key.split('/');
  // Canonical workspace/worktree IDs only. Never infer ownership from a path/base hash.
  if (
    projectId === undefined ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(projectId) ||
    (worktreeId !== '' && !/^[a-z0-9][a-z0-9-]{0,127}$/.test(worktreeId))
  )
    return null;
  return { projectId, worktreeId };
}

export function recordCodeGraphReadDiagnostic(input: {
  key: string;
  kind: CodeGraphQueryKind;
  outcome: CodeGraphQueryOutcome;
  queueDurationMs: number;
  executionDurationMs: number;
  readFailure?: CodeGraphReadFailure;
}): void {
  const owner = readDiagnosticOwner(input.key);
  if (owner === null) return;
  const key = `${owner.projectId}/${owner.worktreeId}/${input.kind}/${input.outcome}`;
  let bucket = readDiagnosticBuckets.get(key);
  if (bucket === undefined) {
    if (readDiagnosticBuckets.size >= READ_DIAGNOSTIC_LIMIT) {
      omittedReadDiagnosticKeys = Math.min(
        Number.MAX_SAFE_INTEGER,
        omittedReadDiagnosticKeys + 1,
      );
      return;
    }
    bucket = {
      ...owner,
      detail: {
        kind: input.kind,
        outcome: input.outcome,
        requestCount: 0,
        queueDurationMsTotal: 0,
        queueDurationMsMax: 0,
        executionDurationMsTotal: 0,
        executionDurationMsMax: 0,
        failureCounts: {},
      },
    };
    readDiagnosticBuckets.set(key, bucket);
  }
  const queueMs = safeDiagnosticDuration(input.queueDurationMs);
  const executionMs = safeDiagnosticDuration(input.executionDurationMs);
  bucket.detail.requestCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    bucket.detail.requestCount + 1,
  );
  bucket.detail.queueDurationMsTotal = Math.min(
    Number.MAX_SAFE_INTEGER,
    bucket.detail.queueDurationMsTotal + queueMs,
  );
  bucket.detail.queueDurationMsMax = Math.max(
    bucket.detail.queueDurationMsMax,
    queueMs,
  );
  bucket.detail.executionDurationMsTotal = Math.min(
    Number.MAX_SAFE_INTEGER,
    bucket.detail.executionDurationMsTotal + executionMs,
  );
  bucket.detail.executionDurationMsMax = Math.max(
    bucket.detail.executionDurationMsMax,
    executionMs,
  );
  if (input.readFailure !== undefined)
    bucket.detail.failureCounts[input.readFailure] = Math.min(
      Number.MAX_SAFE_INTEGER,
      (bucket.detail.failureCounts[input.readFailure] ?? 0) + 1,
    );
  if (readDiagnosticTimer === null) {
    readDiagnosticTimer = setTimeout(
      flushCodeGraphReadDiagnostics,
      READ_DIAGNOSTIC_WINDOW_MS,
    );
    readDiagnosticTimer.unref?.();
  }
}

function containsAsciiIdentityControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f) return true;
  }
  return false;
}

export function recordCodeGraphSummaryFanoutDiagnostic(input: {
  projectId: string;
  worktreeId: string;
  outcomes: NonNullable<CodeGraphReadDiagnosticDetail['repositories']>;
}): void {
  const owner = readDiagnosticOwner(`${input.projectId}/${input.worktreeId}`);
  if (owner === null) return;
  const repositories = input.outcomes.slice(0, 64).map((outcome) => ({
    ...outcome,
    repoId:
      outcome.repoId.length <= 1024 &&
      !/[\\/]/.test(outcome.repoId) &&
      !containsAsciiIdentityControl(outcome.repoId)
        ? outcome.repoId
        : '[redacted]',
  }));
  const outcome: CodeGraphQueryOutcome = input.outcomes.some(
    (entry) => entry.state === 'error',
  )
    ? 'error'
    : 'success';
  recordCodeGraphReadDiagnostic({
    key: `${owner.projectId}/${owner.worktreeId}`,
    kind: 'ui-summary',
    outcome,
    queueDurationMs: 0,
    executionDurationMs: 0,
  });
  const bucket = readDiagnosticBuckets.get(
    `${owner.projectId}/${owner.worktreeId}/ui-summary/${outcome}`,
  );
  if (bucket !== undefined) {
    bucket.detail.repositories = repositories;
    bucket.detail.omittedRepositoryCount = Math.max(
      0,
      input.outcomes.length - repositories.length,
    );
  }
}

export function flushCodeGraphReadDiagnostics(): void {
  if (readDiagnosticTimer !== null) {
    clearTimeout(readDiagnosticTimer);
    readDiagnosticTimer = null;
  }
  const buckets = Array.from(readDiagnosticBuckets.values());
  readDiagnosticBuckets.clear();
  const first = buckets[0];
  if (first !== undefined && omittedReadDiagnosticKeys > 0)
    first.detail.omittedKeyCount = omittedReadDiagnosticKeys;
  omittedReadDiagnosticKeys = 0;
  for (const bucket of buckets) emitLocalReadDiagnostic(bucket);
}

export function setCodeGraphReadDiagnosticRecorderForTests(
  recorder: ReadDiagnosticRecorder | null,
): void {
  readDiagnosticRecorder = recorder;
}

export function resetCodeGraphReadDiagnosticsForTests(): void {
  if (readDiagnosticTimer !== null) clearTimeout(readDiagnosticTimer);
  readDiagnosticTimer = null;
  readDiagnosticBuckets.clear();
  readDiagnosticRecorder = null;
  omittedReadDiagnosticKeys = 0;
}
