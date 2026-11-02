// The subpath, not the commit log index: main loads the host at startup, and
// the index would load node:sqlite there, which only the worker needs.
export {
  isW5CaptureRequest,
  isW5CaptureResult,
  freezeW5Capture,
  isW5CaptureWorkspaceId,
  type W5CaptureFile,
  type W5CaptureRequest,
  type W5CaptureResult,
  type W5FileImage,
  isW5BackupPosition,
  isW5CommitLogMethod,
  isW5CommitLogRequest,
  isW5CommitLogResponse,
  isW5CommitLogStartupMessage,
  isW5CommitLogWorkerData,
  isW5CommitOutcome,
  isW5ReceiptLookup,
  isW5RecoveryReport,
  isW5RecoveryRetryOutcome,
  isW5Revision,
  readW5CommitLogRequestId,
  type W5CommitLogMethod,
  type W5CommitLogRequest,
  type W5CommitLogResponse,
  type W5CommitLogStartupMessage,
  type W5CommitLogWorkerData,
  type W5CommitLogWorkerError,
  type W5CommitOutcome,
  type W5HostRecoveryReport,
  type W5RecoveryRetryOutcome,
} from '@canopy/core-runtime/node/w5/commit-log/worker-contract';
import {
  isW5CommitLogWorkerData,
  type W5CommitLogHostWorkerData,
} from '@canopy/core-runtime/node/w5/commit-log/worker-contract';

/**
 * The worker data the core-runtime host starts this entry with; on win32 it
 * names the owned-child addon serving handle-confined capture reads (CAN-5202).
 */
export type DesktopW5CommitLogWorkerData = W5CommitLogHostWorkerData;

// Typed, so a rename on the host's side fails to compile here.
const ADDON_FIELD =
  'confinementAddon' satisfies keyof DesktopW5CommitLogWorkerData;

export function isDesktopW5CommitLogWorkerData(
  value: unknown,
): value is DesktopW5CommitLogWorkerData {
  if (!isW5CommitLogWorkerData(value)) return false;
  const addon: unknown = Reflect.get(value, ADDON_FIELD);
  return addon === undefined || typeof addon === 'string';
}
