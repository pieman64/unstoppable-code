import type { W5ApplyResult, W5RecoveryReport } from './apply';
import type {
  W5BackupPosition,
  W5ReceiptLookup,
  W5Reservation,
} from './commit-log';
import type { W5CommitLogErrorCode, W5CommitRefusal } from './errors';
import { isRecord } from './is-record';

/*
 * Private, same-process message contract between the W5 commit log host on the
 * Electron main thread and the worker thread that holds the commit log's only
 * connection (CAN-3805). It carries commit log calls and their outcomes; what
 * a write commits stays with the W5 repositories.
 */

/** The `workerData` the host starts the worker with. */
export interface W5CommitLogWorkerData {
  /** The commit log database. */
  dbPath: string;
  /** The W5 data root; every file a commit writes must be inside it. */
  root: string;
}

/**
 * `recoveryReport` returns what launch recovery found when the worker opened
 * the log; `commit` commits a change and writes its files before answering;
 * `revision` reads one resource's revision; `lookupReceipt` admits a keyed
 * attempt without effects; `reserve` durably names it before uncertain effects; `snapshot` reads the verified
 * backup position after file recovery.
 */
export type W5CommitLogMethod =
  | 'recoveryReport'
  | 'commit'
  | 'revision'
  | 'lookupReceipt'
  | 'reserve'
  | 'updateReservationDiagnostics'
  | 'releaseReservation'
  | 'markReservationRecoveryRequired'
  | 'snapshot';

/** What one commit request did. */
export type W5CommitOutcome =
  /** A keyed request seen before: its saved outcome, with no new effect. */
  | { status: 'replayed'; commitId: number; outcome: unknown }
  /** Already completed; the saved outcome expired, so no effect is repeated. */
  | { status: 'replay-expired'; commitId: number }
  /** Committed and written to its files. */
  | { status: 'applied'; commitId: number; revisions: Record<string, number> }
  /**
   * Committed, but its files could not be brought up to date; the commit
   * waits for manual recovery and blocks later changes to those files.
   */
  | {
      status: 'recovery-required';
      commitId: number;
      revisions: Record<string, number>;
      apply: Extract<W5ApplyResult, { status: 'recovery-required' }>;
    };

/**
 * A failure the worker reports. The commit log's own errors keep their code
 * or refusal reason. `malformed` is a request the worker rejected before
 * running it; `failed` is any other failure, with a fixed message, after
 * which a commit may or may not have been made.
 */
export type W5CommitLogWorkerError =
  | { kind: 'log'; code: W5CommitLogErrorCode; message: string }
  | {
      kind: 'refused';
      reason: W5CommitRefusal;
      message: string;
      details: Record<string, unknown>;
    }
  | { kind: 'malformed'; message: string }
  | { kind: 'failed'; message: string };

/** Host to worker. The host sends one request at a time, in FIFO order. */
export interface W5CommitLogRequest {
  id: number;
  method: W5CommitLogMethod;
  args: readonly unknown[];
}

/** Worker to host: the outcome of the request with the same `id`. */
export type W5CommitLogResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: W5CommitLogWorkerError };

/**
 * Worker to host, sent once after the worker has opened the log and run
 * launch recovery, before any response.
 */
export type W5CommitLogStartupMessage =
  | { type: 'ready' }
  | { type: 'openFailed'; error: W5CommitLogWorkerError };

const METHODS: ReadonlySet<string> = new Set<W5CommitLogMethod>([
  'recoveryReport',
  'commit',
  'revision',
  'lookupReceipt',
  'reserve',
  'updateReservationDiagnostics',
  'releaseReservation',
  'markReservationRecoveryRequired',
  'snapshot',
]);

function isRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isW5CommitLogMethod(
  value: unknown,
): value is W5CommitLogMethod {
  return typeof value === 'string' && METHODS.has(value);
}

function isWorkerError(value: unknown): value is W5CommitLogWorkerError {
  if (!isRecord(value) || typeof value.message !== 'string') return false;
  switch (value.kind) {
    case 'log':
      return typeof value.code === 'string';
    case 'refused':
      return typeof value.reason === 'string' && isRecord(value.details);
    case 'malformed':
    case 'failed':
      return true;
    default:
      return false;
  }
}

export function isW5CommitLogWorkerData(
  value: unknown,
): value is W5CommitLogWorkerData {
  return (
    isRecord(value) &&
    typeof value.dbPath === 'string' &&
    value.dbPath.length > 0 &&
    typeof value.root === 'string' &&
    value.root.length > 0
  );
}

