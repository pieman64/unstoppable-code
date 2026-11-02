import { totalmem } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExecutionHostProcess } from '@canopy/desktop-shared/node/execution-host/port';
import type {
  CodeGraphGenerationQueueSnapshot,
  CodeGraphIpcError,
  CodeGraphQueueEntry,
  CodeGraphQueueScope,
  CodeGraphReorderGenerationQueueRequest,
  CodeGraphReorderGenerationQueueResponse,
} from '@canopy/desktop-shared/types';
import type { CodeGraphBuildOptions } from '@canopy/desktop-shared/types/code-graph';
import { getCodeGraphWorktreeService } from '@canopy/desktop-shared/node/code-graph/service';
import type { CodeGraphBuildState } from '@canopy/desktop-shared/types/code-graph-tools';
import type {
  BackfillCodeGraphSummaryProjectionResult,
  ReadCodeGraphSummaryProjectionResult,
} from '@canopy/code-graph/summary-projection';
import { getWorktreeCodeGraphDbPath } from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import {
  getCodeGraphGenerationTimeoutMs,
  isCodeGraphAvailableForWorkspace,
} from '../lib/code-graph-availability';
import { getBundledCodeGraphDir } from '@canopy/desktop-shared/pipelines/config-paths';
import { getExecutionAccounting } from '../execution-accounting';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { resolveWorktreeCodeGraphRepositories } from '../lib/worktree-repo-entries';
import {
  leaveBackgroundProcessPolicy,
  lowerSpawnedProcessPriority,
} from '../lib/background-process';
import { getExecutionHostPort } from '../execution-host/utility-process-host';
import { codeGraphHostBudget } from '@canopy/code-graph/host/budgets';
import type {
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerSummaryRepairRequest,
  CodeGraphWorkerSummaryRepairResponse,
  CodeGraphWorkerEagerSeedRequest,
  CodeGraphWorkerBuildResponse,
  CodeGraphWorkerEagerSeedResponse,
} from '@canopy/code-graph/host/build-protocol';

// --- Protocol -------------------------------------------------------------
//
// The build host protocol lives with the host in `@canopy/code-graph/host`.

export type {
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerSummaryRepairRequest,
  CodeGraphWorkerSummaryRepairResponse,
  CodeGraphWorkerEagerSeedRequest,
  CodeGraphWorkerBuildResponse,
  CodeGraphWorkerDerivedCompletion,
  CodeGraphWorkerEagerSeedResponse,
} from '@canopy/code-graph/host/build-protocol';

export type CodeGraphSummaryRepairResult =
  | {
      ok: true;
      attemptId: string | null;
      resolution: 'already-ready' | 'source-publication' | 'repaired';
      result: BackfillCodeGraphSummaryProjectionResult;
    }
  | {
      ok: false;
      attemptId: string | null;
      reason:
        | 'invalid-request'
        | 'unavailable'
        | 'cooldown'
        | 'source-failed'
        | 'canceled'
        | 'superseded'
        | 'worker-failed';
      message: string;
    };

export type { CodeGraphBuildState } from '@canopy/desktop-shared/types/code-graph-tools';

export interface CodeGraphWorkerBuildHandle {
  readonly attemptId: string | null;
  promise: Promise<CodeGraphWorkerBuildResponse>;
}

export interface CodeGraphSummaryRepairRequest {
  key: string;
  projectId: string;
  worktreeId: string;
  dbPath: string;
}

type CodeGraphWorkerRequest =
  | CodeGraphWorkerBuildRequest
  | CodeGraphWorkerSummaryRepairRequest
  | CodeGraphWorkerEagerSeedRequest;
type CodeGraphWorkerResponse =
  | CodeGraphWorkerBuildResponse
  | CodeGraphWorkerSummaryRepairResponse
  | CodeGraphWorkerEagerSeedResponse;

// --- Typed failure --------------------------------------------------------

export type CodeGraphWorkerBuildErrorReason =
  | 'timeout'
  | 'canceled'
  | 'unavailable'
  | 'worker-exit'
  | 'spawn-failed'
  | 'post-failed'
  | 'malformed-response';

/**
 * Every runner failure path rejects with this typed error (never a bare
 * string, never a hung promise) so callers can distinguish a user-driven
 * `cancel` (`reason: 'canceled'`) from a genuine failure. A `ok:false` worker
 * response is NOT an error — it resolves normally so the caller sees the
 * worker's own message.
 */
export class CodeGraphWorkerBuildError extends Error {
  public readonly reason: CodeGraphWorkerBuildErrorReason;

  public constructor(reason: CodeGraphWorkerBuildErrorReason, message: string) {
    super(message);
    this.name = 'CodeGraphWorkerBuildError';
    this.reason = reason;
  }
}

// --- Runner ---------------------------------------------------------------

// Full builds are capped at two worker processes, but user-idle worktree and
// maintenance builds share one background slot. The second full-build slot is
// reserved for an agent-requested build so an interactive tool request does
// not wait behind a multi-minute parser. Eager seed-only requests use one
// separate lane: creation must not wait behind a multi-minute parser,
// while still preventing a burst of worktree creation from spawning unbounded
// snapshot workers. A single hung operation must never block its lane, so a
// worker that produces no response within the watchdog window is killed and
// rejected.
const CONCURRENCY_CAP = 2;
const BACKGROUND_BUILD_CONCURRENCY_CAP = 1;
// Keep a restored workspace with many stale graphs from turning the single
// background lane into a continuous native/SQLite CPU train. This mirrors the
// process-wide background-helper queue's inter-task yield while remaining
// short enough for indexing to make steady progress. Agent builds use the
// reserved foreground slot and never wait for this cooldown.
const DEFAULT_BACKGROUND_BUILD_INTER_TASK_DELAY_MS = 500;
const EAGER_SEED_CONCURRENCY_CAP = 1;
const SUMMARY_REPAIR_TIMEOUT_MS = 5 * 60 * 1_000;
const SUMMARY_REPAIR_COOLDOWN_MS = 5 * 60 * 1_000;
const WORKER_SERVICE_NAME = 'code-graph-build';
const WORKER_ENTRY_FILENAME = 'code-graph-build-worker.js';

export function codeGraphBuildConcurrencyCap(
  e2eEnabled = __CANOPY_E2E__,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return e2eEnabled && env.CANOPY_PERFORMANCE_CODE_GRAPH_CONCURRENCY === '1'
    ? 1
    : CONCURRENCY_CAP;
}

export interface CodeGraphBuildQueueMetadata {
  scope: CodeGraphQueueScope;
  workspaceIds: readonly string[];
  workspaceLabel?: string;
  worktreeId?: string;
  repositoryId?: string;
  label?: string;
  trigger: string;
}

/**
 * Queue classes, highest first. `first-build` is a worktree build for a graph
 * that has never been published; it queues ahead of ordinary `worktree`
 * refreshes and `maintenance` base builds, but behind `agent` builds. It still
 * uses the single background slot and is never preempted.
 */
export type CodeGraphBuildPriority =
  | 'agent'
  | 'first-build'
  | 'worktree'
  | 'maintenance';

/**
 * Aging bound for queued refreshes: a queued `worktree` refresh lets at most
 * this many first builds move ahead of it. Later first builds queue behind
 * it, so repeated worktree creation cannot starve a refresh.
 */
export const CODE_GRAPH_FIRST_BUILD_OVERTAKE_LIMIT = 3;

export interface CodeGraphBuildSchedulingOptions {
  priority?: CodeGraphBuildPriority;
  metadata?: CodeGraphBuildQueueMetadata;
}

interface BuildRecord {
  id: string;
  key: string;
  request: CodeGraphWorkerRequest;
  promise: Promise<CodeGraphWorkerResponse>;
  resolve: (response: CodeGraphWorkerResponse) => void;
  reject: (error: CodeGraphWorkerBuildError) => void;
  child: ExecutionHostProcess | undefined;
  watchdog: NodeJS.Timeout | undefined;
  started: boolean;
  settled: boolean;
  /** True once the child's 'exit' event has fired — rejectRecord skips exit-
   * wait registration then (nothing left to wait for; registering would make
   * a later cancelBuild ride the full fallthrough window pointlessly). */
  childExited: boolean;
  pendingResolution?: CodeGraphWorkerResponse;
  priority: CodeGraphBuildPriority;
  /** First builds that have moved ahead of this queued refresh (aging). */
  firstBuildsAhead: number;
  metadata: CodeGraphBuildQueueMetadata;
  queuedAt: number;
  startedAt: number | null;
  timeoutMs: number | null;
  pendingRejection: CodeGraphWorkerBuildError | undefined;
  followUp: PendingBuildFollowUp | undefined;
  /** Whether the worker should run in the OS background policy on spawn. */
  backgroundPolicy: boolean;
  /** The background policy was applied to the spawned worker. */
  backgroundPolicyApplied: boolean;
  /**
   * The worker published the graph and answered (`derivedPending`); it keeps
   * the key, its slot and its database while it finishes derived analysis.
   * Set together with `publishedResponse` and `drained`.
   */
  draining: boolean;
  publishedResponse: CodeGraphWorkerBuildResponse | undefined;
  /** Resolves when a drain ends, however it ends. */
  drained: Promise<void> | undefined;
  endDrain: (() => void) | undefined;
  /** Cleanup or teardown ended the drain: nothing waiting on it may start. */
  drainCanceled: boolean;
  /** Hidden derived repairs share all writer slots/fences, not source UI state. */
  completed: boolean;
  lastBuildStatus: CodeGraphBuildStatus | undefined;
}

interface PendingBuildFollowUp {
  id: string;
  state: {
    request: CodeGraphWorkerBuildRequest;
    scheduling: CodeGraphBuildSchedulingOptions;
  };
  promise: Promise<CodeGraphWorkerBuildResponse>;
}

interface SummaryRepairAttempt {
  attemptId: string | null;
  projectId: string;
  canceled: boolean;
  satisfiedBySourceAttemptId?: string;
  promise: Promise<CodeGraphSummaryRepairResult>;
}

function isSummaryRepairAttemptCanceled(
  attempt: SummaryRepairAttempt | undefined,
): boolean {
  return attempt?.canceled === true;
}

function mergeBuildOptions(
  existing: CodeGraphBuildOptions,
  incoming: CodeGraphBuildOptions,
): CodeGraphBuildOptions {
  return {
    computeDerived:
      existing.computeDerived !== false || incoming.computeDerived !== false,
    ...(existing.verifyContent === true ||
    existing.forceReparse === true ||
    incoming.verifyContent === true ||
    incoming.forceReparse === true
      ? { verifyContent: true }
      : {}),
    ...(existing.forceReparse === true || incoming.forceReparse === true
      ? { forceReparse: true }
      : {}),
  };
}

