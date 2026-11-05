import {
  WORKER_CODE_GRAPH_GENERATION_FAILURE_REASONS,
  WORKER_CODE_GRAPH_GENERATION_REPORT_CAPABILITY,
  WorkerCodeGraphBuildFailureDetailsSchema,
  WorkerCodeGraphGenerationReportSchema,
  type CanopyJsonValue,
  type WorkerCodeGraphGenerationReport,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyControlReplyFit } from '../daemon/control-plane';

/*
 * One worktree generation's telemetry context and local build diagnostic
 * (CAN-5627). Electron main and the core daemon observe their generations
 * through the same reporter, so both describe a generation identically; the
 * daemon returns the report with its answer and the requesting interface
 * records it. The structural types mirror `@canopy/code-graph`'s, which this
 * package may not import.
 */

type Report = WorkerCodeGraphGenerationReport;
type Diagnostic = Report['diagnostic'];
type Timings = NonNullable<Diagnostic['timings']>;
export type CodeGraphGenerationFailureReason = NonNullable<
  Report['failure']
>['reason'];
export type CodeGraphGenerationTelemetryValue = Report['telemetry'][string];

/** The completed build's counts, as the build host reports them. */
export interface CodeGraphGenerationBuildResult {
  readonly filesScanned: number;
  readonly filesParsed: number;
  readonly filesUnchanged: number;
  readonly filesSkipped: number;
  readonly filesRemoved: number;
  readonly parseFailures: number;
  readonly symbolCount: number;
  readonly edgeCount: number;
  readonly durationMs: number;
  readonly derived: readonly {
    readonly computed: boolean;
    readonly communityCount: number;
    readonly flowCount: number;
  }[];
  readonly factsChanged?: boolean;
  readonly timings?: Timings;
  readonly derivedDeferred?: true;
}

export interface CodeGraphGenerationResultContextInput {
  readonly result: CodeGraphGenerationBuildResult;
  readonly fusionDurationMs?: number;
  readonly seededRepositoryCount?: number;
  readonly coldFallbackRepositoryCount?: number;
  readonly reusedRepositoryCount?: number;
  readonly preparationFailed?: boolean;
  readonly generationPublished?: boolean;
}

/** The result values a successful generation's telemetry operation reports. */
export function codeGraphGenerationResultContext(
  input: CodeGraphGenerationResultContextInput,
): Record<string, CodeGraphGenerationTelemetryValue> {
  const { result } = input;
  // A build that published before its derived analysis has no derived
  // counts yet: report them as unknown rather than zero.
  const derivedKnown = result.derivedDeferred !== true;
  const values: Record<string, CodeGraphGenerationTelemetryValue | undefined> =
    {
      files_scanned: result.filesScanned,
      files_parsed: result.filesParsed,
      files_unchanged: result.filesUnchanged,
      files_skipped: result.filesSkipped,
      files_removed: result.filesRemoved,
      parse_failure_count: result.parseFailures,
      symbol_count: result.symbolCount,
      edge_count: result.edgeCount,
      reconciliation_duration_ms: result.durationMs,
      fusion_duration_ms: input.fusionDurationMs,
      facts_changed: result.factsChanged,
      zero_mutation: result.factsChanged === false,
      derived_repository_count: derivedKnown
        ? result.derived.length
        : undefined,
      derived_computed_repository_count: derivedKnown
        ? result.derived.filter((entry) => entry.computed).length
        : undefined,
      community_count: derivedKnown
        ? result.derived.reduce(
            (total, entry) => total + entry.communityCount,
            0,
          )
        : undefined,
      flow_count: derivedKnown
        ? result.derived.reduce((total, entry) => total + entry.flowCount, 0)
        : undefined,
      seeded_repository_count: input.seededRepositoryCount,
      cold_fallback_repository_count: input.coldFallbackRepositoryCount,
      reused_repository_count: input.reusedRepositoryCount,
      preparation_failed: input.preparationFailed,
      generation_published: input.generationPublished,
    };
  const context: Record<string, CodeGraphGenerationTelemetryValue> = {};
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) context[key] = value;
  return context;
}

function errorField(error: unknown, field: string): unknown {
  return typeof error === 'object' && error !== null && field in error
    ? Reflect.get(error, field)
    : undefined;
}

function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/** A build scheduler failure's reason; anything else is `unknown`. */
export function codeGraphGenerationFailureReason(
  error: unknown,
): CodeGraphGenerationFailureReason {
  const reason = errorField(error, 'reason');
  if (!isNamed(error, 'CodeGraphWorkerBuildError')) return 'unknown';
  return (
    WORKER_CODE_GRAPH_GENERATION_FAILURE_REASONS.find(
      (candidate) => candidate === reason,
    ) ?? 'unknown'
  );
}

const READ_FAILURES = [
  'queue-timeout',
  'execution-timeout',
  'busy',
  'worker-exit',
  'canceled',
  'invalid-response',
  'database-error',
] as const;

