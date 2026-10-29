import { workspaceCreationDiagnosticsSchema } from './reservation-diagnostics';
import {
  applyW5Commit,
  type W5DurabilityPort,
  type W5RecoveryReport,
} from './apply';
import type {
  W5CommitLog,
  W5CommitRequest,
  W5Resource,
  W5ReceiptKey,
} from './commit-log';
import { W5CommitLogError, W5CommitRefusedError } from './errors';
import { isRecord } from './is-record';
import type {
  W5CommitLogRequest,
  W5CommitLogWorkerData,
  W5CommitLogWorkerError,
  W5CommitOutcome,
} from './worker-contract';

/*
 * How the W5 commit log worker runs a request, apart from the thread it runs
 * in, so it can be tested on a log opened in the test process (CAN-3805).
 */

export const MALFORMED_REQUEST_MESSAGE =
  'The W5 commit log request is malformed';
const UNEXPECTED_FAILURE_MESSAGE = 'The W5 commit log call failed unexpectedly';

/** A request this worker rejects before running it. */
class W5CommitLogRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'W5CommitLogRequestError';
  }
}

export function toW5CommitLogWorkerError(
  error: unknown,
): W5CommitLogWorkerError {
  if (error instanceof W5CommitRefusedError) {
    return {
      kind: 'refused',
      reason: error.reason,
      message: error.message,
      details: { ...error.details },
    };
  }
  if (error instanceof W5CommitLogError) {
    return { kind: 'log', code: error.code, message: error.message };
  }
  if (error instanceof W5CommitLogRequestError) {
    return { kind: 'malformed', message: error.message };
  }
  return { kind: 'failed', message: UNEXPECTED_FAILURE_MESSAGE };
}

function isResource(value: unknown): value is W5Resource {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'workspaces':
      return true;
    case 'workspace':
    case 'worktrees':
      return typeof value.workspaceId === 'string';
    case 'worktree':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.worktreeId === 'string'
      );
    default:
      return false;
  }
}

function isReceipt(
  value: unknown,
): value is W5ReceiptKey & { fingerprint: string } {
  return (
    isRecord(value) &&
    typeof value.caller === 'string' &&
    typeof value.operation === 'string' &&
    typeof value.idempotencyKey === 'string' &&
    typeof value.fingerprint === 'string'
  );
}

function isExpectedRevision(value: unknown): boolean {
  return (
    isRecord(value) &&
    isResource(value.resource) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision)
  );
}

function isCommitRequest(value: unknown): value is W5CommitRequest {
  return (
    isRecord(value) &&
    typeof value.operation === 'string' &&
    (value.receipt === undefined || isReceipt(value.receipt)) &&
    (value.expectedRevisions === undefined ||
      (Array.isArray(value.expectedRevisions) &&
        value.expectedRevisions.every(isExpectedRevision))) &&
    (value.reservationId === undefined ||
      typeof value.reservationId === 'string') &&
    'outcome' in value &&
    Array.isArray(value.advance) &&
    value.advance.every(isResource) &&
    Array.isArray(value.files) &&
    value.files.every(
      (file: unknown) =>
        isRecord(file) &&
        typeof file.path === 'string' &&
        (file.contents === null || typeof file.contents === 'string') &&
        (file.previousFingerprint === null ||
          typeof file.previousFingerprint === 'string'),
    )
  );
}

export class W5CommitLogRequestHandler {
  constructor(
    private readonly log: W5CommitLog,
    private readonly data: W5CommitLogWorkerData,
    private readonly recovery: W5RecoveryReport,
    /** Supplied by the host that composes the worker. */
    private readonly durability: W5DurabilityPort,
  ) {}

  async run(request: W5CommitLogRequest): Promise<unknown> {
    const [first] = request.args;
    switch (request.method) {
      case 'recoveryReport': {
        const reservations = this.log.listReservations();
        return {
          ...this.recovery,
          ...(reservations.length ? { reservations } : {}),
        };
      }
      case 'snapshot':
        return this.log.snapshot();
      case 'revision':
        if (!isResource(first)) throw malformed();
        return this.log.revision(first);
      case 'lookupReceipt':
        if (!isReceipt(first)) throw malformed();
        await this.finishPendingCommits();
        return this.log.lookupReceipt(first, first.fingerprint);
      case 'reserve': {
        if (
          !isRecord(first) ||
          typeof first.reservationId !== 'string' ||
          typeof first.operation !== 'string' ||
          (first.receipt !== undefined &&
            (!isReceipt(first.receipt) ||
              first.operation !== first.receipt.operation))
        )
          throw malformed();
        this.log.reserve({
          reservationId: first.reservationId,
          operation: first.operation,
          receipt: first.receipt,
          diagnostics: first.diagnostics ?? null,
        });
        return null;
      }
      case 'updateReservationDiagnostics': {
        const diagnostics = workspaceCreationDiagnosticsSchema.safeParse(
          request.args[1],
        );
        if (typeof first !== 'string' || !diagnostics.success)
          throw malformed();
        this.log.updateReservationDiagnostics(first, diagnostics.data);
        return null;
      }
      case 'releaseReservation':
        if (typeof first !== 'string') throw malformed();
        this.log.releaseReservation(first);
        return null;
      case 'markReservationRecoveryRequired': {
        const diagnostics = request.args[1];
        if (
          typeof first !== 'string' ||
          !isRecord(diagnostics) ||
          typeof diagnostics.operation !== 'string' ||
          typeof diagnostics.errorName !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(diagnostics.errorName) ||
          (diagnostics.errorCode !== undefined &&
            (typeof diagnostics.errorCode !== 'string' ||
              !/^[A-Z][A-Z0-9_]{0,63}$/.test(diagnostics.errorCode)))
        )
          throw malformed();
        this.log.markReservationRecoveryRequired(first, {
          operation: diagnostics.operation,
          errorName: diagnostics.errorName,
          ...(diagnostics.errorCode === undefined
            ? {}
            : { errorCode: diagnostics.errorCode }),
        });
        return null;
      }
      case 'commit':
        if (!isCommitRequest(first)) throw malformed();
        return this.commit(first);
    }
  }

  private async commit(request: W5CommitRequest): Promise<W5CommitOutcome> {
    // An earlier call can fail after its commit is durable. Its files are
    // written first, so a replay never reports an outcome they do not hold
    // and a later change never commits over it.
    await this.finishPendingCommits();
    const result = this.log.commit(request);
    if (result.status === 'replayed' || result.status === 'replay-expired')
      return result;
    const pending = this.log
      .listPendingCommits()
      .find((commit) => commit.commitId === result.commitId);
    // Nothing else was pending, so a missing commit means the log changed
    // under this worker.
    if (!pending) throw new Error(UNEXPECTED_FAILURE_MESSAGE);
    const applied = await applyW5Commit(this.log, pending, {
      root: this.data.root,
      durability: this.durability,
    });
    return applied.status === 'applied'
      ? {
          status: 'applied',
          commitId: result.commitId,
          revisions: result.revisions,
        }
      : {
          status: 'recovery-required',
          commitId: result.commitId,
          revisions: result.revisions,
          apply: applied,
        };
  }

  private async finishPendingCommits(): Promise<void> {
    for (const pending of this.log.listPendingCommits()) {
      await applyW5Commit(this.log, pending, {
        root: this.data.root,
        durability: this.durability,
      });
    }
  }
}

function malformed(): W5CommitLogRequestError {
  return new W5CommitLogRequestError(MALFORMED_REQUEST_MESSAGE);
}