function requestsStrongerBuild(
  existing: CodeGraphBuildOptions,
  incoming: CodeGraphBuildOptions,
): boolean {
  const existingVerifies =
    existing.verifyContent === true || existing.forceReparse === true;
  return (
    (incoming.forceReparse === true && existing.forceReparse !== true) ||
    (incoming.verifyContent === true && !existingVerifies) ||
    (incoming.computeDerived !== false && existing.computeDerived === false)
  );
}

const PRIORITY_RANK: Readonly<Record<CodeGraphBuildPriority, number>> = {
  maintenance: 0,
  worktree: 1,
  'first-build': 2,
  agent: 3,
};

/**
 * Whether a settled worker response leaves the key with a published graph:
 * a successful build, or an eager seed that installed or found one.
 */
function responsePublishesGraph(response: CodeGraphWorkerResponse): boolean {
  if (!response.ok) return false;
  return !('status' in response) || response.status !== 'no-compatible-source';
}

/**
 * Scheduling for a request that runs after an earlier operation on the same
 * key. Once that operation published the graph, a queued first build is an
 * ordinary refresh.
 */
function schedulingAfter(
  response: CodeGraphWorkerResponse,
  scheduling: CodeGraphBuildSchedulingOptions | undefined,
): CodeGraphBuildSchedulingOptions | undefined {
  return scheduling?.priority === 'first-build' &&
    responsePublishesGraph(response)
    ? { ...scheduling, priority: 'worktree' }
    : scheduling;
}

function mergeBuildScheduling(
  existing: CodeGraphBuildSchedulingOptions,
  incoming: CodeGraphBuildSchedulingOptions | undefined,
): CodeGraphBuildSchedulingOptions {
  const existingPriority = existing.priority ?? 'worktree';
  const incomingPriority = incoming?.priority ?? 'worktree';
  const priority =
    PRIORITY_RANK[incomingPriority] > PRIORITY_RANK[existingPriority]
      ? incomingPriority
      : existingPriority;
  const existingMetadata = existing.metadata;
  const incomingMetadata = incoming?.metadata;
  const metadata =
    existingMetadata === undefined
      ? incomingMetadata
      : incomingMetadata === undefined
        ? existingMetadata
        : {
            ...existingMetadata,
            workspaceIds: uniqueWorkspaceIds([
              ...existingMetadata.workspaceIds,
              ...incomingMetadata.workspaceIds,
            ]),
          };
  return {
    priority,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

// Every in-flight build (queued OR running), keyed `${workspaceId}/${worktreeId}`.
const builds = new Map<string, BuildRecord>();
// FIFO of records that have not yet been spawned (waiting for a free slot).
const queue: BuildRecord[] = [];
let activeBuildCount = 0;
let activeBackgroundBuildCount = 0;
let activeEagerSeedCount = 0;
let queueRevision = 0;
let manualQueueOrder = false;
let backgroundBuildInterTaskDelayMs =
  DEFAULT_BACKGROUND_BUILD_INTER_TASK_DELAY_MS;
let backgroundBuildReadyAt = 0;
let backgroundBuildPumpTimer: NodeJS.Timeout | undefined;
const pendingSourceAdmissions = new Map<string, number>();
const summaryRepairAttempts = new Map<string, SummaryRepairAttempt>();
const summaryRepairCooldownUntil = new Map<string, number>();
let backgroundCompletionsSinceSummaryRepair = 0;

function isSummaryRepairRequest(
  request: CodeGraphWorkerRequest,
): request is CodeGraphWorkerSummaryRepairRequest {
  return request.operation === 'summary-repair';
}

function isSourceBuildRequest(
  request: CodeGraphWorkerRequest,
): request is CodeGraphWorkerBuildRequest {
  return (
    isBuildWorkerRequest(request) &&
    request.baseFinalization?.repairSummaryProjection !== true
  );
}

function isBuildWorkerRequest(
  request: CodeGraphWorkerRequest,
): request is CodeGraphWorkerBuildRequest {
  return !isEagerSeedRequest(request) && !isSummaryRepairRequest(request);
}

function isBaseSummaryRepairRequest(
  request: CodeGraphWorkerRequest,
): request is CodeGraphWorkerBuildRequest {
  return (
    isBuildWorkerRequest(request) &&
    request.baseFinalization?.repairSummaryProjection === true
  );
}

function isRepairRequest(request: CodeGraphWorkerRequest): boolean {
  return isSummaryRepairRequest(request) || isBaseSummaryRepairRequest(request);
}

function sameRequestKind(
  left: CodeGraphWorkerRequest,
  right: CodeGraphWorkerRequest,
): boolean {
  return (
    isEagerSeedRequest(left) === isEagerSeedRequest(right) &&
    isSummaryRepairRequest(left) === isSummaryRepairRequest(right) &&
    isBaseSummaryRepairRequest(left) === isBaseSummaryRepairRequest(right)
  );
}

function isVisibleQueueRecord(record: BuildRecord): boolean {
  return !isRepairRequest(record.request);
}

function visibleQueuedRecords(): BuildRecord[] {
  return queue.filter(isVisibleQueueRecord);
}

function clearBackgroundBuildPumpTimer(): void {
  if (backgroundBuildPumpTimer !== undefined) {
    clearTimeout(backgroundBuildPumpTimer);
    backgroundBuildPumpTimer = undefined;
  }
}

function scheduleBackgroundBuildPump(): void {
  if (
    backgroundBuildPumpTimer !== undefined ||
    activeBackgroundBuildCount >= BACKGROUND_BUILD_CONCURRENCY_CAP ||
    !queue.some(
      (record) =>
        !record.settled &&
        !isEagerSeedRequest(record.request) &&
        record.priority !== 'agent',
    )
  ) {
    return;
  }
  const delayMs = Math.max(0, backgroundBuildReadyAt - Date.now());
  if (delayMs === 0) {
    return;
  }
  backgroundBuildPumpTimer = setTimeout(() => {
    backgroundBuildPumpTimer = undefined;
    pumpQueue();
  }, delayMs);
  backgroundBuildPumpTimer.unref?.();
}

export const codeGraphBuildRunnerTestExports = {
  defaultBackgroundBuildInterTaskDelayMs:
    DEFAULT_BACKGROUND_BUILD_INTER_TASK_DELAY_MS,
  resetSummaryRepairSchedulingState(): void {
    backgroundCompletionsSinceSummaryRepair = 0;
    summaryRepairCooldownUntil.clear();
  },
  setBackgroundBuildInterTaskDelayMs(delayMs: number): void {
    backgroundBuildInterTaskDelayMs = Math.max(0, delayMs);
    backgroundBuildReadyAt = 0;
    clearBackgroundBuildPumpTimer();
  },
};

// --- Build-status broadcast -------------------------------------------------
//
// An optional module-level listener so main-process wiring (see
// `apps/desktop-app/src/main/ipc/code-graph-build-status.ts`) can broadcast a
// "graph building" indicator to renderer windows without this module knowing
// anything about IPC/Electron windows. Deliberately decoupled: the engine and
// this runner stay usable from the CLI (which never sets a listener).

export type CodeGraphBuildStatus = 'building' | 'idle';

type CodeGraphBuildStatusListener = (
  key: string,
  status: CodeGraphBuildStatus,
) => void;

let statusListener: CodeGraphBuildStatusListener | null = null;
type CodeGraphGenerationQueueListener = (
  snapshot: CodeGraphGenerationQueueSnapshot,
) => void;
let queueListener: CodeGraphGenerationQueueListener | null = null;

/**
 * Install (or clear, via `null`) the single build-status listener. Call sites
 * wire this once at app startup; a second call replaces the previous
 * listener rather than stacking listeners.
 */
export function setCodeGraphBuildStatusListener(
  listener: CodeGraphBuildStatusListener | null,
): void {
  statusListener = listener;
}

export function setCodeGraphGenerationQueueListener(
  listener: CodeGraphGenerationQueueListener | null,
): void {
  queueListener = listener;
}

function uniqueWorkspaceIds(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  ).sort();
}

function queueEntry(record: BuildRecord): CodeGraphQueueEntry {
  return {
    id: record.id,
    scope: record.metadata.scope,
    workspaceIds: [...record.metadata.workspaceIds],
    ...(record.metadata.workspaceLabel
      ? { workspaceLabel: record.metadata.workspaceLabel }
      : {}),
    ...(record.metadata.worktreeId
      ? { worktreeId: record.metadata.worktreeId }
      : {}),
    ...(record.metadata.repositoryId
      ? { repositoryId: record.metadata.repositoryId }
      : {}),
    ...(record.metadata.label ? { label: record.metadata.label } : {}),
    trigger: record.metadata.trigger,
    queuedAt: record.queuedAt,
    startedAt: record.startedAt,
    status: record.started ? 'running' : 'queued',
    reorderable: !record.started,
  };
}

export function getCodeGraphGenerationQueueSnapshot(): CodeGraphGenerationQueueSnapshot {
  const running = Array.from(builds.values())
    .filter(
      (record) =>
        isVisibleQueueRecord(record) && record.started && !record.settled,
    )
    .sort(
      (left, right) =>
        (left.startedAt ?? 0) - (right.startedAt ?? 0) ||
        left.id.localeCompare(right.id),
    );
  return {
    revision: queueRevision,
    entries: [
      ...running,
      ...queue.filter(
        (record) => !record.settled && isVisibleQueueRecord(record),
      ),
    ].map(queueEntry),
  };
}

/** True while a worktree graph build is queued or running. Read-side tooling
 * uses this to distinguish an in-progress refresh from a genuinely absent
 * graph during the brief pre-install window. */
export function isCodeGraphBuildPending(key: string): boolean {
  return builds.has(key) || supersessions.has(key);
}

/** Source-generation state intentionally ignores hidden repairs and drains. */
export function getCodeGraphSourceBuildState(key: string): CodeGraphBuildState {
  const record = builds.get(key);
  if (
    record !== undefined &&
    !record.draining &&
    (isSourceBuildRequest(record.request) || isEagerSeedRequest(record.request))
  ) {
    return record.started ? 'running' : 'queued';
  }
  // Includes a real source waiting behind repair/drain/supersession. Derived
  // drain alone has no source waiter and remains idle, while scheduler pending
  // deliberately keeps its existing broader lifecycle predicate.
  return (pendingSourceAdmissions.get(key) ?? 0) > 0 ? 'queued' : 'idle';
}

function trackSourceAdmission<T>(key: string, promise: Promise<T>): Promise<T> {
  pendingSourceAdmissions.set(key, (pendingSourceAdmissions.get(key) ?? 0) + 1);
  const release = (): void => {
    const remaining = (pendingSourceAdmissions.get(key) ?? 1) - 1;
    if (remaining === 0) pendingSourceAdmissions.delete(key);
    else pendingSourceAdmissions.set(key, remaining);
  };
  void promise.then(release, release);
  return promise;
}

function emitQueueSnapshot(): void {
  queueRevision += 1;
  if (queueListener === null) {
    return;
  }
  try {
    queueListener(getCodeGraphGenerationQueueSnapshot());
  } catch {
    // Renderer notification failures must never corrupt runner bookkeeping.
  }
}

function invalidQueueRequest(message: string): CodeGraphIpcError {
  return { ok: false, code: 'invalid-request', message };
}

export function reorderCodeGraphGenerationQueue(
  request: CodeGraphReorderGenerationQueueRequest,
): CodeGraphReorderGenerationQueueResponse {
  if (
    !Number.isSafeInteger(request.revision) ||
    !Array.isArray(request.orderedQueuedEntryIds) ||
    request.orderedQueuedEntryIds.some((id) => typeof id !== 'string')
  ) {
    return invalidQueueRequest(
      'The generation queue reorder request is invalid.',
    );
  }
  if (request.revision !== queueRevision) {
    return {
      ok: false,
      code: 'conflict',
      message: 'The generation queue changed. Reload it and try again.',
      snapshot: getCodeGraphGenerationQueueSnapshot(),
    };
  }
  const ids = request.orderedQueuedEntryIds;
  const visibleQueued = visibleQueuedRecords();
  if (new Set(ids).size !== ids.length || ids.length !== visibleQueued.length) {
    return invalidQueueRequest(
      'The reorder must contain every queued generation exactly once.',
    );
  }
  const byId = new Map(visibleQueued.map((record) => [record.id, record]));
  if (ids.some((id) => !byId.has(id))) {
    return invalidQueueRequest(
      'The reorder contains an unknown or non-queued generation.',
    );
  }
  const reordered = ids.flatMap((id) => {
    const record = byId.get(id);
    return record === undefined ? [] : [record];
  });
  let visibleIndex = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current !== undefined && isVisibleQueueRecord(current)) {
      const next = reordered[visibleIndex];
      if (next !== undefined) queue[index] = next;
      visibleIndex += 1;
    }
  }
  manualQueueOrder = reordered.length > 0;
  emitQueueSnapshot();
  return getCodeGraphGenerationQueueSnapshot();
}