/** Mirrors `@canopy/code-graph/host`'s failure causes. */
export type CodeGraphGenerationFailureCause =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'worker-response' }
  | { readonly kind: 'error'; readonly error: unknown };

function failureReasons(cause: CodeGraphGenerationFailureCause): {
  generation: CodeGraphGenerationFailureReason;
  diagnostic: NonNullable<Diagnostic['failureReason']>;
} {
  if (cause.kind !== 'error')
    return { generation: cause.kind, diagnostic: cause.kind };
  const generation = codeGraphGenerationFailureReason(cause.error);
  // A read failure keeps its own classification in the local diagnostic.
  const readFailure = isNamed(cause.error, 'CodeGraphReadFailureError')
    ? READ_FAILURES.find(
        (candidate) => candidate === errorField(cause.error, 'readFailure'),
      )
    : undefined;
  return { generation, diagnostic: readFailure ?? generation };
}

const ATTEMPT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function attempt(attemptId: string | undefined): { attemptId?: string } {
  return attemptId !== undefined && ATTEMPT_ID.test(attemptId)
    ? { attemptId }
    : {};
}

const TIMING_KEYS = [
  'queueWaitMs',
  'fingerprintMs',
  'seedCopyMs',
  'fusionMs',
  'prepareMs',
  'scanMs',
  'hashMs',
  'parseMs',
  'ftsMs',
  'derivedMs',
  'diagnosticsMs',
  'commitMs',
  'finalizeMs',
  'rowsWritten',
  'walStartBytes',
  'peakWalBytes',
  'peakRssBytes',
  'timeToFirstGraphMs',
] as const;

/** The timings the wire carries, whatever else a newer build host adds. */
function portableTimings(timings: Timings): Timings {
  const portable: Timings = {
    prepareMs: timings.prepareMs,
    scanMs: timings.scanMs,
    hashMs: timings.hashMs,
    parseMs: timings.parseMs,
    diagnosticsMs: timings.diagnosticsMs,
    commitMs: timings.commitMs,
    rowsWritten: timings.rowsWritten,
  };
  for (const key of TIMING_KEYS) {
    const value = timings[key];
    if (value !== undefined) portable[key] = value;
  }
  if (timings.resolveMs !== undefined)
    portable.resolveMs = {
      resetMs: timings.resolveMs.resetMs,
      importsMs: timings.resolveMs.importsMs,
      configExtendsMs: timings.resolveMs.configExtendsMs,
      docLinksMs: timings.resolveMs.docLinksMs,
      ipcMs: timings.resolveMs.ipcMs,
      workflowActionsMs: timings.resolveMs.workflowActionsMs,
      callsMs: timings.resolveMs.callsMs,
      testsMs: timings.resolveMs.testsMs,
    };
  return portable;
}

/** Mirrors `@canopy/code-graph/host`'s `CodeGraphWorktreeBuildObservation`. */
export interface CodeGraphGenerationObservation {
  setRepositoryCount(count: number): void;
  succeeded(input: {
    readonly response: {
      readonly result: CodeGraphGenerationBuildResult;
      readonly fusionDurationMs?: number;
    };
    readonly seededRepositoryCount: number;
    readonly coldFallbackRepositoryCount: number;
    readonly reusedRepositoryCount: number;
    readonly preparationFailed: boolean;
    readonly attemptId: string | undefined;
    readonly queuePriority: Diagnostic['queuePriority'];
    readonly totalMs: number;
    readonly endFingerprintMs: number | undefined;
    readonly fingerprintPersistMs: number | undefined;
    readonly fingerprintPersistOutcome: Diagnostic['fingerprintPersistOutcome'];
  }): void;
  failed(input: {
    readonly stage: NonNullable<Report['failure']>['stage'];
    readonly cause: CodeGraphGenerationFailureCause;
    readonly attemptId: string | undefined;
    readonly queuePriority: Diagnostic['queuePriority'];
    readonly totalMs: number;
  }): void;
}

/**
 * Observes one generation and hands its report to `settled` once, when it
 * succeeds or fails.
 */
