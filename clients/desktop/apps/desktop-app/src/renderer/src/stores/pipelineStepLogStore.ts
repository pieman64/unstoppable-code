import type {
  IPCResult,
  StepLogLocator,
  StepLogReadResult,
  StepOutputEvent,
} from '@canopy/desktop-shared/types/pipeline';
import {
  applyStepLogOutputEvent,
  getReconciledStepLogLines,
  reconcileStepLogSnapshot,
  type ReconciledStepLog,
  type StepLogIdentity,
  type StepLogSnapshot,
} from '../lib/pipelineRunOutput';

/**
 * Renderer-wide step log interests: the only place live pipeline step output
 * is kept.
 *
 * Output is retained only for a registered interest, keyed by the complete
 * physical log identity (execution, physical job, nested step path, attempt,
 * iteration, recovery) plus its source file. Output for anything else is
 * dropped on arrival. Each interest implements the caller protocol documented
 * above `reconcileStepLogSnapshot` in `lib/pipelineRunOutput.ts`:
 *
 * 1. Buffer from registration, before the snapshot read.
 * 2. Join the snapshot with the buffer; keep the buffer only while stale.
 * 3. Apply later events directly.
 * 4. Re-read (one in flight plus a dirty marker) while stale.
 * 5. Re-read once to upgrade a heuristic log that saw positioned output.
 * 6. Re-read once whenever the step's terminal state changes.
 * 7. On a byte overflow, drop the buffer and re-read authoritatively.
 *
 * Aggregated parent logs (composite and nested-pipeline steps) are the one
 * place live output is not recoverable from the log itself: the parent's own
 * file holds only its `[run]`/`[skip]` lines, and its nested steps' output
 * reaches it only as live descendant events. Each interest therefore keeps
 * the descendant events it has seen (byte-bounded, newest kept) and joins
 * them into every re-read, where the textual merge drops any the parent file
 * already contains.
 *
 * Views are published per interest (`subscribeStepLog` +
 * `getStepLogView`), so one log's output never re-renders another consumer.
 * Releasing the last holder discards the interest and its buffer.
 */

/** Live output one interest may hold while waiting for a snapshot. */
export const STEP_LOG_PENDING_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Unpositioned output a heuristic log may accumulate on top of its snapshot
 * before it is folded into a fresh authoritative read.
 */
export const STEP_LOG_HEURISTIC_LIVE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Descendant output one aggregated parent log retains across re-reads. Past
 * it the oldest output is dropped (down to three quarters) and the log is
 * rebuilt from a fresh read, so the view stays bounded too.
 */
export const STEP_LOG_DESCENDANT_MAX_BYTES = 4 * 1024 * 1024;

export interface StepLogView {
  /** `loading` until the first snapshot read settles. */
  status: 'loading' | 'ready';
  lines: string[];
}

export interface StepLogInterestRequest {
  identity: StepLogIdentity;
  /** Persisted source; omitted derives the step's default log path. */
  logFilePath?: string;
  /** Whether the step has settled. A change triggers one re-read. */
  terminal: boolean;
  /**
   * False for a source that live output does not describe (a separate
   * transcript file). It then only follows snapshot reads.
   */
  acceptsLiveOutput?: boolean;
}

export interface StepLogInterest {
  readonly key: string;
  setTerminal: (terminal: boolean) => void;
  /** Idempotent. */
  release: () => void;
}

/** One observed event, ordered by arrival within its interest. */
interface SequencedOutput {
  seq: number;
  event: StepOutputEvent;
  bytes: number;
}

interface StepLogEntry {
  readonly key: string;
  readonly identity: StepLogIdentity;
  readonly locator: StepLogLocator;
  readonly acceptsLiveOutput: boolean;
  refCount: number;
  terminal: boolean;
  log: ReconciledStepLog | null;
  nextSeq: number;
  /** Events awaiting a join with the next snapshot. */
  pending: SequencedOutput[];
  pendingBytes: number;
  /** Descendant (nested-step) events retained across re-reads. */
  descendants: SequencedOutput[];
  descendantBytes: number;
  /** The step's own output applied to a heuristic log since its snapshot. */
  heuristicLiveBytes: number;
  /** Pending output was dropped while the current read was in flight. */
  overflowed: boolean;
  readInFlight: boolean;
  rereadRequested: boolean;
  /** Invalidates a read's late response after a reset or release. */
  readToken: number;
  upgradeAttempted: boolean;
  /** The last read failed; wait for a terminal change before retrying. */
  readFailed: boolean;
  publishedLog: ReconciledStepLog | null;
  view: StepLogView;
  released: boolean;
}

const LOADING_VIEW: StepLogView = Object.freeze({
  status: 'loading',
  lines: [],
});

const EMPTY_SNAPSHOT: StepLogSnapshot = { lines: [] };

