import type {
  StepLogReadResult,
  StepOutputEvent,
  StepOutputLogPosition,
} from '@canopy/desktop-shared/types/pipeline';

export interface StreamRemainder {
  text: string;
  sequence: number;
}

export interface BufferedStepOutput {
  lines: string[];
  remainders: Record<StepOutputEvent['stream'], StreamRemainder>;
  sequence: number;
}

export type StepOutputBuffer = Record<string, BufferedStepOutput>;

const EMPTY_REMAINDER = { text: '', sequence: 0 };
const MAX_OVERLAP_WINDOW = 5;

function createEmptyBufferEntry(): BufferedStepOutput {
  return {
    lines: [],
    remainders: {
      stdout: EMPTY_REMAINDER,
      stderr: EMPTY_REMAINDER,
    },
    sequence: 0,
  };
}

/** Buffer key for one physical job step's live output stream. */
function createStepOutputBufferKey(
  executionId: string,
  jobId: string,
  stepId: string,
  attempt: number,
  iteration = 1,
  recovery = 0,
): string {
  return [
    executionId,
    jobId,
    stepId,
    String(attempt),
    String(iteration),
    String(recovery),
  ].join('\0');
}

function getAncestorStepIds(stepId: string): string[] {
  const segments = stepId.split('/').filter(Boolean);
  if (segments.length === 0) {
    return [stepId];
  }

  const ancestors: string[] = [];
  for (let index = segments.length; index > 0; index -= 1) {
    ancestors.push(segments.slice(0, index).join('/'));
  }
  return ancestors;
}

function cloneBufferEntry(
  entry: BufferedStepOutput | undefined,
): BufferedStepOutput {
  const current = entry ?? createEmptyBufferEntry();
  return {
    lines: [...current.lines],
    remainders: {
      stdout: { ...current.remainders.stdout },
      stderr: { ...current.remainders.stderr },
    },
    sequence: current.sequence,
  };
}

function applyOutputEvent(
  entry: BufferedStepOutput,
  event: StepOutputEvent,
): void {
  const remainder = entry.remainders[event.stream];
  const combined = remainder.text + event.data;
  const parts = combined.split('\n');
  const nextRemainderText = parts.pop() ?? '';
  const nextSequence = entry.sequence + 1;

  entry.lines.push(...parts);
  entry.remainders[event.stream] = {
    text: nextRemainderText,
    sequence: nextRemainderText ? nextSequence : 0,
  };
  entry.sequence = nextSequence;
}

export function appendStepOutputEvents(
  buffer: StepOutputBuffer,
  events: readonly StepOutputEvent[],
): StepOutputBuffer {
  if (events.length === 0) {
    return buffer;
  }

  const nextBuffer = { ...buffer };
  const changedEntries = new Map<string, BufferedStepOutput>();

  for (const event of events) {
    for (const stepId of getAncestorStepIds(event.stepId)) {
      const key = createStepOutputBufferKey(
        event.executionId,
        event.jobId,
        stepId,
        event.attempt,
        event.iteration ?? 1,
        event.recovery ?? 0,
      );
      let changed = changedEntries.get(key);
      if (!changed) {
        changed = cloneBufferEntry(nextBuffer[key]);
        changedEntries.set(key, changed);
      }
      applyOutputEvent(changed, event);
    }
  }

  changedEntries.forEach((entry, key) => {
    nextBuffer[key] = entry;
  });

  return nextBuffer;
}

export function appendStepOutputEvent(
  buffer: StepOutputBuffer,
  event: StepOutputEvent,
): StepOutputBuffer {
  return appendStepOutputEvents(buffer, [event]);
}

export function getStepOutputLines(
  buffer: StepOutputBuffer,
  executionId: string,
  jobId: string,
  stepId: string,
  attempt: number,
  iteration = 1,
  recovery = 0,
): string[] {
  const entry =
    buffer[
      createStepOutputBufferKey(
        executionId,
        jobId,
        stepId,
        attempt,
        iteration,
        recovery,
      )
    ];
  if (!entry) {
    return [];
  }

  const lines = [...entry.lines];
  const pending = Object.values(entry.remainders)
    .filter((value) => value.text.length > 0)
    .sort((left, right) => left.sequence - right.sequence);

  for (const value of pending) {
    lines.push(value.text);
  }

  return lines;
}

