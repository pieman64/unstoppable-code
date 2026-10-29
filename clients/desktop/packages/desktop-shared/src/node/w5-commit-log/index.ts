import {
  applyW5Commit as applyW5CommitWith,
  recoverW5CommitLog as recoverW5CommitLogWith,
  type W5ApplyOptions as W5PortableApplyOptions,
  type W5ApplyResult,
  type W5CommitLog,
  type W5PendingCommit,
  type W5RecoveryReport,
} from '@canopy/core-runtime/node/w5/commit-log';
import { desktopW5Durability } from './durability';

/*
 * Compatibility entrypoint for the W5 commit log, which lives in
 * @canopy/core-runtime/node/w5/commit-log (CAN-4408). Applying here writes
 * through the desktop's durability unless the caller supplies its own.
 */

export {
  W5CommitLog,
  W5_RECEIPT_RETRY_WINDOW_MS,
  W5_COMPACTION_BATCH_SIZE,
  W5_COMPACTION_INTERVAL,
  type W5CommitLogOptions,
  w5ResourceKey,
  type W5CommitRequest,
  type W5BackupPosition,
  type W5CommitResult,
  type W5FileChange,
  type W5PendingCommit,
  type W5ReceiptKey,
  type W5ReceiptLookup,
  type W5Reservation,
  type W5ReservationFailureDiagnostics,
  type W5Resource,
  type W5ApplyResult,
  type W5FileConflict,
  type W5ApplyStep,
  type W5RecoveryReport,
  W5_COMMIT_LOG_SCHEMA_VERSION,
  openW5CommitLogDatabase,
} from '@canopy/core-runtime/node/w5/commit-log';
export { fingerprintW5File } from './fingerprint';
export {
  W5CommitLogError,
  W5CommitRefusedError,
  type W5CommitLogErrorCode,
  type W5CommitRefusal,
} from './errors';

export type W5ApplyOptions = Omit<W5PortableApplyOptions, 'durability'> &
  Partial<Pick<W5PortableApplyOptions, 'durability'>>;

function withDesktopDurability(
  options: W5ApplyOptions,
): W5PortableApplyOptions {
  return { ...options, durability: options.durability ?? desktopW5Durability };
}

export function applyW5Commit(
  log: W5CommitLog,
  commit: W5PendingCommit,
  options: W5ApplyOptions,
): Promise<W5ApplyResult> {
  return applyW5CommitWith(log, commit, withDesktopDurability(options));
}

export function recoverW5CommitLog(
  log: W5CommitLog,
  options: W5ApplyOptions,
): Promise<W5RecoveryReport> {
  return recoverW5CommitLogWith(log, withDesktopDurability(options));
}
