/*
 * The keyed-receipt model shared by the W5 commit log (CAN-3805) and the
 * operation ledger (CAN-4130). A keyed request is identified by its caller,
 * operation and idempotency key, and bound to a fingerprint of its
 * parameters. Its identity is committed before any effect and survives the
 * saved outcome. Before running, a keyed request asks its store for one of
 * these decisions:
 *
 * - `none`: the key is free; commit the identity, then run.
 * - `replay`: return the recorded outcome; run nothing.
 * - `replay-expired`: the request completed but its outcome aged out of the
 *   retry window; still run nothing.
 * - `key-reused`: the key belongs to different parameters; refuse.
 * - `in-progress`: an accepted attempt has not finished; wait or observe it.
 * - `recovery-required`: an attempt was interrupted after effects may have
 *   started; never rerun it blindly.
 *
 * W5's commit log adds `commit-recovery-required` for a committed decision
 * whose files have not caught up. W5 keeps its own tables because a W5
 * receipt commits in the same SQLite transaction as the W5 file decision and
 * revisions it records; the operation ledger is a separate database.
 */

/** Who asked for a keyed request, and the request's identity. */
export interface KeyedReceiptKey {
  /** The authenticated caller; keys are scoped to it. */
  caller: string;
  operation: string;
  idempotencyKey: string;
}

export const KEYED_RECEIPT_DECISIONS = [
  'none',
  'replay',
  'replay-expired',
  'key-reused',
  'in-progress',
  'recovery-required',
] as const;
export type KeyedReceiptDecision = (typeof KEYED_RECEIPT_DECISIONS)[number];

/** Full outcomes survive for 30 days after completion (CAN-4029). */
export const KEYED_RECEIPT_RETRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