export function clearExecutionStepOutput(
  buffer: StepOutputBuffer,
  executionId: string,
): StepOutputBuffer {
  const executionPrefix = `${executionId}\0`;
  const entries = Object.entries(buffer).filter(
    ([key]) => !key.startsWith(executionPrefix),
  );
  return entries.length === Object.keys(buffer).length
    ? buffer
    : Object.fromEntries(entries);
}

function findLineOverlap(
  persistedLines: string[],
  bufferedLines: string[],
): number {
  if (persistedLines.length >= bufferedLines.length) {
    let fullBufferOverlap = true;

    for (let index = 0; index < bufferedLines.length; index += 1) {
      if (
        persistedLines[persistedLines.length - bufferedLines.length + index] !==
        bufferedLines[index]
      ) {
        fullBufferOverlap = false;
        break;
      }
    }

    if (fullBufferOverlap) {
      return bufferedLines.length;
    }
  }

  const maxOverlap = Math.min(
    persistedLines.length,
    bufferedLines.length,
    MAX_OVERLAP_WINDOW,
  );

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;

    for (let index = 0; index < overlap; index += 1) {
      if (
        persistedLines[persistedLines.length - overlap + index] !==
        bufferedLines[index]
      ) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return overlap;
    }
  }

  return 0;
}

export function mergeStepOutputLines(
  persistedLines: string[],
  bufferedLines: string[],
): string[] {
  if (persistedLines.length === 0) {
    return bufferedLines;
  }

  if (bufferedLines.length === 0) {
    return persistedLines;
  }

  // During a live run, the in-memory buffer commonly contains the complete
  // stream while the persisted read captured an earlier prefix. Prefer the
  // complete buffer in that case instead of appending it and duplicating every
  // persisted line.
  if (
    bufferedLines.length >= persistedLines.length &&
    persistedLines.every((line, index) => bufferedLines[index] === line)
  ) {
    return bufferedLines;
  }

  const overlap = findLineOverlap(persistedLines, bufferedLines);
  return [...persistedLines, ...bufferedLines.slice(overlap)];
}

// ---------------------------------------------------------------------------
// Snapshot-plus-stream reconciliation (log catch-up)
//
// Joins one persisted step log snapshot with the live output events of the
// same log, so a view that was hidden (and dropped its live buffer) can be
// revealed without losing or duplicating output.
//
// Coordinator contract:
//
// 1. Register interest in the exact log identity, and start buffering its
//    events (bounded by bytes), BEFORE reading the snapshot with
//    `readStepLog(locator, { format: 'text' })`.
// 2. When the read responds, call `reconcileStepLogSnapshot` with every
//    buffered event, then drop the buffer unless the result is `stale`.
//    Event arrival order relative to the response does not matter: older
//    generations are ignored and newer ones mark the log stale.
// 3. Feed each later event to `applyStepLogOutputEvent`.
// 4. While a positioned log is `stale`, keep buffering events (including the
//    one that made it stale), issue at most one re-read (one in flight plus a
//    dirty marker), and reconcile that snapshot with the buffer, passing the
//    stale log as `previous`. A re-read that makes no progress degrades to
//    the heuristic instead of re-reading again.
// 5. A heuristic log with `upgradeAvailable` may be re-read once, the same
//    way, to upgrade it to a positioned join.
// 6. Re-read once more when the step reaches a terminal state. A writer may
//    emit before its append lands, so a reveal that raced the last append
//    sees no later event to expose the gap; the terminal read is complete
//    because every writer settles its log before the step settles. It also
//    corrects anything positions cannot describe (a step script writing to
//    its own log path, a failed write).
// 7. On buffer overflow, drop the buffer and re-read as in (4).
//
// For agent steps the rich transcript source is the same file as the plain
// log for every current writer, so one positioned snapshot serves both.
//
// Nothing here queues events: the caller owns the only buffer and bounds it.
// ---------------------------------------------------------------------------

/** One physical step log: the exact interest key for its output events. */
export interface StepLogIdentity {
  executionId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  iteration?: number;
  recovery?: number;
}

