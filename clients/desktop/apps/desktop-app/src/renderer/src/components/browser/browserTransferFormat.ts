// Display copy for browser transfers (the Files panel, the Downloads button,
// and the completion toast). Sizes follow docs/ux-writing.md "Numbers and
// Time": no space before an abbreviated unit, case-sensitive byte units.

import type {
  BrowserTransfer,
  BrowserTransferErrorCode,
  BrowserUploadStatus,
} from '@canopy/desktop-shared/types';
import { isActiveTransfer } from '@/stores/browserStore';

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

export function formatTransferBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))}B`;
  }
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${BYTE_UNITS[unit] ?? 'TB'}`;
}

/** A download's file name, where a copy is going, or the files an upload sends. */
export function transferName(transfer: BrowserTransfer): string {
  if (transfer.kind === 'upload') {
    const first = transfer.files[0]?.displayPath ?? '';
    return transfer.files.length > 1
      ? `${first} and ${transfer.files.length - 1} more`
      : first;
  }
  return transfer.kind === 'copy'
    ? transfer.destinationName
    : transfer.fileName;
}

function transferProgress(transfer: BrowserTransfer): {
  done: number;
  total: number | null;
} {
  if (transfer.kind === 'upload')
    return transfer.status === 'staging'
      ? { done: transfer.stagedBytes, total: transfer.totalBytes }
      : { done: transfer.totalBytes, total: null };
  return transfer.kind === 'copy'
    ? { done: transfer.copiedBytes, total: transfer.totalBytes }
    : { done: transfer.receivedBytes, total: transfer.totalBytes };
}

/** Whether the row shows a progress bar: only while bytes move. */
export function transferMoving(transfer: BrowserTransfer): boolean {
  return transfer.kind === 'upload'
    ? transfer.status === 'staging'
    : transfer.status === 'in_progress' || transfer.status === 'paused';
}

function uploadStatusLabel(status: BrowserUploadStatus): string {
  switch (status) {
    case 'staging':
      return 'Preparing';
    case 'awaiting_approval':
      return 'Waiting for approval';
    case 'attached':
      return 'Attached';
    case 'cancelled':
      return 'Cancelled';
    case 'denied':
      return 'Not approved';
    case 'failed':
      return 'Failed';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function transferStatusLabel(transfer: BrowserTransfer): string {
  if (transfer.kind === 'upload') return uploadStatusLabel(transfer.status);
  const status = transfer.status;
  switch (status) {
    case 'in_progress':
      return transfer.kind === 'copy' ? 'Copying' : 'Downloading';
    case 'paused':
      return 'Paused';
    case 'complete':
      return transfer.kind === 'copy' ? 'Copied' : 'Downloaded';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Interrupted';
    case 'failed':
      return 'Failed';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Received of total while it runs; the final size once it is done. */
export function transferSizeLabel(transfer: BrowserTransfer): string {
  const { done, total } = transferProgress(transfer);
  const hasTotal = total !== null && total > 0;
  if (transfer.status === 'complete') {
    return formatTransferBytes(hasTotal ? total : done);
  }
  if (hasTotal) {
    return `${formatTransferBytes(done)} of ${formatTransferBytes(total)}`;
  }
  return done > 0 ? formatTransferBytes(done) : '';
}

/**
 * A reason worth adding to the status. Raw error messages can carry host
 * detail, so only known codes are shown.
 */
export function transferErrorLabel(transfer: BrowserTransfer): string | null {
  switch (transfer.error?.code) {
    case 'disk_full':
      return 'Not enough disk space';
    case 'destination_exists':
      return 'A file with that name already exists';
    case 'file_changed':
      return 'A file changed after it was approved';
    case 'origin_changed':
      return 'The page moved to another site';
    default:
      return null;
  }
}

/** Percentage for a progress bar, or null when the size is unknown. */
export function transferPercentage(transfer: BrowserTransfer): number | null {
  const { done, total } = transferProgress(transfer);
  if (total === null || total <= 0) {
    return null;
  }
  return Math.round((done / total) * 100);
}

/** Aggregate progress of the active downloads whose size is known. */
export function activeTransfersPercentage(
  transfers: readonly BrowserTransfer[],
): number {
  let received = 0;
  let total = 0;
  for (const transfer of transfers) {
    if (
      transfer.kind === 'download' &&
      isActiveTransfer(transfer) &&
      transfer.totalBytes !== null &&
      transfer.totalBytes > 0
    ) {
      received += Math.min(transfer.receivedBytes, transfer.totalBytes);
      total += transfer.totalBytes;
    }
  }
  return total > 0 ? Math.round((received / total) * 100) : 0;
}

export type BrowserTransferRowCommand =
  | 'cancel'
  | 'resume'
  | 'show'
  | 'save_copy'
  | 'attach';

export function transferCommandErrorMessage(
  command: BrowserTransferRowCommand,
  code?: BrowserTransferErrorCode,
): string {
  if (code === 'not_found') {
    return command === 'cancel' || command === 'resume'
      ? 'This download is no longer available.'
      : "Couldn't find this file. It may have been moved or deleted.";
  }
  switch (command) {
    case 'cancel':
      return "Couldn't cancel this download.";
    case 'resume':
      return "Couldn't resume this download.";
    case 'show':
      return "Couldn't show this file in its folder.";
    case 'save_copy':
      return "Couldn't save a copy of this file.";
    case 'attach':
      return "Couldn't attach this file.";
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

/** What the Files panel announces when a download stops without finishing. */
export function transferStoppedAnnouncement(
  transfer: BrowserTransfer,
): string | null {
  const name = transferName(transfer);
  switch (transfer.status) {
    case 'failed':
      return `${name} failed.`;
    case 'cancelled':
      return `${name} was cancelled.`;
    case 'interrupted':
      return `${name} was interrupted.`;
    default:
      return null;
  }
}
