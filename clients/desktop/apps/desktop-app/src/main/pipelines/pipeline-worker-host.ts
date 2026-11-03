import {
  PipelineDrainTimeoutError,
  pipelineExecutionNotFoundError,
  pipelineLaunchUnavailableError,
  pipelineStartFailedError,
  type PipelineExecutionObserver,
  type PipelineExecutionWorker,
} from '@canopy/core-runtime/node/pipeline';
import {
  WORKER_PIPELINE_ERROR_MAX_LENGTH,
  type WorkerPipelineExecution,
} from '@canopy/protocol/canopy-core';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  cancelPipelineExecution,
  executePipeline,
  loadExecutionState,
  type ExecutionHandle,
  type ExecutionOptions,
} from '@canopy/desktop-shared/node/pipelines/executor';
import { requestExecutionCancellation } from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import type { ExecutionRuntime } from '@canopy/desktop-shared/node/pipelines/executor/types';
import type {
  ExecutionState,
  Pipeline,
} from '@canopy/desktop-shared/types/pipeline';
import { getActiveExecutionHandle } from './pipeline-execution-registry';

/*
 * The desktop's local pipeline worker (CAN-4140): `worker.pipeline.execution.*`
 * over the existing Electron execution runtime. Core's start path resolves,
 * authorizes and admits a run, stages its launch here, then dispatches the
 * start through the local worker. The launch keeps what the executor needs
 * that is not portable yet (environment, secrets, packages, observers); the
 * daemon route replaces it (CAN-5086).
 */

/** What core prepared for one execution: the admitted snapshot and options. */
export interface PipelineLaunch {
  readonly pipeline: Pipeline;
  readonly options: ExecutionOptions;
}

/** Host-side results of a dispatched request, for the legacy callers. */
interface HostCapture {
  handle?: ExecutionHandle;
  state?: ExecutionState;
  error?: unknown;
}

/** A settled cancel, numbered so a caller reads only one it waited for. */
interface CancelCapture extends HostCapture {
  readonly sequence: number;
}

/**
 * Subscribers of each execution. They outlive one executor handle: a resume
 * runs on a new handle, which `attachPipelineHandle` joins them to, and a
 * durable cancel of a paused execution, which no handle reports, reaches
 * them from the cancel.
 */
interface Subscriber {
  readonly observer: PipelineExecutionObserver;
  readonly handles: Map<ExecutionHandle, () => void>;
}
const subscribers = new Map<string, Set<Subscriber>>();

function attachSubscriber(
  subscriber: Subscriber,
  handle: ExecutionHandle,
): void {
  if (subscriber.handles.has(handle) || !handle.addObservers) return;
  const { observer } = subscriber;
  subscriber.handles.set(
    handle,
    // A handle also carries its nested runs' events; those are theirs.
    handle.addObservers({
      onEvent: (event) => {
        if (event.executionId !== handle.id) return;
        observer.onExecution(event.type, projectPipelineExecution(event.state));
      },
      onStepOutput: (event) => {
        if (event.executionId !== handle.id) return;
        observer.onOutput({
          jobId: event.jobId,
          stepId: event.stepId,
          stream: event.stream,
          text: event.data,
        });
      },
    }),
  );
}

/** Handles whose nested runs' events reach those runs' subscribers. */
const routed = new WeakSet<ExecutionHandle>();

/** Subscribers of a nested run that no handle of its own reports to. */
function nestedSubscribers(executionId: string): Subscriber[] {
  return Array.from(subscribers.get(executionId) ?? []).filter((subscriber) =>
    Array.from(subscriber.handles.keys()).every(
      (own) => own.id !== executionId,
    ),
  );
}

/**
 * A nested run starts inside its parent's step, with no handle here; its
 * events arrive on the parent's handle, so deliver them to its own
 * subscribers.
 */
function routeNestedRuns(handle: ExecutionHandle): void {
  if (routed.has(handle) || !handle.addObservers) return;
  routed.add(handle);
  handle.addObservers({
    onEvent: (event) => {
      if (event.executionId === handle.id) return;
      for (const { observer } of nestedSubscribers(event.executionId))
        observer.onExecution(event.type, projectPipelineExecution(event.state));
    },
    onStepOutput: (event) => {
      if (event.executionId === handle.id) return;
      for (const { observer } of nestedSubscribers(event.executionId))
        observer.onOutput({
          jobId: event.jobId,
          stepId: event.stepId,
          stream: event.stream,
          text: event.data,
        });
    },
  });
}