/** A persisted snapshot as returned by `readStepLog`. */
export type StepLogSnapshot = StepLogReadResult;

/** Byte-exact join of a positioned snapshot with the events after it. */
export interface PositionedStepLog {
  mode: 'positioned';
  generation: number;
  /** Persisted content from byte 0 to `byteLength`, decoded. */
  text: string;
  byteLength: number;
  /**
   * A chunk could not be joined: it starts past `byteLength` (its preceding
   * bytes were never observed) or it belongs to a newer generation (the log
   * was replaced). Content stops at the last contiguous byte until re-read.
   */
  stale: boolean;
}

/**
 * Textual-overlap reconciliation — the pre-existing behavior — used when the
 * snapshot carries no generation (no live positioned writer in this process,
 * a read overlapping a truncation, a `lines` read, or aggregated
 * descendant output) or after a positioned join stopped making progress.
 */
export interface HeuristicStepLog {
  mode: 'heuristic';
  identity: StepLogIdentity;
  snapshotLines: string[];
  live: StepOutputBuffer;
  /**
   * Positioned output of this exact log was seen, so one `text` re-read will
   * probably return a generation and allow a byte-exact join.
   */
  upgradeAvailable: boolean;
  /** Produced after a positioned join made no progress; never upgrades. */
  degraded: boolean;
}

export type ReconciledStepLog = PositionedStepLog | HeuristicStepLog;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-8 bytes and UTF-16 units of the character starting at `index`. */
function utf8CharacterAt(
  text: string,
  index: number,
): { bytes: number; units: number } {
  const code = text.charCodeAt(index);
  if (code < 0x80) return { bytes: 1, units: 1 };
  if (code < 0x800) return { bytes: 2, units: 1 };
  if (
    code >= 0xd800 &&
    code <= 0xdbff &&
    index + 1 < text.length &&
    isLowSurrogate(text.charCodeAt(index + 1))
  ) {
    return { bytes: 4, units: 2 };
  }
  // Other BMP characters, and lone surrogates, which UTF-8 writers encode as
  // the three-byte replacement character.
  return { bytes: 3, units: 1 };
}

/**
 * The part of `text` after its first `byteOffset` UTF-8 bytes, or undefined
 * when that offset falls inside a character (an incoherent position).
 */
function sliceAfterUtf8Bytes(
  text: string,
  byteOffset: number,
): string | undefined {
  let bytes = 0;
  let index = 0;
  while (bytes < byteOffset && index < text.length) {
    const character = utf8CharacterAt(text, index);
    bytes += character.bytes;
    index += character.units;
  }
  return bytes === byteOffset ? text.slice(index) : undefined;
}

/** Cheap sanity bound: every UTF-16 unit encodes to one to three bytes. */
function isCoherentPosition(
  data: string,
  position: StepOutputLogPosition,
): boolean {
  return (
    Number.isInteger(position.offset) &&
    Number.isInteger(position.byteLength) &&
    position.offset >= 0 &&
    position.byteLength >= data.length &&
    position.byteLength <= data.length * 3
  );
}

function eventMatchesStepLog(
  event: StepOutputEvent,
  identity: StepLogIdentity,
  includeDescendants: boolean,
): boolean {
  if (
    event.executionId !== identity.executionId ||
    event.jobId !== identity.jobId ||
    event.attempt !== identity.attempt ||
    (event.iteration ?? 1) !== (identity.iteration ?? 1) ||
    (event.recovery ?? 0) !== (identity.recovery ?? 0)
  ) {
    return false;
  }
  return (
    event.stepId === identity.stepId ||
    (includeDescendants && event.stepId.startsWith(`${identity.stepId}/`))
  );
}

/** Mirrors the `readStepLog` `lines` shape: CRLF-normalized, no final ''. */
function toLogLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function applyPositionedEvent(
  log: PositionedStepLog,
  event: StepOutputEvent,
): PositionedStepLog {
  const position = event.logPosition;
  // Every persisted chunk of a positioned log is positioned; an unpositioned
  // event of the same log was emitted but never persisted.
  if (!position || position.generation < log.generation) return log;
  if (
    position.generation > log.generation ||
    !isCoherentPosition(event.data, position)
  ) {
    return { ...log, stale: true };
  }
  const end = position.offset + position.byteLength;
  if (end <= log.byteLength) return log;
  if (position.offset > log.byteLength) return { ...log, stale: true };
  const tail =
    position.offset === log.byteLength
      ? event.data
      : sliceAfterUtf8Bytes(event.data, log.byteLength - position.offset);
  if (tail === undefined) return { ...log, stale: true };
  return { ...log, text: log.text + tail, byteLength: end };
}

