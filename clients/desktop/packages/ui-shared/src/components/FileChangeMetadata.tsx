import type { JSX } from 'react';
import { DiffLineCounts } from './DiffLineCounts';

/**
 * Closed set of file-change statuses surfaced in the Changed Files section,
 * the diff sidebar, and any future per-file activity feed.
 */
export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'type-changed'
  | 'untracked'
  | 'unknown';

const STATUS_DOT_CLASSES: Record<FileChangeStatus, string> = {
  added: 'bg-success',
  modified: 'bg-warning',
  deleted: 'bg-destructive',
  // Copied shares the renamed identity: a file that came from another path.
  renamed: 'bg-fg-info',
  copied: 'bg-fg-info',
  unmerged: 'bg-destructive',
  'type-changed': 'bg-fg-special-strong',
  untracked: 'bg-success',
  unknown: 'bg-fg-primary/40',
};

const STATUS_LABELS: Record<FileChangeStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  unmerged: 'Unmerged',
  'type-changed': 'Type changed',
  untracked: 'Untracked',
  unknown: 'Unknown',
};

export interface FileChangeMetadataProps {
  /** Insertion count. Hidden when undefined or zero. */
  insertions?: number;
  /** Deletion count. Hidden when undefined or zero. */
  deletions?: number;
  /** File status; renders the colored dot at the end. */
  status: FileChangeStatus;
  /** Hide the metadata when the parent is in a "hover-action" state — used
   * by Changed Files to swap +/- counts for the revert button. */
  hideOnHover?: boolean;
}

/**
 * `+N -M` insertion/deletion text plus a status dot. Pure display; both
 * Changed Files (desktop + web) and the file-tree sidebar render this.
 */
export function FileChangeMetadata({
  insertions,
  deletions,
  status,
  hideOnHover = false,
}: FileChangeMetadataProps): JSX.Element {
  const hiddenClass = hideOnHover
    ? 'group-hover:hidden group-focus-within:hidden'
    : '';
  const dotClass = STATUS_DOT_CLASSES[status];
  const label = STATUS_LABELS[status];
  return (
    <>
      <DiffLineCounts
        insertions={insertions}
        deletions={deletions}
        className={`shrink-0 ${hiddenClass}`}
      />
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${dotClass} ${hiddenClass}`}
        title={label}
      />
    </>
  );
}