/**
 * Notify the status listener, if any. A throwing listener must never break a
 * build — every call site below is a step in the build lifecycle, so an
 * uncaught exception here would corrupt build bookkeeping for an unrelated
 * reason.
 */
function emitBuildStatus(key: string, status: CodeGraphBuildStatus): void {
  if (statusListener === null) {
    return;
  }
  try {
    statusListener(key, status);
  } catch {
    // A misbehaving listener must never take down a code-graph build.
  }
}

function setRecordBuildStatus(
  record: BuildRecord,
  status: CodeGraphBuildStatus,
): void {
  if (!isVisibleQueueRecord(record) || record.lastBuildStatus === status) {
    return;
  }
  record.lastBuildStatus = status;
  emitBuildStatus(record.key, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkerResponse(value: unknown): value is CodeGraphWorkerResponse {
  if (!isRecord(value) || value.kind === 'derived-complete') {
    return false;
  }
  if (value.ok === true) {
    return (
      isRecord(value.result) ||
      (typeof value.status === 'string' &&
        ['seeded', 'existing', 'no-compatible-source'].includes(value.status) &&
        typeof value.durationMs === 'number')
    );
  }
  if (value.ok === false) {
    return typeof value.message === 'string';
  }
  return false;
}

function isEagerSeedRequest(
  request: CodeGraphWorkerRequest,
): request is CodeGraphWorkerEagerSeedRequest {
  return request.operation === 'eager-seed';
}

/** A build response whose worker goes on to finish derived analysis. */
function isPublishedWithDerivedPending(
  response: CodeGraphWorkerResponse,
): response is CodeGraphWorkerBuildResponse {
  return response.ok && 'derivedPending' in response
    ? response.derivedPending === true
    : false;
}

// --- Deferred derived analysis (the drain) ----------------------------------
//
// A worktree build that defers derived analysis answers its caller when the
// graph is published, then its worker keeps running derived analysis. The
// record stays in `builds` with its started slot until the worker reports
// completion or exits, so cancellation, teardown, the watchdog and the
// single-writer rule cover the drain exactly as they cover the build.
//
// A later build for the same key never waits for a drain: it supersedes it.
// The draining worker is killed (its uncommitted analysis rolls back; the
// graph keeps reporting stale derived data) and the new build starts only
// after that worker exits, so two writers never overlap. Every build
// requested while the exit is pending chains on the same wait and then
// coalesces into one record. That build defers derived analysis again, so
// analysis runs once, on the latest graph.

interface Supersession {
  wait: Promise<void>;
  canceled: boolean;
}

const supersessions = new Map<string, Supersession>();

function beginDrain(
  record: BuildRecord,
  response: CodeGraphWorkerBuildResponse,
): void {
  record.draining = true;
  record.publishedResponse = response;
  record.drained = new Promise<void>((resolve) => {
    record.endDrain = resolve;
  });
  record.completed = true;
  // Facts are published; the drain still holds the writer slot but is no
  // longer a source-generation state for summary consumers.
  setRecordBuildStatus(record, 'idle');
  record.resolve(response);
}

function supersedeDrain(record: BuildRecord): Supersession {
  const existing = supersessions.get(record.key);
  if (existing !== undefined) return existing;
  rejectRecord(
    record,
    new CodeGraphWorkerBuildError(
      'canceled',
      `Derived analysis for "${record.key}" was superseded by a newer build.`,
    ),
  );
  const exitWait = pendingExitWaits.get(record.key) ?? Promise.resolve();
  const supersession: Supersession = {
    canceled: false,
    wait: exitWait.then(() => {
      if (supersessions.get(record.key) === supersession) {
        supersessions.delete(record.key);
      }
    }),
  };
  supersessions.set(record.key, supersession);
  return supersession;
}

function afterSupersession<T>(
  key: string,
  supersession: Supersession,
  enqueue: () => Promise<T>,
): Promise<T> {
  return supersession.wait.then(() => {
    if (supersession.canceled) {
      throw new CodeGraphWorkerBuildError(
        'canceled',
        `Code-graph build for "${key}" was canceled.`,
      );
    }
    return enqueue();
  });
}

/**
 * Enqueue a code-graph build for one worktree.
 *
 * Single-flight per `key` and operation: equivalent calls share one promise.
 * A stronger build request upgrades a queued record before it starts, or
 * schedules one serialized follow-up when the existing worker has already
 * started. Different operations for
 * one key serialize because their response shapes differ and both can write the
 * same database. Total concurrency is capped at two workers; background work
 * uses one slot and an agent request may use the second. Every terminal path —
 * response, worker exit, watchdog timeout,
 * cancellation, spawn/post failure — settles the promise, so no code path can
 * leave a hung promise.
 */
export function runCodeGraphWorkerBuild(
  key: string,
  request: CodeGraphWorkerBuildRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
): Promise<CodeGraphWorkerBuildResponse> {
  return beginCodeGraphWorkerBuild(key, request, scheduling).promise;
}

/** Additive attempt identity for callers that need to report single-flight. */
interface BuildAttemptIdentity {
  id: string | null;
}
const pendingBuildIdentities = new Map<string, Set<BuildAttemptIdentity>>();
/** Bind real follow-up reservations, but do not expose their correlation id. */
function bindBuildIdentity(
  requestedId: string | undefined,
  reservedId: string,
): void {
  if (requestedId === undefined) return;
  const group =
    pendingBuildIdentities.get(reservedId) ?? new Set<BuildAttemptIdentity>();
  for (const identity of Array.from(
    pendingBuildIdentities.get(requestedId) ?? [],
  ))
    group.add(identity);
  pendingBuildIdentities.set(reservedId, group);
  pendingBuildIdentities.set(requestedId, group);
}
function adoptBuildIdentity(
  requestedId: string | undefined,
  actualId: string,
): void {
  if (requestedId === undefined) return;
  for (const identity of Array.from(
    pendingBuildIdentities.get(requestedId) ?? [],
  ))
    identity.id = actualId;
}

export function beginCodeGraphWorkerBuild(
  key: string,
  request: CodeGraphWorkerBuildRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
): CodeGraphWorkerBuildHandle {
  const requestedId = randomUUID();
  const identity: BuildAttemptIdentity = { id: null };
  pendingBuildIdentities.set(requestedId, new Set([identity]));
  const queued = enqueueCodeGraphWorkerRequest(
    key,
    request,
    scheduling,
    requestedId,
  );
  const promise = isRepairRequest(request)
    ? queued
    : trackSourceAdmission(key, queued);
  // Deferred drain/supersession routes adopt the actual record only when their
  // enqueue runs. Keep this cell with the returned handle, not in a global
  // settled-record map; callers read it after settlement (including failure).
  void promise.then(
    () => pendingBuildIdentities.delete(requestedId),
    () => pendingBuildIdentities.delete(requestedId),
  );
  return {
    get attemptId(): string | null {
      return identity.id;
    },
    promise,
  };
}

export function runCodeGraphWorkerEagerSeed(
  key: string,
  request: CodeGraphWorkerEagerSeedRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
): Promise<CodeGraphWorkerEagerSeedResponse> {
  return trackSourceAdmission(
    key,
    enqueueCodeGraphWorkerRequest(key, request, scheduling),
  );
}

/**
 * Routes a request for a key whose worker is draining derived analysis, or
 * whose drain is being superseded (see "the drain" above); undefined when
 * neither applies.
 */
function routeAroundDrain(
  key: string,
  existing: BuildRecord | undefined,
  request: CodeGraphWorkerRequest,
  scheduling: CodeGraphBuildSchedulingOptions | undefined,
  requestedId: string | undefined,
): Promise<CodeGraphWorkerResponse> | undefined {
  const pendingSupersession = supersessions.get(key);
  if (existing === undefined && pendingSupersession !== undefined) {
    return afterSupersession<CodeGraphWorkerResponse>(
      key,
      pendingSupersession,
      () =>
        isEagerSeedRequest(request)
          ? enqueueCodeGraphWorkerRequest(key, request, scheduling, requestedId)
          : enqueueCodeGraphWorkerRequest(
              key,
              request,
              scheduling,
              requestedId,
            ),
    );
  }
  if (existing?.draining !== true) {
    return undefined;
  }
  const published = existing.publishedResponse;
  const next =
    published === undefined
      ? scheduling
      : schedulingAfter(published, scheduling);
  if (isEagerSeedRequest(request)) {
    // The graph exists; an eager seed would only confirm it, which is not
    // worth discarding the analysis for. It runs once the drain has ended and
    // its worker has exited, so two writers never overlap, and not at all
    // when cleanup or teardown ended the drain.
    const drainRecord = existing;
    return (drainRecord.drained ?? Promise.resolve())
      .then(() =>
        drainRecord.childExited
          ? undefined
          : waitForChildExit(drainRecord.child),
      )
      .then(() => {
        if (drainRecord.drainCanceled) {
          throw new CodeGraphWorkerBuildError(
            'canceled',
            `Code-graph build for "${key}" was canceled.`,
          );
        }
        return enqueueCodeGraphWorkerRequest(key, request, next, requestedId);
      });
  }
  if (isRepairRequest(request)) {
    const drainRecord = existing;
    return (drainRecord.drained ?? Promise.resolve())
      .then(() =>
        drainRecord.childExited ? undefined : waitForActualWriterExits(key),
      )
      .then(() => {
        if (drainRecord.drainCanceled) {
          throw new CodeGraphWorkerBuildError(
            'canceled',
            `Code-graph build for "${key}" was canceled.`,
          );
        }
        return enqueueCodeGraphWorkerRequest(
          key,
          request,
          scheduling,
          requestedId,
        );
      });
  }
  return afterSupersession(key, supersedeDrain(existing), () =>
    enqueueCodeGraphWorkerRequest(key, request, next, requestedId),
  );
}

function enqueueCodeGraphWorkerRequest(
  key: string,
  request: CodeGraphWorkerBuildRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
  requestedId?: string,
): Promise<CodeGraphWorkerBuildResponse>;
function enqueueCodeGraphWorkerRequest(
  key: string,
  request: CodeGraphWorkerEagerSeedRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
  requestedId?: string,
): Promise<CodeGraphWorkerEagerSeedResponse>;
function enqueueCodeGraphWorkerRequest(
  key: string,
  request: CodeGraphWorkerSummaryRepairRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
  requestedId?: string,
): Promise<CodeGraphWorkerSummaryRepairResponse>;
function enqueueCodeGraphWorkerRequest(
  key: string,
  request: CodeGraphWorkerRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
  requestedId?: string,
): Promise<CodeGraphWorkerResponse>;
function enqueueCodeGraphWorkerRequest(
  key: string,
  request: CodeGraphWorkerRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
  requestedId?: string,
): Promise<CodeGraphWorkerResponse> {
  const requestedPriority = scheduling?.priority ?? 'worktree';
  const existing = builds.get(key);
  const aroundDrain = routeAroundDrain(
    key,
    existing,
    request,
    scheduling,
    requestedId,
  );
  if (aroundDrain !== undefined) {
    return aroundDrain;
  }
  if (
    existing === undefined &&
    isRepairRequest(request) &&
    (unconfirmedWriterExits.get(key)?.size ?? 0) > 0
  ) {
    return waitForActualWriterExits(key).then(() =>
      enqueueCodeGraphWorkerRequest(key, request, scheduling, requestedId),
    );
  }
  if (existing !== undefined) {
    if (
      !existing.started &&
      isSummaryRepairRequest(existing.request) &&
      !isRepairRequest(request)
    ) {
      // A queued hidden repair has not acquired an execution slot/Engine. Let
      // this source join the ordinary source order (including manual order),
      // but retain the repair's original promise and every coalesced waiter.
      const index = queue.indexOf(existing);
      if (index >= 0) queue.splice(index, 1);
      builds.delete(key);
      const source = enqueueCodeGraphWorkerRequest(
        key,
        request,
        scheduling,
        requestedId,
      );
      void satisfyParkedRepair(existing).then(
        (response) => {
          existing.settled = true;
          existing.resolve(response);
        },
        (error: unknown) => {
          existing.settled = true;
          existing.reject(
            error instanceof CodeGraphWorkerBuildError
              ? error
              : new CodeGraphWorkerBuildError(
                  'worker-exit',
                  'The source projection could not be verified.',
                ),
          );
        },
      );
      return source;
    }
    if (isRepairRequest(existing.request) && isSourceBuildRequest(request)) {
      if (existing.followUp !== undefined) {
        existing.followUp.state.request = {
          ...request,
          options: mergeBuildOptions(
            existing.followUp.state.request.options,
            request.options,
          ),
        };
        existing.followUp.state.scheduling = mergeBuildScheduling(
          existing.followUp.state.scheduling,
          scheduling,
        );
        bindBuildIdentity(requestedId, existing.followUp.id);
        return existing.followUp.promise;
      }
      const followUpId = requestedId ?? randomUUID();
      const state = { request, scheduling: scheduling ?? {} };
      const admitSource = (): Promise<CodeGraphWorkerBuildResponse> =>
        enqueueCodeGraphWorkerRequest(
          key,
          state.request,
          state.scheduling,
          followUpId,
        );
      const promise = existing.promise.then(admitSource, (error: unknown) => {
        // Maintenance failure is not the independent source's result. Only
        // typed worker failures may release this reservation; explicit stop
        // reasons and unknown errors must still reject every waiting caller.
        if (!(error instanceof CodeGraphWorkerBuildError)) throw error;
        switch (error.reason) {
          case 'worker-exit':
          case 'malformed-response':
          case 'timeout':
          case 'spawn-failed':
          case 'post-failed':
            // Never treat the bounded cleanup timeout as writer authority.
            // enqueue/startBuild retains the normal availability guard.
            return waitForActualWriterExits(key).then(admitSource);
          default:
            throw error;
        }
      });
      existing.followUp = { id: followUpId, state, promise };
      bindBuildIdentity(requestedId, followUpId);
      return promise;
    }
    if (!sameRequestKind(existing.request, request)) {
      // Build and eager-seed responses have incompatible shapes. Preserve
      // same-operation single-flight behavior, but serialize a different
      // operation for the same database instead of handing its caller the
      // existing operation's promise. A rejected operation also rejects the
      // dependent request, so cancellation/teardown cannot spawn fresh work.
      return existing.promise.then<CodeGraphWorkerResponse>((response) => {
        const next = schedulingAfter(response, scheduling);
        return isEagerSeedRequest(request)
          ? enqueueCodeGraphWorkerRequest(key, request, next, requestedId)
          : enqueueCodeGraphWorkerRequest(key, request, next, requestedId);
      });
    }
    // An agent now waits on this record, directly or through a follow-up. A
    // running background worker leaves the OS background policy so its
    // throttled disk I/O does not stretch that wait; lane accounting stays
    // unchanged.
    if (requestedPriority === 'agent' && existing.started) {
      existing.backgroundPolicy = false;
      if (
        existing.backgroundPolicyApplied &&
        typeof existing.child?.pid === 'number'
      ) {
        existing.backgroundPolicyApplied = false;
        leaveBackgroundProcessPolicy(existing.child.pid);
      }
    }
    if (
      isSourceBuildRequest(existing.request) &&
      isSourceBuildRequest(request) &&
      requestsStrongerBuild(existing.request.options, request.options)
    ) {
      const mergedOptions = mergeBuildOptions(
        existing.request.options,
        request.options,
      );
      if (existing.started) {
        if (existing.followUp !== undefined) {
          existing.followUp.state.request = {
            ...request,
            options: mergeBuildOptions(
              existing.followUp.state.request.options,
              request.options,
            ),
          };
          existing.followUp.state.scheduling = mergeBuildScheduling(
            existing.followUp.state.scheduling,
            scheduling,
          );
          bindBuildIdentity(requestedId, existing.followUp.id);
          return existing.followUp.promise;
        }
        const state = {
          request: {
            ...request,
            options: mergedOptions,
          },
          scheduling: mergeBuildScheduling(
            { priority: existing.priority, metadata: existing.metadata },
            scheduling,
          ),
        };
        const followUpId = requestedId ?? randomUUID();
        const promise = existing.promise.then<CodeGraphWorkerBuildResponse>(
          (response) =>
            enqueueCodeGraphWorkerRequest(
              key,
              state.request,
              schedulingAfter(response, state.scheduling),
              followUpId,
            ),
        );
        existing.followUp = { id: followUpId, state, promise };
        bindBuildIdentity(requestedId, followUpId);
        return promise;
      }
      existing.request = {
        ...existing.request,
        options: mergedOptions,
      };
    }
    if (scheduling?.metadata !== undefined) {
      const mergedWorkspaceIds = uniqueWorkspaceIds([
        ...existing.metadata.workspaceIds,
        ...scheduling.metadata.workspaceIds,
      ]);
      if (
        mergedWorkspaceIds.join('\0') !==
        existing.metadata.workspaceIds.join('\0')
      ) {
        existing.metadata = {
          ...existing.metadata,
          workspaceIds: mergedWorkspaceIds,
        };
        if (isVisibleQueueRecord(existing)) emitQueueSnapshot();
      }
    }
    promoteQueuedRecord(existing, requestedPriority);
    adoptBuildIdentity(requestedId, existing.id);
    return existing.promise;
  }

  let resolveFn: (response: CodeGraphWorkerResponse) => void = () => {};
  let rejectFn: (error: CodeGraphWorkerBuildError) => void = () => {};
  const promise = new Promise<CodeGraphWorkerResponse>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const record: BuildRecord = {
    id: requestedId ?? randomUUID(),
    key,
    request,
    promise,
    resolve: resolveFn,
    reject: rejectFn,
    child: undefined,
    watchdog: undefined,
    started: false,
    settled: false,
    childExited: false,
    priority: requestedPriority,
    firstBuildsAhead: 0,
    metadata: scheduling?.metadata
      ? {
          ...scheduling.metadata,
          workspaceIds: uniqueWorkspaceIds(scheduling.metadata.workspaceIds),
        }
      : {
          scope:
            scheduling?.priority === 'maintenance'
              ? 'workspace-shadow'
              : 'worktree',
          workspaceIds: [],
          trigger: 'unspecified',
        },
    queuedAt: Date.now(),
    startedAt: null,
    timeoutMs: null,
    pendingRejection: undefined,
    followUp: undefined,
    backgroundPolicy: false,
    backgroundPolicyApplied: false,
    draining: false,
    publishedResponse: undefined,
    drained: undefined,
    endDrain: undefined,
    drainCanceled: false,
    completed: false,
    lastBuildStatus: undefined,
  };
  adoptBuildIdentity(requestedId, record.id);
  if (isSummaryRepairRequest(request)) {
    const repair = summaryRepairAttempts.get(key);
    if (repair !== undefined) repair.attemptId = record.id;
  }
  builds.set(key, record);
  if (manualQueueOrder || requestedPriority === 'maintenance') {
    queue.push(record);
  } else if (requestedPriority === 'agent') {
    queue.unshift(record);
  } else if (requestedPriority === 'first-build') {
    insertFirstBuild(record);
  } else {
    const firstMaintenance = queue.findIndex(
      (candidate) => candidate.priority === 'maintenance',
    );
    if (firstMaintenance === -1) {
      queue.push(record);
    } else {
      queue.splice(firstMaintenance, 0, record);
    }
  }
  if (isVisibleQueueRecord(record)) emitQueueSnapshot();
  pumpQueue();
  return promise;
}

/**
 * Raises a still-queued single-flight record to a stronger requested class.
 * Both callers keep the same promise and no second worker/database writer is
 * created; a running record cannot be moved and needs no promotion.
 */
function promoteQueuedRecord(
  existing: BuildRecord,
  requestedPriority: CodeGraphBuildPriority,
): void {
  if (existing.started) return;
  if (requestedPriority === 'agent') {
    // An agent asking for a build must not remain stranded behind background
    // work that already queued the same single-flight key.
    existing.priority = 'agent';
    const queueIndex = queue.indexOf(existing);
    if (!manualQueueOrder && queueIndex > 0) {
      queue.splice(queueIndex, 1);
      queue.unshift(existing);
      emitQueueSnapshot();
    }
    pumpQueue();
    return;
  }
  if (
    requestedPriority === 'first-build' &&
    PRIORITY_RANK[existing.priority] < PRIORITY_RANK['first-build']
  ) {
    // The key has no published graph after all: its queued refresh is a
    // first build. It moves up to the first-build position unless the user
    // fixed the order, and never later: aging may already have put it ahead
    // of that position.
    existing.priority = 'first-build';
    const queueIndex = queue.indexOf(existing);
    if (!manualQueueOrder && queueIndex >= 0) {
      queue.splice(queueIndex, 1);
      const index = Math.min(firstBuildInsertionIndex(), queueIndex);
      // Only the refreshes it now overtakes age.
      for (const passed of queue.slice(index, queueIndex)) {
        if (isAgingRefresh(passed)) passed.firstBuildsAhead += 1;
      }
      queue.splice(index, 0, existing);
      emitQueueSnapshot();
    }
    pumpQueue();
  }
}

/** Eager seeds use their own lane, so their queue position never matters. */
function isAgingRefresh(record: BuildRecord): boolean {
  return record.priority === 'worktree' && isSourceBuildRequest(record.request);
}

/**
 * Queues a first build behind agent builds, earlier first builds, and every
 * refresh that has already let {@link CODE_GRAPH_FIRST_BUILD_OVERTAKE_LIMIT}
 * first builds pass it; it goes ahead of the remaining refreshes and
 * maintenance builds. Each refresh it passes ages by one.
 */
function insertFirstBuild(record: BuildRecord): void {
  const index = firstBuildInsertionIndex();
  for (const passed of queue.slice(index)) {
    if (isAgingRefresh(passed)) passed.firstBuildsAhead += 1;
  }
  queue.splice(index, 0, record);
}

/** Where a new first build joins the queue; see {@link insertFirstBuild}. */
function firstBuildInsertionIndex(): number {
  let index = 0;
  queue.forEach((candidate, position) => {
    if (
      candidate.priority === 'agent' ||
      candidate.priority === 'first-build' ||
      (isAgingRefresh(candidate) &&
        candidate.firstBuildsAhead >= CODE_GRAPH_FIRST_BUILD_OVERTAKE_LIMIT)
    ) {
      index = position + 1;
    }
  });
  return index;
}

export function updateCodeGraphBuildOwners(
  key: string,
  workspaceIds: readonly string[],
): void {
  const record = builds.get(key);
  if (record === undefined || record.metadata.scope !== 'workspace-shadow') {
    return;
  }
  const next = uniqueWorkspaceIds(workspaceIds);
  if (next.join('\0') === record.metadata.workspaceIds.join('\0')) {
    return;
  }
  record.metadata = { ...record.metadata, workspaceIds: next };
  emitQueueSnapshot();
}

export function reconcileCodeGraphBuildAvailability(
  isAvailable: (workspaceId: string) => boolean,
): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const attempt of Array.from(summaryRepairAttempts.values())) {
    if (!isAvailable(attempt.projectId)) attempt.canceled = true;
  }
  for (const record of Array.from(builds.values())) {
    if (record.metadata.scope === 'worktree') {
      const owner = record.metadata.workspaceIds[0];
      if (owner !== undefined && !isAvailable(owner)) {
        waits.push(
          cancelBuild(record.key, {
            reason: 'unavailable',
            message: 'Code graph generation is unavailable for this project.',
          }),
        );
      }
      continue;
    }
    const remainingOwners = record.metadata.workspaceIds.filter(isAvailable);
    if (remainingOwners.length === 0) {
      waits.push(
        cancelBuild(record.key, {
          reason: 'unavailable',
          message: 'Code graph generation is no longer required.',
        }),
      );
    } else {
      updateCodeGraphBuildOwners(record.key, remainingOwners);
    }
  }
  return Promise.all(waits).then(() => undefined);
}