export function createCodeGraphGenerationReporter(
  trigger: Report['trigger'],
  settled: (report: Report) => void,
): CodeGraphGenerationObservation {
  let repositoryCount: number | null = null;
  let done = false;
  const settle = (report: Report): void => {
    if (done) return;
    done = true;
    // Reporting never affects the generation: a report the wire would
    // refuse is dropped.
    const parsed = WorkerCodeGraphGenerationReportSchema.safeParse(report);
    if (parsed.success) settled(parsed.data);
  };
  return {
    setRepositoryCount: (count): void => {
      repositoryCount = count;
    },
    succeeded: (input): void => {
      const { result } = input.response;
      settle({
        trigger,
        outcome: 'success',
        repositoryCount,
        totalMs: input.totalMs,
        telemetry: codeGraphGenerationResultContext({
          result,
          fusionDurationMs: input.response.fusionDurationMs ?? 0,
          seededRepositoryCount: input.seededRepositoryCount,
          coldFallbackRepositoryCount: input.coldFallbackRepositoryCount,
          reusedRepositoryCount: input.reusedRepositoryCount,
          preparationFailed: input.preparationFailed,
        }),
        failure: null,
        diagnostic: {
          outcome: 'success',
          ...attempt(input.attemptId),
          ...(input.queuePriority === undefined
            ? {}
            : { queuePriority: input.queuePriority }),
          totalMs: input.totalMs,
          filesScanned: result.filesScanned,
          filesParsed: result.filesParsed,
          ...(result.timings?.queueWaitMs === undefined
            ? {}
            : { queueWaitMs: result.timings.queueWaitMs }),
          ...(result.factsChanged === undefined
            ? {}
            : { factsChanged: result.factsChanged }),
          ...(result.timings === undefined
            ? {}
            : { timings: portableTimings(result.timings) }),
          ...(input.endFingerprintMs === undefined
            ? {}
            : { endFingerprintMs: input.endFingerprintMs }),
          ...(input.fingerprintPersistMs === undefined
            ? {}
            : { fingerprintPersistMs: input.fingerprintPersistMs }),
          ...(input.fingerprintPersistOutcome === undefined
            ? {}
            : { fingerprintPersistOutcome: input.fingerprintPersistOutcome }),
        },
      });
    },
    failed: (input): void => {
      const reasons = failureReasons(input.cause);
      // A busy build that never reached the queue is deferred, not failed.
      const deferred =
        reasons.diagnostic === 'busy' && input.attemptId === undefined;
      settle({
        trigger,
        outcome: 'failure',
        repositoryCount,
        totalMs: input.totalMs,
        telemetry: {},
        failure: { stage: input.stage, reason: reasons.generation },
        diagnostic: {
          outcome: deferred ? 'deferred' : 'failure',
          failureStage: input.stage,
          failureReason: reasons.diagnostic,
          ...attempt(input.attemptId),
          ...(input.queuePriority === undefined
            ? {}
            : { queuePriority: input.queuePriority }),
          totalMs: input.totalMs,
        },
      });
    },
  };
}

/** A build refusal that also carries how its generation went, if known. */
export function withCodeGraphGenerationReport(
  error: CanopyOperationError,
  report: Report | undefined,
): CanopyOperationError {
  if (report === undefined) return error;
  const details = WorkerCodeGraphBuildFailureDetailsSchema.safeParse(
    error.payload.details ?? {},
  );
  if (!details.success) return error;
  return new CanopyOperationError(
    {
      ...error.payload,
      details: { ...details.data, generation: report },
    },
    error.runtimeCause,
  );
}

/** The generation report a `worker.codeGraph.build` refusal carries, if any. */
export function codeGraphGenerationReportOf(details: unknown): Report | null {
  const parsed = WorkerCodeGraphBuildFailureDetailsSchema.safeParse(details);
  return parsed.success ? (parsed.data.generation ?? null) : null;
}

const BUILD = 'worker.codeGraph.build';

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== key),
  );
}

/**
 * Leaves generation reports out of `worker.codeGraph.build` replies to a
 * client that did not announce it decodes them: an older client's strict
 * result and error schemas refuse the field.
 */
export const codeGraphGenerationReportFit: CanopyControlReplyFit = {
  result: (method, result, capabilities) =>
    method === BUILD &&
    !capabilities.has(WORKER_CODE_GRAPH_GENERATION_REPORT_CAPABILITY) &&
    typeof result === 'object' &&
    result !== null &&
    'generation' in result
      ? without(result, 'generation')
      : result,
  error: (method, error, capabilities) => {
    const { details } = error;
    if (
      method !== BUILD ||
      capabilities.has(WORKER_CODE_GRAPH_GENERATION_REPORT_CAPABILITY) ||
      typeof details !== 'object' ||
      details === null ||
      Array.isArray(details) ||
      !('generation' in details)
    )
      return error;
    const rest: Record<string, CanopyJsonValue> = {};
    for (const [key, value] of Object.entries(details))
      if (key !== 'generation') rest[key] = value;
    // The older details schema requires `failure` whenever details exist.
    if (Object.keys(rest).length > 0) return { ...error, details: rest };
    return {
      kind: error.kind,
      message: error.message,
      ...(error.code === undefined ? {} : { code: error.code }),
      retry: error.retry,
    };
  },
};

const FIRST_GRAPH_REQUEST_LIMIT = 256;

/**
 * The earliest request for each worktree graph that has never completed, so
 * the build that completes it can report time to first graph. Bounded: the
 * oldest entry goes first.
 */
export class CodeGraphFirstGraphRequests {
  private readonly requests = new Map<string, number>();

  note(key: string, requestedAt: number): void {
    if (this.requests.has(key)) return;
    if (this.requests.size >= FIRST_GRAPH_REQUEST_LIMIT) {
      const oldest = this.requests.keys().next();
      if (!oldest.done) this.requests.delete(oldest.value);
    }
    this.requests.set(key, requestedAt);
  }

  at(key: string): number | undefined {
    return this.requests.get(key);
  }

  clear(key: string): void {
    this.requests.delete(key);
  }
}