const entriesByKey = new Map<string, StepLogEntry>();
const entriesByExecution = new Map<string, Set<StepLogEntry>>();
const listenersByKey = new Map<string, Set<() => void>>();

function normalizeIdentity(identity: StepLogIdentity): StepLogIdentity {
  return {
    executionId: identity.executionId,
    jobId: identity.jobId,
    stepId: identity.stepId,
    attempt: identity.attempt,
    iteration: identity.iteration ?? 1,
    recovery: identity.recovery ?? 0,
  };
}

/** Interest key: the physical log identity plus its source. */
export function stepLogInterestKey(request: StepLogInterestRequest): string {
  const identity = normalizeIdentity(request.identity);
  return [
    identity.executionId,
    identity.jobId,
    identity.stepId,
    String(identity.attempt),
    String(identity.iteration),
    String(identity.recovery),
    request.logFilePath ?? '',
    request.acceptsLiveOutput === false ? 'snapshot' : 'live',
  ].join('\0');
}

function estimateUtf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function eventBytes(event: StepOutputEvent): number {
  return event.logPosition?.byteLength ?? estimateUtf8Bytes(event.data);
}

/**
 * The event belongs to this log: the same physical job and attempt stream,
 * and the step itself or (for heuristic, aggregated parent logs) one of its
 * nested steps.
 */
function eventTargetsEntry(
  event: StepOutputEvent,
  identity: StepLogIdentity,
): boolean {
  return (
    event.executionId === identity.executionId &&
    event.jobId === identity.jobId &&
    event.attempt === identity.attempt &&
    (event.iteration ?? 1) === identity.iteration &&
    (event.recovery ?? 0) === identity.recovery &&
    (event.stepId === identity.stepId ||
      event.stepId.startsWith(`${identity.stepId}/`))
  );
}

function isStale(log: ReconciledStepLog | null): boolean {
  return log?.mode === 'positioned' && log.stale;
}

function isDescendantEvent(
  event: StepOutputEvent,
  identity: StepLogIdentity,
): boolean {
  return event.stepId !== identity.stepId;
}

/**
 * The events to join with a new snapshot: retained descendant output plus
 * everything buffered for this read, in arrival order, each once.
 */
function eventsForJoin(entry: StepLogEntry): StepOutputEvent[] {
  const events: StepOutputEvent[] = [];
  let descendantIndex = 0;
  let pendingIndex = 0;
  let lastSeq = -1;
  while (
    descendantIndex < entry.descendants.length ||
    pendingIndex < entry.pending.length
  ) {
    const descendant = entry.descendants[descendantIndex];
    const pending = entry.pending[pendingIndex];
    const next =
      pending === undefined ||
      (descendant !== undefined && descendant.seq <= pending.seq)
        ? descendant
        : pending;
    if (next === descendant) descendantIndex += 1;
    else pendingIndex += 1;
    if (next.seq !== lastSeq) {
      events.push(next.event);
      lastSeq = next.seq;
    }
  }
  return events;
}

function ownPendingBytes(entry: StepLogEntry): number {
  let bytes = 0;
  for (const output of entry.pending) {
    if (!isDescendantEvent(output.event, entry.identity)) {
      bytes += output.bytes;
    }
  }
  return bytes;
}

/**
 * Retains one descendant event. Returns true when older output was dropped,
 * so the joined log must be rebuilt from a fresh read to shed it.
 */
function retainDescendant(
  entry: StepLogEntry,
  output: SequencedOutput,
): boolean {
  entry.descendants.push(output);
  entry.descendantBytes += output.bytes;
  if (entry.descendantBytes <= STEP_LOG_DESCENDANT_MAX_BYTES) {
    return false;
  }
  const target = Math.floor((STEP_LOG_DESCENDANT_MAX_BYTES * 3) / 4);
  let dropCount = 0;
  while (
    entry.descendantBytes > target &&
    dropCount < entry.descendants.length - 1
  ) {
    entry.descendantBytes -= entry.descendants[dropCount].bytes;
    dropCount += 1;
  }
  entry.descendants = entry.descendants.slice(dropCount);
  return true;
}

