import type { WorkflowRunState } from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import {
  hasLiveWorkflowProcess,
  terminalWorkflowRunStatus,
  workflowRunStatus,
} from './workflow-run-inputs';
import type { WorkflowRunInputStatus } from './workflow-run-inputs';

export interface WorkflowRunCacheTarget {
  readonly runId: string;
  readonly transcriptDir: string;
  readonly taskId?: string;
  readonly toolUseId?: string;
}

export interface WorkflowRunCacheEntry {
  /** False until the first read settles (result, null, or definitive failure). */
  readonly loaded: boolean;
  readonly state: WorkflowRunState | null;
  /** True when the first read threw (definitive failure). */
  readonly failed: boolean;
  /** Derived with workflowRunStatus; undefined until loaded. */
  readonly status: WorkflowRunInputStatus | undefined;
}

export const WORKFLOW_RUN_POLL_INTERVAL_MS = 2_000;

const MAX_IN_FLIGHT_READS = 2;

const UNLOADED_ENTRY: WorkflowRunCacheEntry = Object.freeze({
  loaded: false,
  state: null,
  failed: false,
  status: undefined,
});

interface CacheRecord {
  readonly key: string;
  target: WorkflowRunCacheTarget;
  entry: WorkflowRunCacheEntry;
  consumers: number;
  timer: ReturnType<typeof setTimeout> | null;
  queued: boolean;
  reading: boolean;
}

const records = new Map<string, CacheRecord>();
const readQueue: string[] = [];
const listeners = new Set<() => void>();

let inFlightReads = 0;
let activeConsumerKeys = 0;
let cacheVersion = 0;
let cacheGeneration = 0;
let activityStoreUnsubscribe: (() => void) | null = null;

export function workflowRunCacheKey(
  target: Pick<WorkflowRunCacheTarget, 'runId' | 'transcriptDir'>,
): string {
  return `${target.transcriptDir}\u0000${target.runId}`;
}

/** Adds one consumer for a run; returns an idempotent release. */
export function acquireWorkflowRun(target: WorkflowRunCacheTarget): () => void {
  const key = workflowRunCacheKey(target);
  let record = records.get(key);
  if (record === undefined) {
    record = {
      key,
      target,
      entry: UNLOADED_ENTRY,
      consumers: 0,
      timer: null,
      queued: false,
      reading: false,
    };
    records.set(key, record);
  } else {
    record.target = {
      ...record.target,
      ...(target.taskId !== undefined ? { taskId: target.taskId } : {}),
      ...(target.toolUseId !== undefined
        ? { toolUseId: target.toolUseId }
        : {}),
    };
  }

  const wasInactive = record.consumers === 0;
  record.consumers += 1;
  if (wasInactive) {
    activeConsumerKeys += 1;
    ensureActivityStoreSubscription();
    refreshStatus(record);
    if (isNonTerminal(record)) enqueueRead(record);
  }

  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    if (record === undefined || record.consumers === 0) return;
    record.consumers -= 1;
    if (record.consumers > 0) return;

    activeConsumerKeys -= 1;
    clearPollTimer(record);
    removeQueuedRead(record);
    if (activeConsumerKeys === 0) unsubscribeFromActivityStore();
  };
}

/** Current entry or the shared unloaded value for an unknown run. */
export function getWorkflowRunEntry(
  target: Pick<WorkflowRunCacheTarget, 'runId' | 'transcriptDir'>,
): WorkflowRunCacheEntry {
  return records.get(workflowRunCacheKey(target))?.entry ?? UNLOADED_ENTRY;
}

/** Fires after any entry changes (new object). */
export function subscribeWorkflowRunCache(listener: () => void): () => void {
  listeners.add(listener);
  let subscribed = true;
  return (): void => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(listener);
  };
}

/** Monotonic counter bumped on every published change. */
export function getWorkflowRunCacheVersion(): number {
  return cacheVersion;
}

/** Clear module state between isolated unit tests. */
export function resetWorkflowRunCacheForTests(): void {
  cacheGeneration += 1;
  records.forEach((record): void => {
    clearPollTimer(record);
    record.consumers = 0;
    record.queued = false;
  });
  readQueue.length = 0;
  records.clear();
  listeners.clear();
  activeConsumerKeys = 0;
  cacheVersion = 0;
  unsubscribeFromActivityStore();
}

function ensureActivityStoreSubscription(): void {
  if (activityStoreUnsubscribe !== null) return;
  activityStoreUnsubscribe = useActivityStore.subscribe(
    (state, previous): void => {
      // Output, summaries and plans change this store often; only background
      // process changes can affect a run's liveness.
      if (state.bgProcesses === previous.bgProcesses) return;
      records.forEach((record): void => {
        if (record.consumers > 0 && record.entry.loaded) refreshStatus(record);
      });
    },
  );
}

function unsubscribeFromActivityStore(): void {
  activityStoreUnsubscribe?.();
  activityStoreUnsubscribe = null;
}

function isNonTerminal(record: CacheRecord): boolean {
  return terminalWorkflowRunStatus(record.entry.state?.status) === null;
}

function deriveStatus(record: CacheRecord): WorkflowRunInputStatus {
  const processes = Object.values(
    useActivityStore.getState().bgProcesses,
  ).flat();
  return workflowRunStatus(record.entry.state, {
    liveProcess: hasLiveWorkflowProcess(processes, record.target),
    now: Date.now(),
  });
}