/** Join an execution's subscribers to a handle that runs it, such as a resume's. */
export function attachPipelineHandle(handle: ExecutionHandle): void {
  routeNestedRuns(handle);
  for (const subscriber of Array.from(subscribers.get(handle.id) ?? []))
    attachSubscriber(subscriber, handle);
}

let broadcastCancel: (state: ExecutionState) => void = () => undefined;

/**
 * How a settled cancel reaches the desktop's windows and watchers. Every
 * cancel goes through this worker, whichever client sent it, so the
 * broadcast happens here, once per cancel.
 */
export function setPipelineCancelBroadcast(
  broadcast: (state: ExecutionState) => void,
): void {
  broadcastCancel = broadcast;
}

function notifySubscribers(executionId: string, state: ExecutionState): void {
  const listening = Array.from(subscribers.get(executionId) ?? []);
  if (listening.length === 0 || !TERMINAL_STATUSES.has(state.status)) return;
  // A notification's failure never fails the cancel.
  try {
    const execution = projectPipelineExecution(state);
    for (const { observer } of listening)
      observer.onExecution('execution.cancelled', execution);
  } catch {
    return;
  }
}

const launches = new Map<string, PipelineLaunch>();
const captures = new Map<string, HostCapture>();
/** Cancels in flight; a concurrent cancel of the same execution joins one. */
const cancelling = new Map<
  string,
  { readonly sequence: number; readonly capture: Promise<CancelCapture> }
>();
/** The latest settled cancel of each execution, the oldest dropped first. */
const cancelled = new Map<string, CancelCapture>();
const CANCEL_CAPTURES_MAX = 256;
let cancelSequence = 0;
/**
 * Handles this worker started, until they settle. The start path registers
 * a handle in the active registry only after the start returns, and core
 * watches the run from the start's reply.
 */
const started = new Map<string, ExecutionHandle>();

function liveHandle(executionId: string): ExecutionHandle | undefined {
  return getActiveExecutionHandle(executionId) ?? started.get(executionId);
}

/**
 * Stage a launch for the next start of `executionId`. The worker takes it
 * once; `take` returns what that start produced and forgets the launch.
 */
export function stagePipelineLaunch(
  executionId: string,
  launch: PipelineLaunch,
): { take(): HostCapture } {
  launches.set(executionId, launch);
  captures.delete(executionId);
  return {
    take: (): HostCapture => {
      launches.delete(executionId);
      const capture = captures.get(executionId) ?? {};
      captures.delete(executionId);
      return capture;
    },
  };
}

/**
 * A mark to pass to {@link readPipelineCancelCapture} before cancelling
 * `executionId`; a cancel already in flight, which this one will join, counts.
 */
export function pipelineCancelMark(executionId: string): number {
  const inFlight = cancelling.get(executionId);
  return inFlight === undefined ? cancelSequence : inFlight.sequence - 1;
}

/**
 * The full state and original error of the latest cancel of `executionId`
 * that started after `mark`. Every caller that joined that cancel reads it.
 */
export function readPipelineCancelCapture(
  executionId: string,
  mark: number,
): HostCapture {
  const capture = cancelled.get(executionId);
  return capture !== undefined && capture.sequence > mark ? capture : {};
}

function runCancel(executionId: string): Promise<CancelCapture> {
  const existing = cancelling.get(executionId);
  if (existing) return existing.capture;
  cancelSequence += 1;
  const sequence = cancelSequence;
  const pending = cancelExecution(executionId).then(
    (state): CancelCapture => ({ sequence, state }),
    (error: unknown): CancelCapture => ({ sequence, error }),
  );
  const settled = pending.then((capture) => {
    cancelling.delete(executionId);
    cancelled.delete(executionId);
    cancelled.set(executionId, capture);
    if (capture.state) {
      notifySubscribers(executionId, capture.state);
      try {
        broadcastCancel(capture.state);
      } catch {
        // A broadcast failure never fails the cancel.
      }
    }
    for (const key of Array.from(cancelled.keys())) {
      if (cancelled.size <= CANCEL_CAPTURES_MAX) break;
      cancelled.delete(key);
    }
    return capture;
  });
  cancelling.set(executionId, { sequence, capture: settled });
  return settled;
}