// Bounded wait for a killed worker's 'exit' event. Cancellation callers
// (worktree cleanup, app quit) await this so the worker's file descriptors —
// including its sqlite DatabaseSync handle on graph.db — are actually
// released before they close engines or remove the worktree-data directory.
// The bound guarantees a zombie worker can never hang cleanup or quit.
const CHILD_EXIT_WAIT_MS = 5_000;

/**
 * Resolves once `child` has emitted 'exit' (fds released), or after
 * {@link CHILD_EXIT_WAIT_MS} as a fallthrough so callers can never hang on a
 * worker that refuses to die. Resolves immediately when there is no child
 * (queued-only record). Never rejects.
 */
function waitForChildExit(
  child: ExecutionHostProcess | undefined,
): Promise<void> {
  if (child === undefined) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let fallback: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (fallback !== undefined) {
        clearTimeout(fallback);
        fallback = undefined;
      }
      child.removeListener('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    fallback = setTimeout(finish, CHILD_EXIT_WAIT_MS);
    fallback.unref?.();
  });
}

// Exit waits for killed-but-not-yet-exited workers, keyed by build key.
// Killing a worker retains its record/held slots until the bounded exit
// fence; a later cancelBuild for the same
// key must return the still-pending exit wait instead of resolving vacuously.
// Registration happens inside rejectRecord, so EVERY kill path — explicit
// cancel, app teardown, watchdog timeout, malformed-response, post-failed —
// leaves an entry behind. Two production sequences depend on this: worktree
// cleanup's awaited `cancelBuild(key)` arriving one line after the
// scheduler's fire-and-forget cancel killed the same worker, and a cleanup
// arriving just after a watchdog/protocol kill whose record is already gone.
// Entries self-clear once the exit (or the bounded fallthrough) fires.
const pendingExitWaits = new Map<string, Promise<void>>();