function refreshStatus(record: CacheRecord): void {
  if (!record.entry.loaded) return;
  const status = deriveStatus(record);
  if (status !== record.entry.status) {
    publishEntry(record, {
      ...record.entry,
      status,
    });
  }
  syncPollTimer(record);
}

function publishEntry(record: CacheRecord, entry: WorkflowRunCacheEntry): void {
  record.entry = entry;
  cacheVersion += 1;
  listeners.forEach((listener): void => listener());
}

function schedulePoll(record: CacheRecord): void {
  if (record.timer !== null) return;
  record.timer = setTimeout((): void => {
    record.timer = null;
    pollRecord(record);
  }, WORKFLOW_RUN_POLL_INTERVAL_MS);
}

function clearPollTimer(record: CacheRecord): void {
  if (record.timer === null) return;
  clearTimeout(record.timer);
  record.timer = null;
}

function syncPollTimer(record: CacheRecord): void {
  if (
    record.consumers > 0 &&
    record.entry.loaded &&
    record.entry.status === 'running' &&
    isNonTerminal(record)
  ) {
    schedulePoll(record);
  } else {
    clearPollTimer(record);
  }
}

function pollRecord(record: CacheRecord): void {
  if (record.consumers === 0 || !record.entry.loaded) return;
  const status = deriveStatus(record);
  if (status !== record.entry.status) {
    publishEntry(record, {
      ...record.entry,
      status,
    });
  }
  if (status === 'running' && isNonTerminal(record)) {
    enqueueRead(record);
  } else {
    clearPollTimer(record);
  }
}

function enqueueRead(record: CacheRecord): void {
  if (
    record.consumers === 0 ||
    record.reading ||
    record.queued ||
    !isNonTerminal(record)
  ) {
    return;
  }
  if (inFlightReads >= MAX_IN_FLIGHT_READS || readQueue.length > 0) {
    record.queued = true;
    readQueue.push(record.key);
    pumpReadQueue();
    return;
  }
  startRead(record);
}

function pumpReadQueue(): void {
  while (inFlightReads < MAX_IN_FLIGHT_READS && readQueue.length > 0) {
    const key = readQueue.shift();
    if (key === undefined) return;
    const record = records.get(key);
    if (record === undefined) continue;
    record.queued = false;
    if (record.consumers > 0 && !record.reading && isNonTerminal(record)) {
      startRead(record);
    }
  }
}

function startRead(record: CacheRecord): void {
  if (record.consumers === 0 || record.reading || !isNonTerminal(record))
    return;
  record.reading = true;
  inFlightReads += 1;
  const generation = cacheGeneration;
  let read: Promise<WorkflowRunState | null>;
  try {
    read = window.api.activity.readWorkflowRun({
      transcriptDir: record.target.transcriptDir,
      runId: record.target.runId,
    });
  } catch {
    handleReadFailure(record, generation);
    finishRead(record, generation);
    return;
  }

  void read
    .then((state): void => {
      if (
        generation === cacheGeneration &&
        records.get(record.key) === record
      ) {
        handleReadResult(record, state);
      }
    })
    .catch((): void => {
      if (
        generation === cacheGeneration &&
        records.get(record.key) === record
      ) {
        handleReadFailure(record, generation);
      }
    })
    .finally((): void => {
      finishRead(record, generation);
    });
}

function handleReadResult(
  record: CacheRecord,
  state: WorkflowRunState | null,
): void {
  const previousEntry = record.entry;
  const nextState = state ?? previousEntry.state;
  const status = workflowRunStatus(nextState, {
    liveProcess: hasLiveCurrentProcess(record.target),
    now: Date.now(),
  });
  const nextEntry: WorkflowRunCacheEntry = {
    loaded: true,
    state: nextState,
    failed: previousEntry.failed,
    status,
  };
  const stateChanged =
    JSON.stringify(nextState) !== JSON.stringify(previousEntry.state);
  if (
    !previousEntry.loaded ||
    stateChanged ||
    status !== previousEntry.status
  ) {
    publishEntry(record, nextEntry);
  }
}

function handleReadFailure(record: CacheRecord, generation: number): void {
  if (generation !== cacheGeneration || record.entry.loaded) return;
  const status = workflowRunStatus(null, {
    liveProcess: hasLiveCurrentProcess(record.target),
    now: Date.now(),
  });
  publishEntry(record, {
    loaded: true,
    state: null,
    failed: true,
    status,
  });
}

function hasLiveCurrentProcess(target: WorkflowRunCacheTarget): boolean {
  const processes = Object.values(
    useActivityStore.getState().bgProcesses,
  ).flat();
  return hasLiveWorkflowProcess(processes, target);
}

function finishRead(record: CacheRecord, generation: number): void {
  inFlightReads -= 1;
  if (generation !== cacheGeneration) {
    pumpReadQueue();
    return;
  }
  record.reading = false;
  pumpReadQueue();
  if (records.get(record.key) === record) syncPollTimer(record);
}

function removeQueuedRead(record: CacheRecord): void {
  if (!record.queued) return;
  record.queued = false;
  const queueIndex = readQueue.indexOf(record.key);
  if (queueIndex >= 0) readQueue.splice(queueIndex, 1);
  pumpReadQueue();
}