const TERMINAL_STATUSES: ReadonlySet<ExecutionState['status']> = new Set<
  ExecutionState['status']
>(['success', 'failure', 'cancelled']);

/** Where a run's definition came from, by its preference locator. */
export function definitionSourceOf(
  locator: ExecutionState['pipeline_preference_locator'],
): WorkerPipelineExecution['definitionSource'] {
  if (locator === undefined) return 'inline';
  if (locator.type === 'stored') return locator.source;
  return locator.type === 'shared' ? 'shared' : 'project';
}

export function projectPipelineExecution(
  state: ExecutionState,
): WorkerPipelineExecution {
  const locator = state.pipeline_preference_locator;
  const owner = state.execution_context;
  return {
    executionId: state.id,
    pipelineId: state.pipeline_id,
    name: state.pipeline_snapshot.name.slice(0, 512),
    status: state.status,
    runScope:
      state.scope ??
      (state.worktree_id !== undefined ? 'worktree' : 'directory'),
    definitionSource: definitionSourceOf(locator),
    owner:
      owner !== undefined && parseWorkspaceContext(owner) !== null
        ? owner
        : null,
    workspaceId: state.project_id ?? null,
    worktreeId: state.worktree_id ?? null,
    parentExecutionId: state.parent_execution_id ?? null,
    startedAt: new Date(state.started_at).toISOString(),
    completedAt:
      state.completed_at === undefined
        ? null
        : new Date(state.completed_at).toISOString(),
    pendingPauseCount: state.pending_pauses.length,
    error:
      state.error === undefined
        ? null
        : state.error.slice(0, WORKER_PIPELINE_ERROR_MAX_LENGTH),
  };
}

/*
 * The execution runtime, resource monitor and Ledger load on first use: the
 * pipeline handlers import this module through the dispatch path, and the
 * runtime's module graph is large.
 */
async function monitoredRuntime(): Promise<ExecutionOptions['runtime']> {
  const [{ createElectronExecutionRuntime }, { getResourceMonitorService }] =
    await Promise.all([
      import('./execution-runtime'),
      import('../resource-monitor'),
    ]);
  const runtime = createElectronExecutionRuntime();
  runtime.resourceMonitor = getResourceMonitorService();
  return runtime;
}

export function nestedPipelineExecutionIds(state: ExecutionState): string[] {
  const ids = new Set<string>();
  for (const job of Object.values(state.jobs)) {
    for (const step of Object.values(job.steps)) {
      if (step.child_execution_id) ids.add(step.child_execution_id);
    }
  }
  for (const reason of state.status_reasons) {
    if (reason.source.child_execution_id) {
      ids.add(reason.source.child_execution_id);
    }
  }
  return Array.from(ids);
}

/** How long a drain waits for a live run's processes to stop. */
const DRAIN_TIMEOUT_MS = 10_000;

function withinDrainWindow<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new PipelineDrainTimeoutError()),
      DRAIN_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Archive teardown's cancel: stop the execution's live processes and wait
 * for them, never writing a terminal state itself. `null` when the
 * execution is gone.
 */
export async function drainPipelineExecution(
  executionId: string,
  runtime: ExecutionRuntime,
): Promise<ExecutionState | null> {
  const handle = getActiveExecutionHandle(executionId);
  if (handle) {
    await requestExecutionCancellation(executionId, runtime.executionsDir);
    // The handle resolves only after the executor has aborted and awaited
    // its child processes. If this bounded wait expires, leave both the
    // durable cancellation marker and running state intact: the still-live
    // handle owns eventual settlement, and a later archive retry must not
    // mistake a force-written terminal snapshot for a completed drain.
    return withinDrainWindow(handle.cancel());
  }
  // Nested pipeline executions do not have renderer registry handles, and a
  // just-settled execution may lose its handle after the summary scan.
  // Re-read first so that race is already drained; otherwise use the
  // executor's durable cancellation path, which polls the marker before
  // applying its bounded recovered-execution fallback.
  const current = await loadExecutionState(executionId, runtime.executionsDir);
  if (!current || TERMINAL_STATUSES.has(current.status)) return current;
  return cancelPipelineExecution(executionId, runtime, {
    allowRecoveredFallback: false,
  });
}