// Actual writer liveness is independent from the legacy bounded cleanup wait.
// Only an observed child exit clears this map; a 5s cleanup timeout is never
// authority to admit a new repair writer into this owner/key.
const unconfirmedWriterExits = new Map<
  string,
  Map<ExecutionHostProcess, Promise<void>>
>();
function registerActualWriterExit(
  key: string,
  child: ExecutionHostProcess,
): Promise<void> {
  const writers =
    unconfirmedWriterExits.get(key) ??
    new Map<ExecutionHostProcess, Promise<void>>();
  const existing = writers.get(child);
  if (existing !== undefined) return existing;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      writers.delete(child);
      if (writers.size === 0 && unconfirmedWriterExits.get(key) === writers)
        unconfirmedWriterExits.delete(key);
      resolve();
    });
  });
  writers.set(child, exit);
  unconfirmedWriterExits.set(key, writers);
  return exit;
}
async function waitForActualWriterExits(key: string): Promise<void> {
  while ((unconfirmedWriterExits.get(key)?.size ?? 0) > 0) {
    await Promise.all(
      Array.from(unconfirmedWriterExits.get(key)?.values() ?? []),
    );
  }
}

/**
 * Records the exit wait for a child being killed. Called from
 * {@link rejectRecord} — the single registration point every kill path flows
 * through (exactly once per record, guarded by `record.settled`). Any wait
 * already pending for the same key (an earlier-killed worker still exiting)
 * is folded in, so the stored entry always covers every killed-but-live
 * worker for the key.
 */
function registerExitWait(
  key: string,
  child: ExecutionHostProcess,
): Promise<void> {
  void registerActualWriterExit(key, child);
  const previous = pendingExitWaits.get(key);
  const exitWait =
    previous === undefined
      ? waitForChildExit(child)
      : Promise.all([previous, waitForChildExit(child)]).then(() => undefined);
  const tracked: Promise<void> = exitWait.then(() => {
    // Only clear our own entry — a newer kill for the same key may have
    // replaced it with a wait that also covers a newer child.
    if (pendingExitWaits.get(key) === tracked) {
      pendingExitWaits.delete(key);
    }
  });
  pendingExitWaits.set(key, tracked);
  return tracked;
}

async function waitForCurrentSourceWriter(
  key: string,
  published?: (attemptId: string) => void,
): Promise<boolean> {
  while (true) {
    const supersession = supersessions.get(key);
    if (supersession !== undefined) {
      await supersession.wait;
      if (supersession.canceled) return false;
      continue;
    }
    const record = builds.get(key);
    if (record === undefined) {
      await waitForActualWriterExits(key);
      return true;
    }
    if (isRepairRequest(record.request)) {
      await record.promise;
      continue;
    }
    let response: CodeGraphWorkerResponse;
    try {
      response = await record.promise;
    } catch {
      return false;
    }
    if (!responsePublishesGraph(response)) return false;
    published?.(record.id);
    const followUp = record.followUp;
    if (followUp !== undefined) {
      try {
        response = await followUp.promise;
      } catch {
        return false;
      }
      if (!responsePublishesGraph(response)) return false;
      published?.(followUp.id);
    }
    if (record.draining) {
      await (record.drained ?? Promise.resolve());
      if (record.drainCanceled) return false;
      if (!record.childExited) await waitForActualWriterExits(key);
    }
  }
}