function createHeuristicStepLog(
  snapshot: StepLogSnapshot,
  events: readonly StepOutputEvent[],
  identity: StepLogIdentity,
  degraded: boolean,
): HeuristicStepLog {
  const relevant = events.filter((event) =>
    eventMatchesStepLog(event, identity, true),
  );
  return {
    mode: 'heuristic',
    identity,
    snapshotLines:
      snapshot.text === undefined ? snapshot.lines : toLogLines(snapshot.text),
    live: appendStepOutputEvents({}, relevant),
    upgradeAvailable:
      !degraded &&
      relevant.some(
        (event) =>
          event.stepId === identity.stepId && event.logPosition !== undefined,
      ),
    degraded,
  };
}

/**
 * Joins a snapshot with the events buffered since interest was registered.
 *
 * A snapshot with a generation and raw `text` is joined byte-exactly: events
 * wholly inside it are dropped, a straddling event is sliced at the snapshot
 * end, and later events are appended in order. Older generations are
 * ignored; a newer generation or a gap marks the log `stale`. Anything else
 * falls back to the textual-overlap heuristic. Pass the previous log when
 * this is a re-read, so a join that made no progress degrades rather than
 * re-reading forever.
 */
export function reconcileStepLogSnapshot(
  snapshot: StepLogSnapshot,
  bufferedEvents: readonly StepOutputEvent[],
  identity: StepLogIdentity,
  previous?: ReconciledStepLog,
): ReconciledStepLog {
  if (
    snapshot.generation === undefined ||
    snapshot.text === undefined ||
    snapshot.byteLength === undefined
  ) {
    return createHeuristicStepLog(snapshot, bufferedEvents, identity, false);
  }

  let log: PositionedStepLog = {
    mode: 'positioned',
    generation: snapshot.generation,
    text: snapshot.text,
    byteLength: snapshot.byteLength,
    stale: false,
  };
  for (const event of bufferedEvents) {
    if (log.stale) break;
    if (eventMatchesStepLog(event, identity, false)) {
      log = applyPositionedEvent(log, event);
    }
  }

  if (
    log.stale &&
    previous?.mode === 'positioned' &&
    previous.stale &&
    previous.generation === log.generation &&
    log.byteLength <= previous.byteLength
  ) {
    return createHeuristicStepLog(snapshot, bufferedEvents, identity, true);
  }
  return log;
}

/**
 * Applies one event that arrived after the snapshot response. A stale
 * positioned log is returned unchanged: keep buffering and re-read.
 */
export function applyStepLogOutputEvent(
  log: ReconciledStepLog,
  event: StepOutputEvent,
  identity: StepLogIdentity,
): ReconciledStepLog {
  if (log.mode === 'positioned') {
    if (log.stale || !eventMatchesStepLog(event, identity, false)) return log;
    return applyPositionedEvent(log, event);
  }
  if (!eventMatchesStepLog(event, identity, true)) return log;
  return {
    ...log,
    live: appendStepOutputEvent(log.live, event),
    upgradeAvailable:
      log.upgradeAvailable ||
      (!log.degraded &&
        event.stepId === identity.stepId &&
        event.logPosition !== undefined),
  };
}

/** Display lines, in the `readStepLog` `lines` shape. */
export function getReconciledStepLogLines(log: ReconciledStepLog): string[] {
  if (log.mode === 'positioned') return toLogLines(log.text);
  const { identity } = log;
  return mergeStepOutputLines(
    log.snapshotLines,
    getStepOutputLines(
      log.live,
      identity.executionId,
      identity.jobId,
      identity.stepId,
      identity.attempt,
      identity.iteration ?? 1,
      identity.recovery ?? 0,
    ),
  );
}
