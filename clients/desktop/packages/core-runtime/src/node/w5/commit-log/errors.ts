/** The W5 commit log could not be opened or used. Nothing was committed. */
export type W5CommitLogErrorCode =
  | 'STORAGE_UNAVAILABLE'
  | 'WRITER_UNAVAILABLE'
  | 'UNSUPPORTED_SCHEMA';

export class W5CommitLogError extends Error {
  constructor(
    readonly code: W5CommitLogErrorCode,
    message: string,
    /** The storage error behind this one, when there is one. */
    readonly underlying?: unknown,
  ) {
    super(message);
    this.name = 'W5CommitLogError';
  }
}

/**
 * Why a commit was refused. Each refusal leaves canonical state, revisions
 * and receipts unchanged.
 */
export type W5CommitRefusal =
  | 'identity-conflict'
  /** A checked revision moved since the caller read it. */
  | 'revision-conflict'
  /** The idempotency key was already used with different parameters. */
  | 'key-reused'
  /** Already completed; the saved outcome is outside the retry window. */
  | 'outcome-expired'
  /** Another request with the same key is still in progress. */
  | 'in-progress'
  /** The key's earlier attempt was interrupted and needs manual recovery. */
  | 'recovery-required'
  /** A file this change writes has a committed change not yet applied. */
  | 'unapplied-change'
  /** The commit names a reservation that is not held. */
  | 'unknown-reservation'
  /** The commit or reservation is not in the state this action needs. */
  | 'invalid-state';

export class W5CommitRefusedError extends Error {
  constructor(
    readonly reason: W5CommitRefusal,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'W5CommitRefusedError';
  }
}

/** Acquisition failed before a W5 decision; never an apply conflict. */
export class W5ProcessFileLockTimeoutError extends Error {
  constructor(readonly path: string) {
    super(
      "Another process is changing this project's worktree list. Try again in a moment.",
    );
    this.name = 'W5ProcessFileLockTimeoutError';
  }
}

/** A stale preimage, before decision or after proven no-effect abandonment. */
export class W5FileWriteRefusedError extends Error {
  readonly reason = 'fingerprint-conflict';
  constructor(readonly path: string) {
    super('This was changed since it was read. Reload and try again.');
    this.name = 'W5FileWriteRefusedError';
  }
}