async function readRepairProjection(
  key: string,
  request: CodeGraphWorkerSummaryRepairRequest,
  metadata: CodeGraphBuildQueueMetadata,
): Promise<ReadCodeGraphSummaryProjectionResult> {
  const projectId = metadata.workspaceIds[0];
  // Repair is invoked after runner initialization; keep telemetry's build-error import acyclic.
  const { runCodeGraphWorkerRead, CodeGraphReadFailureError } =
    await import('./read-runner');
  const response = await runCodeGraphWorkerRead({
    key,
    kind: 'base-validation',
    ...(projectId !== undefined && metadata.worktreeId !== undefined
      ? {
          diagnosticOwner: { projectId, worktreeId: metadata.worktreeId },
        }
      : {}),
    request: { dbPath: request.dbPath, task: { kind: 'readonly-summary' } },
  });
  if (!response.ok) throw new CodeGraphReadFailureError(response.code);
  if (response.result.kind !== 'readonly-summary')
    throw new CodeGraphReadFailureError('invalid-response');
  return response.result.value;
}

async function satisfyParkedRepair(
  record: BuildRecord,
): Promise<CodeGraphWorkerSummaryRepairResponse> {
  if (!isSummaryRepairRequest(record.request))
    throw new CodeGraphWorkerBuildError(
      'malformed-response',
      'Invalid repair operation.',
    );
  const attempt = summaryRepairAttempts.get(record.key);
  const rememberSource = (id: string): void => {
    if (attempt !== undefined) attempt.satisfiedBySourceAttemptId = id;
  };
  if (!(await waitForCurrentSourceWriter(record.key, rememberSource))) {
    throw new CodeGraphWorkerBuildError(
      'worker-exit',
      'The source generation did not publish successfully.',
    );
  }
  if (
    isSummaryRepairAttemptCanceled(attempt) ||
    !record.metadata.workspaceIds.every(isCodeGraphAvailableForWorkspace)
  ) {
    throw new CodeGraphWorkerBuildError(
      'canceled',
      'The summary repair was canceled.',
    );
  }
  const projection = await readRepairProjection(
    record.key,
    record.request,
    record.metadata,
  );
  if (isSummaryRepairAttemptCanceled(attempt))
    throw new CodeGraphWorkerBuildError(
      'canceled',
      'The summary repair was canceled.',
    );
  if (projection.state === 'ready')
    return {
      ok: true,
      result: { state: 'ready', projection: projection.projection },
    };
  if (projection.state !== 'pending')
    return {
      ok: false,
      message: 'The retained code-graph summary could not be verified.',
    };
  return enqueueCodeGraphWorkerRequest(
    record.key,
    record.request,
    {
      priority: record.priority,
      metadata: record.metadata,
    },
    record.id,
  );
}

/**
 * True while an admitted summary repair for `key` has not settled. A request
 * that was refused, or that arrived during the cooldown after a failed
 * attempt, leaves nothing working on the summary.
 */
export function isCodeGraphSummaryRepairActive(key: string): boolean {
  return summaryRepairAttempts.has(key);
}

/**
 * The service close gate is registered before this operation admits a runner
 * repair. Seeded source calls acquire that gate before runner admission too;
 * they cannot hold a runner record while waiting behind this operation. Source
 * calls for completed graphs bypass the gate but serialize on this runner key.
 * Never reserve a repair runner record before acquiring the service close gate.
 */
export function requestCodeGraphSummaryRepair(
  input: CodeGraphSummaryRepairRequest,
): Promise<CodeGraphSummaryRepairResult> {
  if (
    input.key !== `${input.projectId}/${input.worktreeId}` ||
    input.projectId.trim().length === 0 ||
    input.worktreeId.trim().length === 0
  ) {
    return Promise.resolve({
      ok: false,
      attemptId: null,
      reason: 'invalid-request',
      message: 'The code-graph summary repair owner is invalid.',
    });
  }
  const active = summaryRepairAttempts.get(input.key);
  if (active !== undefined) return active.promise;
  if (!isCodeGraphAvailableForWorkspace(input.projectId)) {
    return Promise.resolve({
      ok: false,
      attemptId: null,
      reason: 'unavailable',
      message: 'Code graph generation is unavailable for this project.',
    });
  }
  if ((summaryRepairCooldownUntil.get(input.key) ?? 0) > Date.now()) {
    return Promise.resolve({
      ok: false,
      attemptId: null,
      reason: 'cooldown',
      message: 'A code-graph summary repair recently completed.',
    });
  }
  const expectedDbPath = getWorktreeCodeGraphDbPath(
    input.projectId,
    input.worktreeId,
  );
  if (path.resolve(input.dbPath) !== path.resolve(expectedDbPath)) {
    return Promise.resolve({
      ok: false,
      attemptId: null,
      reason: 'invalid-request',
      message: 'The code-graph summary repair path does not match its owner.',
    });
  }
  const requestedId = randomUUID();
  let attemptId: string | null = null;
  const attempt: SummaryRepairAttempt = {
    attemptId,
    projectId: input.projectId,
    canceled: false,
    promise: Promise.resolve({
      ok: false,
      attemptId,
      reason: 'canceled',
      message: 'The code-graph summary repair was canceled.',
    }),
  };
  const scheduling: CodeGraphBuildSchedulingOptions = {
    priority: 'maintenance',
    metadata: {
      scope: 'worktree',
      workspaceIds: [input.projectId],
      worktreeId: input.worktreeId,
      label: input.worktreeId,
      trigger: 'summary-projection-repair',
    },
  };
  let sourceAttemptId: string | null = null;
  const rememberSource = (id: string): void => {
    sourceAttemptId = id;
  };
  const promise = getCodeGraphWorktreeService()
    .withWorktreeClosed(
      input.projectId,
      input.worktreeId,
      async (): Promise<CodeGraphSummaryRepairResult> => {
        try {
          if (!(await waitForCurrentSourceWriter(input.key, rememberSource))) {
            return {
              ok: false,
              attemptId,
              reason: 'source-failed',
              message:
                'The current source generation did not publish successfully.',
            };
          }
          if (attempt.canceled) {
            return {
              ok: false,
              attemptId,
              reason: 'canceled',
              message: 'The code-graph summary repair was canceled.',
            };
          }
          if (!isCodeGraphAvailableForWorkspace(input.projectId)) {
            return {
              ok: false,
              attemptId,
              reason: 'unavailable',
              message: 'Code graph generation is unavailable for this project.',
            };
          }
          const worktreeRootPath = resolveWorktreeCwd(
            input.projectId,
            input.worktreeId,
          );
          const repositories = await resolveWorktreeCodeGraphRepositories(
            input.projectId,
            worktreeRootPath,
          );
          if (attempt.canceled) {
            return {
              ok: false,
              attemptId,
              reason: 'canceled',
              message: 'The code-graph summary repair was canceled.',
            };
          }
          if (!isCodeGraphAvailableForWorkspace(input.projectId)) {
            return {
              ok: false,
              attemptId,
              reason: 'unavailable',
              message: 'Code graph generation is unavailable for this project.',
            };
          }
          // Resolver awaits allow another completed-graph source to enter the
          // runner. Join it (including the drain) before the authoritative read.
          if (!(await waitForCurrentSourceWriter(input.key, rememberSource))) {
            return {
              ok: false,
              attemptId: sourceAttemptId,
              reason: 'source-failed',
              message:
                'The current source generation did not publish successfully.',
            };
          }
          if (
            attempt.canceled ||
            !isCodeGraphAvailableForWorkspace(input.projectId)
          ) {
            return {
              ok: false,
              attemptId: null,
              reason: 'canceled',
              message: 'The code-graph summary repair was canceled.',
            };
          }
          const { runCodeGraphWorkerRead, CodeGraphReadFailureError } =
            await import('./read-runner');
          const projectionRead = await runCodeGraphWorkerRead({
            key: input.key,
            kind: 'base-validation',
            diagnosticOwner: {
              projectId: input.projectId,
              worktreeId: input.worktreeId,
            },
            request: {
              dbPath: expectedDbPath,
              task: { kind: 'readonly-summary' },
            },
          });
          if (
            attempt.canceled ||
            !isCodeGraphAvailableForWorkspace(input.projectId)
          ) {
            return {
              ok: false,
              attemptId: null,
              reason: 'canceled',
              message: 'The code-graph summary repair was canceled.',
            };
          }
          if (!projectionRead.ok)
            throw new CodeGraphReadFailureError(projectionRead.code);
          if (projectionRead.result.kind !== 'readonly-summary')
            throw new CodeGraphReadFailureError('invalid-response');
          const projection = projectionRead.result.value;
          if (projection.state === 'ready') {
            return {
              ok: true,
              attemptId: sourceAttemptId,
              resolution:
                sourceAttemptId === null
                  ? 'already-ready'
                  : 'source-publication',
              result: { state: 'ready', projection: projection.projection },
            };
          }
          if (projection.state === 'missing' || projection.state === 'error') {
            // No existing authorized database, or a real read failure: neither is
            // permission to create/bootstrap a replacement writer or mask failure.
            return {
              ok: false,
              attemptId: null,
              reason: 'worker-failed',
              message: 'The retained code-graph summary could not be verified.',
            };
          }
          // No await between the cancel/readiness checks and same-key admission.
          // A racing source during the readonly read is serialized by enqueue;
          // the Engine method rechecks ready and may no-op after that publication.
          const response = await enqueueCodeGraphWorkerRequest(
            input.key,
            {
              operation: 'summary-repair',
              dbPath: expectedDbPath,
              worktreeRootPath,
              customLanguagesRootPath: worktreeRootPath,
              resourcesDir: getBundledCodeGraphDir(),
              repositories,
            },
            scheduling,
            requestedId,
          );
          attemptId = attempt.attemptId;
          if (!response.ok) {
            return {
              ok: false,
              attemptId,
              reason: 'worker-failed',
              message: response.message,
            };
          }
          if (response.result.state !== 'ready') {
            return {
              ok: false,
              attemptId,
              reason:
                response.result.state === 'superseded'
                  ? 'superseded'
                  : 'worker-failed',
              message: 'The code-graph summary projection remains unavailable.',
            };
          }
          return {
            ok: true,
            attemptId: attempt.satisfiedBySourceAttemptId ?? attemptId,
            resolution:
              attempt.satisfiedBySourceAttemptId === undefined
                ? 'repaired'
                : 'source-publication',
            result: response.result,
          };
        } catch (error) {
          return {
            ok: false,
            attemptId: attempt.attemptId,
            reason:
              error instanceof CodeGraphWorkerBuildError &&
              error.reason === 'canceled'
                ? 'canceled'
                : 'worker-failed',
            message: 'The code-graph summary repair could not be prepared.',
          };
        }
      },
    )
    .catch(
      (): CodeGraphSummaryRepairResult => ({
        ok: false,
        attemptId: null,
        reason: 'worker-failed',
        message: 'The retained code-graph writer could not be closed.',
      }),
    );
  attempt.promise = promise;
  summaryRepairAttempts.set(input.key, attempt);
  void promise.then((outcome) => {
    if (
      !outcome.ok &&
      outcome.reason !== 'canceled' &&
      outcome.reason !== 'unavailable'
    ) {
      summaryRepairCooldownUntil.set(
        input.key,
        Date.now() + SUMMARY_REPAIR_COOLDOWN_MS,
      );
    }
    if (summaryRepairAttempts.get(input.key) === attempt) {
      summaryRepairAttempts.delete(input.key);
    }
  });
  return promise;
}