/**
 * Cancel one execution as the desktop always has: retire its paused agents
 * as Ledger owners first, ask a live handle to stop, then take the durable
 * cancellation path, which force-finalizes a wedged run after its bounded
 * cooperative window.
 */
async function cancelExecution(executionId: string): Promise<ExecutionState> {
  const runtime = await monitoredRuntime();
  const { retireLedgerPipelineExecutionTree } =
    await import('../ledger/pipeline-agent-owners');
  await retireLedgerPipelineExecutionTree(executionId, async (id) => {
    const state = await loadExecutionState(id, runtime.executionsDir);
    return state === null ? [] : nestedPipelineExecutionIds(state);
  });
  const active = getActiveExecutionHandle(executionId);
  if (active) void active.cancel().catch(() => undefined);
  return cancelPipelineExecution(executionId, runtime);
}

export const desktopPipelineWorker: PipelineExecutionWorker = {
  async start(params, signal) {
    const launch = launches.get(params.executionId);
    if (!launch) throw pipelineLaunchUnavailableError();
    launches.delete(params.executionId);
    const capture: HostCapture = {};
    captures.set(params.executionId, capture);
    let handle: ExecutionHandle;
    try {
      handle = await executePipeline(launch.pipeline, launch.options);
    } catch (error) {
      capture.error = error;
      throw pipelineStartFailedError(error);
    }
    capture.handle = handle;
    attachPipelineHandle(handle);
    // Core cancelled the start while the executor was starting it.
    if (signal.aborted) void handle.cancel().catch(() => undefined);
    const state = handle.getState();
    if (!TERMINAL_STATUSES.has(state.status) && handle.addObservers) {
      started.set(params.executionId, handle);
      // A paused or ended run is read from the store, not this handle.
      const release = handle.addObservers({
        onEvent: (event) => {
          if (event.state.status === 'running') return;
          release();
          if (started.get(params.executionId) === handle)
            started.delete(params.executionId);
        },
      });
    }
    return projectPipelineExecution(state);
  },
  async get(executionId) {
    const stored = await loadExecutionState(
      executionId,
      (await monitoredRuntime()).executionsDir,
    );
    // A forced cancel persists a terminal state while the handle still runs.
    const state =
      stored && TERMINAL_STATUSES.has(stored.status)
        ? stored
        : (liveHandle(executionId)?.getState() ?? stored);
    return state === null ? null : projectPipelineExecution(state);
  },
  async cancel(executionId, mode) {
    if (mode === 'drain') {
      const drained = await drainPipelineExecution(
        executionId,
        await monitoredRuntime(),
      );
      if (!drained) throw pipelineExecutionNotFoundError();
      return projectPipelineExecution(drained);
    }
    const capture = await runCancel(executionId);
    if (capture.state) return projectPipelineExecution(capture.state);
    const { error } = capture;
    if (
      error instanceof Error &&
      error.message === `Execution "${executionId}" not found`
    )
      throw pipelineExecutionNotFoundError();
    throw error instanceof Error
      ? error
      : new Error('The workflow run could not be cancelled.');
  },
  observe(executionId, observer: PipelineExecutionObserver) {
    const subscriber: Subscriber = { observer, handles: new Map() };
    const set = subscribers.get(executionId) ?? new Set<Subscriber>();
    set.add(subscriber);
    subscribers.set(executionId, set);
    const handle = liveHandle(executionId);
    if (handle) attachSubscriber(subscriber, handle);
    return (): void => {
      for (const detach of Array.from(subscriber.handles.values())) detach();
      subscriber.handles.clear();
      set.delete(subscriber);
      if (set.size === 0 && subscribers.get(executionId) === set)
        subscribers.delete(executionId);
    };
  },
};