function publish(entry: StepLogEntry): void {
  if (entry.released) return;
  if (entry.log === null || entry.log === entry.publishedLog) return;
  entry.publishedLog = entry.log;
  entry.view = {
    status: 'ready',
    lines: getReconciledStepLogLines(entry.log),
  };
  const listeners = listenersByKey.get(entry.key);
  if (!listeners) return;
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

function requestRead(entry: StepLogEntry): void {
  if (entry.released) return;
  if (entry.readInFlight) {
    entry.rereadRequested = true;
    return;
  }
  startRead(entry);
}

function startRead(entry: StepLogEntry): void {
  entry.readInFlight = true;
  entry.rereadRequested = false;
  entry.overflowed = false;
  entry.readFailed = false;
  entry.readToken += 1;
  const token = entry.readToken;
  let request: Promise<IPCResult<StepLogReadResult> | undefined>;
  try {
    request = Promise.resolve(
      window.pipelines.readStepLog(entry.locator, { format: 'text' }),
    );
  } catch (error: unknown) {
    request = Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  void request.then(
    (result) => {
      finishRead(
        entry,
        token,
        result?.success && result.data ? result.data : null,
      );
    },
    () => {
      finishRead(entry, token, null);
    },
  );
}

function finishRead(
  entry: StepLogEntry,
  token: number,
  snapshot: StepLogSnapshot | null,
): void {
  if (entry.released || token !== entry.readToken) return;
  entry.readInFlight = false;

  if (entry.overflowed) {
    // Output was dropped while this read was in flight, so its join would be
    // incomplete. Read again; the buffer holds everything since the drop.
    startRead(entry);
    return;
  }

  if (snapshot === null && entry.log !== null) {
    // A failed re-read keeps the log it already had. Retry only on the next
    // terminal change instead of on every later output event.
    entry.readFailed = true;
    if (entry.rereadRequested) startRead(entry);
    return;
  }

  const next = reconcileStepLogSnapshot(
    snapshot ?? EMPTY_SNAPSHOT,
    eventsForJoin(entry),
    entry.identity,
    entry.log ?? undefined,
  );
  entry.readFailed = snapshot === null;
  entry.heuristicLiveBytes =
    next.mode === 'heuristic' ? ownPendingBytes(entry) : 0;
  if (!isStale(next)) {
    entry.pending = [];
    entry.pendingBytes = 0;
  }
  entry.log = next;

  if (isStale(next)) {
    requestRead(entry);
  } else if (
    next.mode === 'heuristic' &&
    next.upgradeAvailable &&
    !entry.upgradeAttempted
  ) {
    entry.upgradeAttempted = true;
    requestRead(entry);
  } else if (entry.rereadRequested) {
    startRead(entry);
  }
  publish(entry);
}

function bufferEvent(entry: StepLogEntry, output: SequencedOutput): void {
  if (entry.pendingBytes + output.bytes <= STEP_LOG_PENDING_MAX_BYTES) {
    entry.pending.push(output);
    entry.pendingBytes += output.bytes;
    return;
  }
  // Too much output to hold for a join: drop it and recover from the
  // persisted log, which is the authority.
  entry.pending = [];
  entry.pendingBytes = 0;
  if (entry.readInFlight) {
    entry.overflowed = true;
    return;
  }
  startRead(entry);
}

/** Applies one event; returns true when the visible log changed. */
function applyEvent(entry: StepLogEntry, event: StepOutputEvent): boolean {
  if (!entry.acceptsLiveOutput || !eventTargetsEntry(event, entry.identity)) {
    return false;
  }
  const output: SequencedOutput = {
    seq: entry.nextSeq,
    event,
    bytes: eventBytes(event),
  };
  entry.nextSeq += 1;
  const descendant = isDescendantEvent(event, entry.identity);
  const trimmedDescendants = descendant && retainDescendant(entry, output);
  let changed = false;
  if (entry.log !== null) {
    const next = applyStepLogOutputEvent(entry.log, event, entry.identity);
    if (next !== entry.log) {
      if (next.mode === 'heuristic' && !descendant) {
        entry.heuristicLiveBytes += output.bytes;
      }
      entry.log = next;
      changed = true;
    }
  }
  const stale = isStale(entry.log);
  if (entry.readInFlight || entry.log === null || stale) {
    bufferEvent(entry, output);
  }
  if (!entry.readInFlight && !entry.readFailed) {
    if (stale) {
      startRead(entry);
    } else if (
      entry.log?.mode === 'heuristic' &&
      (entry.heuristicLiveBytes > STEP_LOG_HEURISTIC_LIVE_MAX_BYTES ||
        trimmedDescendants)
    ) {
      // Fold a long unpositioned stream into a fresh snapshot instead of
      // growing an in-memory overlay without bound. Retained descendant
      // output is joined back in; only output past the descendant bound
      // (the oldest) is shed.
      startRead(entry);
    }
  }
  return changed;
}

/** True when some interest wants output of this execution. */
export function hasStepLogInterestForExecution(executionId: string): boolean {
  return entriesByExecution.has(executionId);
}

/**
 * Routes one frame's batch of output events to their interests and publishes
 * each changed log once.
 */
export function routeStepOutputEvents(
  events: readonly StepOutputEvent[],
): void {
  const changed = new Set<StepLogEntry>();
  for (const event of events) {
    const entries = entriesByExecution.get(event.executionId);
    if (!entries) continue;
    entries.forEach((entry) => {
      if (applyEvent(entry, event)) {
        changed.add(entry);
      }
    });
  }
  changed.forEach(publish);
}

function releaseEntry(entry: StepLogEntry): void {
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entry.released = true;
  entry.readToken += 1;
  entry.pending = [];
  entry.pendingBytes = 0;
  entry.descendants = [];
  entry.descendantBytes = 0;
  entriesByKey.delete(entry.key);
  const executionEntries = entriesByExecution.get(entry.identity.executionId);
  executionEntries?.delete(entry);
  if (executionEntries?.size === 0) {
    entriesByExecution.delete(entry.identity.executionId);
  }
}

/**
 * Registers interest in one step log. The first holder creates the interest,
 * starts buffering, and then issues the snapshot read.
 */
export function acquireStepLogInterest(
  request: StepLogInterestRequest,
): StepLogInterest {
  const key = stepLogInterestKey(request);
  let entry = entriesByKey.get(key);
  if (!entry) {
    const identity = normalizeIdentity(request.identity);
    const created: StepLogEntry = {
      key,
      identity,
      locator: {
        executionId: identity.executionId,
        jobId: identity.jobId,
        stepId: identity.stepId,
        attempt: identity.attempt,
        iteration: identity.iteration,
        recovery: identity.recovery,
        ...(request.logFilePath !== undefined
          ? { logFilePath: request.logFilePath }
          : {}),
      },
      acceptsLiveOutput: request.acceptsLiveOutput !== false,
      refCount: 0,
      terminal: request.terminal,
      log: null,
      nextSeq: 0,
      pending: [],
      pendingBytes: 0,
      descendants: [],
      descendantBytes: 0,
      heuristicLiveBytes: 0,
      overflowed: false,
      readInFlight: false,
      rereadRequested: false,
      readToken: 0,
      upgradeAttempted: false,
      readFailed: false,
      publishedLog: null,
      view: LOADING_VIEW,
      released: false,
    };
    entriesByKey.set(key, created);
    let executionEntries = entriesByExecution.get(identity.executionId);
    if (!executionEntries) {
      executionEntries = new Set<StepLogEntry>();
      entriesByExecution.set(identity.executionId, executionEntries);
    }
    executionEntries.add(created);
    // Interest (and buffering) is registered above, before the read.
    startRead(created);
    entry = created;
  }
  const held = entry;
  held.refCount += 1;
  let released = false;
  return {
    key,
    setTerminal: (terminal: boolean): void => {
      if (released || held.released || held.terminal === terminal) return;
      held.terminal = terminal;
      held.readFailed = false;
      requestRead(held);
    },
    release: (): void => {
      if (released) return;
      released = true;
      releaseEntry(held);
    },
  };
}

export function subscribeStepLog(
  key: string,
  listener: () => void,
): () => void {
  let listeners = listenersByKey.get(key);
  if (!listeners) {
    listeners = new Set<() => void>();
    listenersByKey.set(key, listeners);
  }
  listeners.add(listener);
  return (): void => {
    const current = listenersByKey.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listenersByKey.delete(key);
    }
  };
}

/** Stable snapshot for `useSyncExternalStore`. */
export function getStepLogView(key: string): StepLogView {
  return entriesByKey.get(key)?.view ?? LOADING_VIEW;
}

/**
 * A retry can restart an execution's steps under the same log identity.
 * Drop every interest's joined output for that execution and re-read, so
 * output of the new run is never merged onto the previous one. The current
 * view stays visible until the new snapshot arrives.
 */
export function resetStepLogsForExecution(executionId: string): void {
  const entries = entriesByExecution.get(executionId);
  if (!entries) return;
  entries.forEach((entry) => {
    entry.readToken += 1;
    entry.readInFlight = false;
    entry.log = null;
    entry.pending = [];
    entry.pendingBytes = 0;
    entry.descendants = [];
    entry.descendantBytes = 0;
    entry.heuristicLiveBytes = 0;
    entry.upgradeAttempted = false;
    startRead(entry);
  });
}

/** Test/diagnostic view of the retained state of one interest. */
export function inspectStepLogInterest(key: string):
  | {
      refCount: number;
      pendingEvents: number;
      pendingBytes: number;
      descendantBytes: number;
      readInFlight: boolean;
      mode: ReconciledStepLog['mode'] | null;
      stale: boolean;
    }
  | undefined {
  const entry = entriesByKey.get(key);
  if (!entry) return undefined;
  return {
    refCount: entry.refCount,
    pendingEvents: entry.pending.length,
    pendingBytes: entry.pendingBytes,
    descendantBytes: entry.descendantBytes,
    readInFlight: entry.readInFlight,
    mode: entry.log?.mode ?? null,
    stale: isStale(entry.log),
  };
}

export function getStepLogInterestCount(): number {
  return entriesByKey.size;
}