/**
 * Cancel a queued or running build for `key`. A running worker is killed and
 * the in-flight promise rejects with `reason: 'canceled'`; a still-queued
 * build is dropped without ever spawning. Unknown keys are a no-op.
 *
 * Cancellation is marked synchronously; live writer slots/record settlement
 * for new repair records are held until observed exit (no timeout proof).
 * The returned promise also awaits
 * canceled repair preparation, and resolves once the killed worker has EXITED —
 * i.e. its DatabaseSync handle on graph.db is released — so worktree cleanup
 * can safely close engines and remove the database afterwards. Cancels are
 * exit-wait-preserving across ALL kill paths: a key whose record is already
 * gone (an earlier cancel, the watchdog, or a protocol-failure kill) but
 * whose worker has not exited yet returns that still-pending wait (see
 * {@link pendingExitWaits}) rather than resolving vacuously. Resolves
 * immediately for keys with no live worker, preparing repair or pending exit, never
 * rejects, and falls through after {@link CHILD_EXIT_WAIT_MS} so no caller
 * can hang on a zombie non-repair worker. Repair cleanup deliberately remains
 * pending until observed exit: no new writer is authorized by that timer.
 */
export function cancelBuild(
  key: string,
  options?: {
    reason?: Extract<
      CodeGraphWorkerBuildErrorReason,
      'canceled' | 'unavailable'
    >;
    message?: string;
  },
): Promise<void> {
  const summaryRepair = summaryRepairAttempts.get(key);
  if (summaryRepair !== undefined) summaryRepair.canceled = true;
  const repairSettled =
    summaryRepair?.promise.then(() => undefined) ?? Promise.resolve();
  const cleanupFence = (): Promise<void> => {
    const current = builds.get(key);
    return Promise.all([
      pendingExitWaits.get(key) ?? Promise.resolve(),
      repairSettled,
      current !== undefined && isRepairRequest(current.request)
        ? waitForActualWriterExits(key)
        : Promise.resolve(),
    ]).then(() => undefined);
  };
  const supersession = supersessions.get(key);
  if (supersession !== undefined) {
    // Builds waiting for a superseded drain to exit must not start.
    supersession.canceled = true;
  }
  const record = builds.get(key);
  if (record !== undefined) {
    // An eager seed waiting on this drain must not start.
    if (record.draining) record.drainCanceled = true;
    if (
      record.pendingRejection !== undefined &&
      !isRepairRequest(record.request)
    ) {
      return cleanupFence();
    }
    // Even after a worker failure, an explicit stop must remain authoritative
    // for a reserved source follow-up while the repair writer is exiting.
    // rejectRecord registers the exit wait (when a live child is killed);
    // read it back below rather than registering a duplicate here.
    rejectRecord(
      record,
      new CodeGraphWorkerBuildError(
        options?.reason ?? 'canceled',
        options?.message ?? `Code-graph build for "${key}" was canceled.`,
      ),
    );
  }
  return cleanupFence();
}

/**
 * Reject and tear down every in-flight and queued build. Called on app
 * teardown so no worker outlives the desktop app. Kills are issued
 * synchronously; the returned promise resolves once every killed worker has
 * exited (each with the same bounded {@link CHILD_EXIT_WAIT_MS} fallthrough
 * as {@link cancelBuild}) — including workers killed by EARLIER cancels or
 * watchdog/protocol kills that have not exited yet — and never rejects.
 */
export function killAllBuilds(): Promise<void> {
  const repairExitFences = Array.from(builds.values())
    .filter((record) => isRepairRequest(record.request))
    .map((record) => waitForActualWriterExits(record.key));
  for (const attempt of Array.from(summaryRepairAttempts.values())) {
    attempt.canceled = true;
  }
  for (const supersession of Array.from(supersessions.values())) {
    supersession.canceled = true;
  }
  // Reject queued (never-spawned) builds first, so freeing a running slot
  // below can never pump a worker into existence just to kill it.
  for (const record of Array.from(queue)) {
    rejectRecord(
      record,
      new CodeGraphWorkerBuildError(
        'canceled',
        `Code-graph build for "${record.key}" was canceled during teardown.`,
      ),
    );
  }
  for (const record of Array.from(builds.values())) {
    if (record.draining) record.drainCanceled = true;
    rejectRecord(
      record,
      new CodeGraphWorkerBuildError(
        'canceled',
        `Code-graph build for "${record.key}" was canceled during teardown.`,
      ),
    );
  }
  clearBackgroundBuildPumpTimer();
  backgroundBuildReadyAt = 0;
  // Every kill above registered its exit wait via rejectRecord; the map now
  // holds one folded entry per key, covering both the workers just killed
  // and any killed earlier (cancel/watchdog/protocol) that have not exited.
  return Promise.all([
    ...Array.from(pendingExitWaits.values()),
    ...repairExitFences,
    ...Array.from(summaryRepairAttempts.values(), (attempt) =>
      attempt.promise.then(() => undefined),
    ),
  ]).then(() => undefined);
}

function pumpQueue(): void {
  while (queue.length > 0) {
    const canRun = (record: BuildRecord): boolean => {
      if (record.settled) {
        return true;
      }
      if (isEagerSeedRequest(record.request)) {
        return activeEagerSeedCount < EAGER_SEED_CONCURRENCY_CAP;
      }
      if (activeBuildCount >= codeGraphBuildConcurrencyCap()) {
        return false;
      }
      return (
        record.priority === 'agent' ||
        (activeBackgroundBuildCount < BACKGROUND_BUILD_CONCURRENCY_CAP &&
          Date.now() >= backgroundBuildReadyAt)
      );
    };
    const repairIndex =
      backgroundCompletionsSinceSummaryRepair >= 2
        ? queue.findIndex(
            (record) =>
              !record.settled &&
              isRepairRequest(record.request) &&
              canRun(record),
          )
        : -1;
    const runnableIndex =
      repairIndex >= 0 ? repairIndex : queue.findIndex(canRun);
    if (runnableIndex === -1) {
      break;
    }
    const [record] = queue.splice(runnableIndex, 1);
    if (record === undefined || record.settled) {
      continue;
    }
    startBuild(record);
  }
  if (queue.length === 0) {
    manualQueueOrder = visibleQueuedRecords().length > 0;
  }
  scheduleBackgroundBuildPump();
}

function startBuild(record: BuildRecord): void {
  if (
    record.metadata.workspaceIds.length > 0 &&
    !record.metadata.workspaceIds.some(isCodeGraphAvailableForWorkspace)
  ) {
    rejectRecord(
      record,
      new CodeGraphWorkerBuildError(
        'unavailable',
        'Code graph generation is unavailable for this project.',
      ),
    );
    return;
  }
  record.started = true;
  record.startedAt = Date.now();
  const executionTimeoutMs = isRepairRequest(record.request)
    ? SUMMARY_REPAIR_TIMEOUT_MS
    : getCodeGraphGenerationTimeoutMs();
  record.timeoutMs = executionTimeoutMs;
  if (isEagerSeedRequest(record.request)) {
    activeEagerSeedCount += 1;
  } else {
    activeBuildCount += 1;
    if (record.priority !== 'agent') {
      activeBackgroundBuildCount += 1;
    }
  }
  // The ONLY not-running -> running transition for this key: a coalesced
  // second matching operation for the same key returns the existing record's
  // promise without ever reaching `startBuild`, and a
  // still-queued record only reaches here once, right when it actually
  // forks a worker. Emitted even if the fork below fails — a failed spawn
  // still attempted to start the build and immediately settles (emitting
  // 'idle' via `finalize`), so the pair is always balanced.
  setRecordBuildStatus(record, 'building');
  if (isVisibleQueueRecord(record)) emitQueueSnapshot();

  if (isSummaryRepairRequest(record.request)) {
    // Held total/background slots cover this bounded admission read too. A
    // confirmed publication can satisfy a queued repair without Engine.open.
    const watchdog = setTimeout(
      () =>
        rejectRecord(
          record,
          new CodeGraphWorkerBuildError(
            'timeout',
            'The summary repair admission timed out.',
          ),
        ),
      record.timeoutMs,
    );
    watchdog.unref?.();
    record.watchdog = watchdog;
    void readRepairProjection(record.key, record.request, record.metadata).then(
      (projection) => {
        if (record.settled || record.pendingRejection !== undefined) return;
        if (summaryRepairAttempts.get(record.key)?.canceled === true) {
          rejectRecord(
            record,
            new CodeGraphWorkerBuildError(
              'canceled',
              'The summary repair was canceled.',
            ),
          );
          return;
        }
        if (projection.state === 'ready') {
          resolveRecord(record, {
            ok: true,
            result: { state: 'ready', projection: projection.projection },
          });
        } else if (projection.state === 'pending') {
          if (record.watchdog !== undefined) clearTimeout(record.watchdog);
          forkBuild(record, executionTimeoutMs);
        } else {
          resolveRecord(record, {
            ok: false,
            message: 'The retained code-graph summary could not be verified.',
          });
        }
      },
      () =>
        rejectRecord(
          record,
          new CodeGraphWorkerBuildError(
            'worker-exit',
            'The retained code-graph summary could not be verified.',
          ),
        ),
    );
    return;
  }
  forkBuild(record, executionTimeoutMs);
}

