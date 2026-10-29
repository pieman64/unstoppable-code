import type { CodeGraphBuildResult } from '@canopy/desktop-shared/types/code-graph';
import type {
  CodeGraphBuildDiagnosticDetail,
  SessionDiagnosticRecord,
} from '../observability/service';

/**
 * Local diagnostics for code-graph generation: one `code_graph_build` session
 * event per worktree or base build, carrying the worker's phase timings and
 * the phases main ran around it. They belong in `session-events/` because
 * they name a workspace and worktree. The Datadog generation operation is a
 * separate, unchanged, privacy-bounded summary.
 *
 * This module also remembers when each worktree first asked for a graph it
 * does not have yet, so the build that completes that first graph can report
 * (and persist) time to first graph.
 */

/** Worktrees remembered while waiting for their first graph. */
const FIRST_GRAPH_REQUEST_LIMIT = 256;
const MAX_DIAGNOSTIC_DURATION_MS = 24 * 60 * 60 * 1000;
const firstGraphRequests = new Map<string, number>();

type DiagnosticRecorder = (record: SessionDiagnosticRecord) => void;
let recorderOverride: DiagnosticRecorder | null = null;

/**
 * Remembers the earliest request for a worktree graph that has never
 * completed. `key` is `${projectId}/${worktreeId}`; epoch milliseconds.
 */
export function noteCodeGraphFirstRequest(
  key: string,
  requestedAt: number,
): void {
  if (firstGraphRequests.has(key)) return;
  if (firstGraphRequests.size >= FIRST_GRAPH_REQUEST_LIMIT) {
    const oldest = firstGraphRequests.keys().next();
    if (!oldest.done) firstGraphRequests.delete(oldest.value);
  }
  firstGraphRequests.set(key, requestedAt);
}

export function codeGraphFirstRequestedAt(key: string): number | undefined {
  return firstGraphRequests.get(key);
}

/** The worktree has a graph (or no longer wants one): stop waiting. */
export function clearCodeGraphFirstRequest(key: string): void {
  firstGraphRequests.delete(key);
}

/** Build counts and timings a result contributes to its diagnostic. */
export function codeGraphBuildResultDetail(
  result: CodeGraphBuildResult,
): Pick<
  CodeGraphBuildDiagnosticDetail,
  'filesScanned' | 'filesParsed' | 'factsChanged' | 'timings' | 'queueWaitMs'
> {
  const queueWaitMs =
    result.timings?.queueWaitMs === undefined
      ? undefined
      : boundedDuration(result.timings.queueWaitMs);
  return {
    filesScanned: result.filesScanned,
    filesParsed: result.filesParsed,
    ...(queueWaitMs === undefined ? {} : { queueWaitMs }),
    ...(result.factsChanged === undefined
      ? {}
      : { factsChanged: result.factsChanged }),
    ...(result.timings === undefined ? {} : { timings: result.timings }),
  };
}

function boundedDuration(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.round(value * 10) / 10, MAX_DIAGNOSTIC_DURATION_MS);
}

function safeAttemptId(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 64 ||
    !/^[a-zA-Z0-9_-]+$/.test(value)
  ) {
    return undefined;
  }
  return value;
}

export function recordCodeGraphBuildDiagnostic(input: {
  projectId: string;
  /** Empty for base builds, which belong to no single worktree. */
  worktreeId: string;
  detail: CodeGraphBuildDiagnosticDetail;
}): void {
  const safeAttempt = safeAttemptId(input.detail.attemptId);
  const safeQueueWait =
    input.detail.queueWaitMs === undefined
      ? undefined
      : boundedDuration(input.detail.queueWaitMs);
  const { attemptId, queueWaitMs, ...detail } = input.detail;
  void attemptId;
  void queueWaitMs;
  const record: SessionDiagnosticRecord = {
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'code_graph_build',
    sessionKey:
      input.worktreeId === ''
        ? `${input.projectId}/`
        : `${input.projectId}/${input.worktreeId}/`,
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    chatId: '',
    providerType: 'unknown',
    codeGraphBuild: {
      ...detail,
      ...(safeAttempt === undefined ? {} : { attemptId: safeAttempt }),
      ...(safeQueueWait === undefined ? {} : { queueWaitMs: safeQueueWait }),
    },
  };
  if (recorderOverride !== null) {
    try {
      recorderOverride(record);
    } catch {
      // Diagnostics must never affect graph generation or publication.
    }
    return;
  }
  // Loaded on first use, deliberately: the observability service pulls in
  // most of main, and the scheduler and build modules that import this one
  // are loaded by many narrowly mocked unit tests. Main creates the service at
  // startup; this never creates one, so a unit test does not start its writers.
  void import('../observability')
    .then(({ peekObservabilityService }) =>
      peekObservabilityService()?.recordSessionDiagnostic(record),
    )
    .catch(() => undefined);
}

/** Test seam: capture build diagnostics instead of recording them. */
export function setCodeGraphBuildDiagnosticRecorderForTests(
  recorder: DiagnosticRecorder | null,
): void {
  recorderOverride = recorder;
}

export function resetCodeGraphBuildDiagnosticsForTests(): void {
  firstGraphRequests.clear();
  recorderOverride = null;
}