export function isW5CommitLogRequest(
  value: unknown,
): value is W5CommitLogRequest {
  return (
    isRecord(value) &&
    isRequestId(value.id) &&
    isW5CommitLogMethod(value.method) &&
    Array.isArray(value.args)
  );
}

export function isW5CommitLogResponse(
  value: unknown,
): value is W5CommitLogResponse {
  if (!isRecord(value) || !isRequestId(value.id)) return false;
  if (value.ok === true) return 'result' in value;
  return value.ok === false && isWorkerError(value.error);
}

export function isW5CommitLogStartupMessage(
  value: unknown,
): value is W5CommitLogStartupMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'ready') return true;
  return value.type === 'openFailed' && isWorkerError(value.error);
}

function isCommitIdList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id),
    )
  );
}

function isRevisionMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (revision: unknown) =>
        typeof revision === 'number' && Number.isSafeInteger(revision),
    )
  );
}

export type W5HostRecoveryReport = W5RecoveryReport & {
  /** Existing reservation records, for host lifecycle diagnostics and id admission. */
  reservations?: W5Reservation[];
};

export function isW5RecoveryReport(
  value: unknown,
): value is W5HostRecoveryReport {
  return (
    isRecord(value) &&
    isCommitIdList(value.applied) &&
    isCommitIdList(value.recoveryRequired) &&
    (value.recoveryRequiredDetails === undefined ||
      (Array.isArray(value.recoveryRequiredDetails) &&
        value.recoveryRequiredDetails.every(
          (detail: unknown) =>
            isRecord(detail) &&
            isW5Revision(detail.commitId) &&
            isW5Revision(detail.conflictCount) &&
            isW5Revision(detail.writtenFileCount) &&
            typeof detail.unexpectedFailure === 'boolean',
        ))) &&
    (value.recoveryRequiredReservations === undefined ||
      (Array.isArray(value.recoveryRequiredReservations) &&
        value.recoveryRequiredReservations.every(
          (id: unknown) => typeof id === 'string',
        ))) &&
    (value.reservations === undefined ||
      (Array.isArray(value.reservations) &&
        value.reservations.every(
          (entry: unknown) =>
            isRecord(entry) &&
            typeof entry.reservationId === 'string' &&
            typeof entry.operation === 'string' &&
            (entry.state === 'reserved' ||
              entry.state === 'recovery-required') &&
            'diagnostics' in entry,
        ))) &&
    typeof value.interruptedReservations === 'number'
  );
}

export function isW5Revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isW5CommitOutcome(value: unknown): value is W5CommitOutcome {
  if (!isRecord(value) || typeof value.commitId !== 'number') return false;
  switch (value.status) {
    case 'replayed':
      return 'outcome' in value;
    case 'replay-expired':
      return Number.isSafeInteger(value.commitId) && value.commitId > 0;
    case 'applied':
      return isRevisionMap(value.revisions);
    case 'recovery-required':
      return (
        isRevisionMap(value.revisions) &&
        isRecord(value.apply) &&
        value.apply.status === 'recovery-required' &&
        Array.isArray(value.apply.conflicts) &&
        Array.isArray(value.apply.written)
      );
    default:
      return false;
  }
}

/** The `id` of a message, when it carries one a response can answer. */
export function readW5CommitLogRequestId(value: unknown): number | undefined {
  return isRecord(value) && isRequestId(value.id) ? value.id : undefined;
}

export function isW5ReceiptLookup(value: unknown): value is W5ReceiptLookup {
  if (!isRecord(value)) return false;
  switch (value.status) {
    case 'none':
    case 'key-reused':
      return true;
    case 'replay':
      return isW5Revision(value.commitId) && 'outcome' in value;
    case 'replay-expired':
      return isW5Revision(value.commitId);
    case 'commit-recovery-required':
      return isW5Revision(value.commitId) && 'diagnostics' in value;
    case 'in-progress':
      return typeof value.reservationId === 'string';
    case 'recovery-required':
      return typeof value.reservationId === 'string' && 'diagnostics' in value;
    default:
      return false;
  }
}

/** Private worker reply for the backup's stable log position. */
export function isW5BackupPosition(value: unknown): value is W5BackupPosition {
  return (
    isRecord(value) &&
    isW5Revision(value.commitId) &&
    // The log's own schema; the backup compares it, the host does not.
    isW5Revision(value.schemaVersion) &&
    value.schemaVersion > 0 &&
    isRecord(value.revisions) &&
    Object.values(value.revisions).every(isW5Revision)
  );
}