function forkBuild(record: BuildRecord, executionTimeoutMs: number): void {
  let child: ExecutionHostProcess;
  try {
    // Repair cancellation retains the record and slots through actual exit.
    child = getExecutionHostPort().launch({
      entry: WORKER_ENTRY_FILENAME,
      serviceName: WORKER_SERVICE_NAME,
      budget: codeGraphHostBudget('build', {
        totalMemoryBytes: totalmem(),
      }),
    });
  } catch (error) {
    rejectRecord(
      record,
      new CodeGraphWorkerBuildError(
        'spawn-failed',
        `Failed to spawn code-graph build worker: ${errorMessage(error)}`,
      ),
    );
    return;
  }
  record.child = child;
  void registerActualWriterExit(record.key, child);
  // Core accounting counts the build until its worker exits, however it ends.
  getExecutionAccounting()
    .track('codeGraph', record.id)
    .releaseWhenSettled(
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      }),
    );
  // `ExecutionHostProcess.pid` stays undefined until Electron emits `spawn`, so the
  // priority is applied from that event. Background generation enters the
  // Darwin background band (lowest CPU priority and throttled disk I/O);
  // agent-requested builds and eager creation seeds have a waiting caller and
  // only lower their CPU priority.
  record.backgroundPolicy =
    record.priority !== 'agent' && !isEagerSeedRequest(record.request);
  child.once('spawn', () => {
    if (
      isRepairRequest(record.request) &&
      record.pendingRejection !== undefined
    ) {
      // Electron kill can fail before launch. Keep actual-exit ownership and
      // land the canceled repair's kill when spawn finally arrives.
      killChild(child);
      return;
    }
    if (typeof child.pid === 'number') {
      lowerSpawnedProcessPriority(child.pid, {
        background: record.backgroundPolicy,
      });
      record.backgroundPolicyApplied = record.backgroundPolicy;
    }
  });

  // Watchdog and event handlers are wired BEFORE the request is posted so a
  // worker that responds (or dies) synchronously can never race ahead of its
  // own handlers.
  const timeoutMs = isRepairRequest(record.request)
    ? Math.max(
        1,
        executionTimeoutMs - (Date.now() - (record.startedAt ?? Date.now())),
      )
    : executionTimeoutMs;
  const watchdog = setTimeout(() => {
    rejectRecordAfterChildExit(
      record,
      new CodeGraphWorkerBuildError(
        'timeout',
        `Code-graph build worker for "${record.key}" exceeded ${timeoutMs} ms and was killed.`,
      ),
    );
  }, timeoutMs);
  watchdog.unref?.();
  record.watchdog = watchdog;

  child.on('message', (message: unknown) => {
    if (
      record.pendingRejection !== undefined ||
      record.pendingResolution !== undefined
    ) {
      return;
    }
    if (record.draining) {
      // The derived completion (or anything else) ends the drain; the
      // caller already has its answer.
      if (!record.settled) finalize(record);
      return;
    }
    if (isWorkerResponse(message)) {
      if (isPublishedWithDerivedPending(message)) {
        beginDrain(record, message);
        return;
      }
      resolveRecord(record, message);
      return;
    }
    // rejectRecord kills the worker; a worker that speaks a broken protocol is
    // terminated rather than left running.
    rejectRecord(
      record,
      new CodeGraphWorkerBuildError(
        'malformed-response',
        `Code-graph build worker for "${record.key}" returned a malformed response.`,
      ),
    );
  });

  child.on('exit', (code: number) => {
    // Mark first so rejectRecord skips exit-wait registration — the child is
    // already gone; there is nothing left to wait for.
    record.childExited = true;
    if (
      record.pendingResolution !== undefined &&
      record.pendingRejection === undefined
    ) {
      resolveRecord(record, record.pendingResolution);
      return;
    }
    // A message-first exit finds the record already settled (no-op). Reaching
    // here while unsettled means the worker died before responding.
    rejectRecord(
      record,
      record.pendingRejection ??
        new CodeGraphWorkerBuildError(
          'worker-exit',
          `Code-graph build worker for "${record.key}" exited (code ${code}) before responding.`,
        ),
    );
  });

  try {
    child.postMessage(requestWithQueueWait(record));
  } catch (error) {
    // rejectRecord kills the worker we just spawned but could not hand work to.
    rejectRecord(
      record,
      new CodeGraphWorkerBuildError(
        'post-failed',
        `Failed to post request to code-graph build worker: ${errorMessage(error)}`,
      ),
    );
  }
}

/** Stamps the time a build waited in the queue into its timing prelude. */
function requestWithQueueWait(record: BuildRecord): CodeGraphWorkerRequest {
  const request = record.request;
  if (
    !isBuildWorkerRequest(request) ||
    request.timings === undefined ||
    record.startedAt === null
  ) {
    return request;
  }
  return {
    ...request,
    timings: {
      ...request.timings,
      queueWaitMs: Math.max(0, record.startedAt - record.queuedAt),
    },
  };
}

function resolveRecord(
  record: BuildRecord,
  response: CodeGraphWorkerResponse,
): void {
  if (record.settled) {
    return;
  }
  if (
    isRepairRequest(record.request) &&
    record.child !== undefined &&
    !record.childExited
  ) {
    // A terminal repair response does not release the owned writer lifecycle:
    // retain both slots/promise until observed worker exit, including close failures.
    if (record.pendingResolution !== undefined) return;
    record.pendingResolution = response;
    // Keep the execution watchdog armed: response-without-exit is not success.
    // Only the actual 'exit' handler below can complete this writer lifecycle.
    return;
  }
  record.completed = true;
  finalize(record);
  record.resolve(response);
}

function rejectRecord(
  record: BuildRecord,
  error: CodeGraphWorkerBuildError,
): void {
  if (record.settled) {
    return;
  }
  // Never release a running repair's total/background slots before its exit
  // fence. Only the actual exit handler can set childExited.
  if (record.child !== undefined && !record.childExited) {
    if (isRepairRequest(record.request)) {
      rejectRecordAfterChildExit(record, error);
      return;
    }
    void registerExitWait(record.key, record.child);
  }
  // A canceled/timed-out/malformed running build must have its worker killed;
  // resolveRecord's own success path lets the worker exit on its own.
  if (!record.childExited) killChild(record.child);
  finalize(record);
  record.reject(error);
}

function rejectRecordAfterChildExit(
  record: BuildRecord,
  error: CodeGraphWorkerBuildError,
): void {
  if (record.settled) return;
  if (record.pendingRejection !== undefined) {
    // The first explicit cancellation/availability decision is sticky, but
    // takes precedence over an earlier protocol/watchdog failure. Do not kill
    // twice or release the repair record/slots before observed writer exit.
    if (
      isRepairRequest(record.request) &&
      record.pendingRejection.reason !== 'canceled' &&
      record.pendingRejection.reason !== 'unavailable' &&
      (error.reason === 'canceled' || error.reason === 'unavailable')
    ) {
      record.pendingRejection = error;
    }
    return;
  }
  record.pendingRejection = error;
  if (record.watchdog !== undefined) {
    clearTimeout(record.watchdog);
    record.watchdog = undefined;
  }
  const child = record.child;
  if (child === undefined || record.childExited) {
    rejectRecord(record, error);
    return;
  }
  if (isRepairRequest(record.request)) {
    const actualExit = registerActualWriterExit(record.key, child);
    killChild(child);
    void actualExit.then(() =>
      rejectRecord(record, record.pendingRejection ?? error),
    );
    return;
  }
  const exitWait = registerExitWait(record.key, child);
  killChild(child);
  void exitWait.then(() => {
    if (record.settled) return;
    // Preserve legacy non-repair bounded finalization without claiming an
    // actual exit. unconfirmedWriterExits continues fencing every new repair.
    finalize(record);
    record.reject(error);
  });
}

// Idempotent bookkeeping shared by both terminal paths: clear the watchdog,
// drop the record from the in-flight map and the pending queue, free the
// concurrency slot if the build had started, then pump the queue. Callers
// resolve/reject AFTER this so a synchronous downstream reaction (e.g. issuing
// another build) sees consistent state.
function finalize(record: BuildRecord): void {
  record.settled = true;
  record.endDrain?.();
  if (record.watchdog !== undefined) {
    clearTimeout(record.watchdog);
    record.watchdog = undefined;
  }
  builds.delete(record.key);
  const queueIndex = queue.indexOf(record);
  if (queueIndex >= 0) {
    queue.splice(queueIndex, 1);
  }
  if (record.started) {
    if (isEagerSeedRequest(record.request)) {
      activeEagerSeedCount = Math.max(0, activeEagerSeedCount - 1);
    } else {
      activeBuildCount = Math.max(0, activeBuildCount - 1);
      if (record.priority !== 'agent') {
        activeBackgroundBuildCount = Math.max(
          0,
          activeBackgroundBuildCount - 1,
        );
        backgroundBuildReadyAt = Date.now() + backgroundBuildInterTaskDelayMs;
        if (record.completed) {
          if (isRepairRequest(record.request)) {
            backgroundCompletionsSinceSummaryRepair = 0;
          } else {
            backgroundCompletionsSinceSummaryRepair = Math.min(
              2,
              backgroundCompletionsSinceSummaryRepair + 1,
            );
          }
        }
      }
    }
  }
  // Single-flight (see `runCodeGraphWorkerBuild`) guarantees at most one
  // record per key at any time, so deleting `record.key` from `builds` and
  // `queue` above is exactly "no running build and nothing queued for this
  // key" — the precise not-running condition, whether this record ever
  // started (watchdog/error/worker-exit) or was canceled while still
  // queued. Emitted for every terminal path: resolveRecord and rejectRecord
  // both route through here. Emitted BEFORE `pumpQueue()` so this record's
  // own idle transition is always reported before any side effect of
  // freeing its concurrency slot (e.g. starting another key's queued build).
  setRecordBuildStatus(record, 'idle');
  if (isVisibleQueueRecord(record)) emitQueueSnapshot();
  pumpQueue();
}

function killChild(child: ExecutionHostProcess | undefined): void {
  if (child === undefined) {
    return;
  }
  try {
    child.kill();
  } catch {
    // The worker may already be gone; killing a dead process is harmless.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
