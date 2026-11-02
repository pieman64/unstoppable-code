'use client';

import type { JSX } from 'react';
import { LoadingSpinner } from './LoadingSpinner';
import { Notice, NoticeButton } from './Notice';
import {
  unitCountLabel,
  type SidebarBatchUnitLabel,
} from './worktree-count-label';

/** `remove` when the queued batches mix archive and delete. */
export type SidebarBatchRemovalVerb = 'archive' | 'delete' | 'remove';

export interface SidebarBatchRemovalNoticeProps {
  readonly verb: SidebarBatchRemovalVerb;
  /** Names the queued rows; a queue that mixes kinds names them as items. */
  readonly unitLabel: SidebarBatchUnitLabel;
  readonly running: boolean;
  /** Stop was pressed; the in-flight removal still finishes. */
  readonly stopRequested: boolean;
  readonly total: number;
  /** Removed successfully. */
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
  /** Still pending: queued while running, or dropped by Stop once idle. */
  readonly notStarted: number;
  readonly onStop: () => void;
  readonly onShowDetails: () => void;
  readonly onDismiss: () => void;
  readonly testId?: string;
}

const PROGRESSIVE: Readonly<Record<SidebarBatchRemovalVerb, string>> = {
  archive: 'Archiving',
  delete: 'Deleting',
  remove: 'Removing',
};
const PAST: Readonly<Record<SidebarBatchRemovalVerb, string>> = {
  archive: 'Archived',
  delete: 'Deleted',
  remove: 'Removed',
};

/**
 * Bulk removal of sidebar rows (CAN-3975) running in the background: progress with
 * Stop while the queue drains, then what did not finish, with Details.
 * Renders nothing when everything succeeded; the rows leaving is the outcome.
 * Pure display; the rail feeds it the queue's counts.
 */
export function SidebarBatchRemovalNotice({
  verb,
  unitLabel,
  running,
  stopRequested,
  total,
  done,
  failed,
  skipped,
  notStarted,
  onStop,
  onShowDetails,
  onDismiss,
  testId = 'worktree-batch-removal-notice',
}: SidebarBatchRemovalNoticeProps): JSX.Element | null {
  if (running) {
    return (
      <Notice
        data-testid={testId}
        intent="neutral"
        icon={<LoadingSpinner sizePx={14} decorative />}
        role="status"
        title={`${PROGRESSIVE[verb]} ${unitLabel.plural}`}
        actions={
          <NoticeButton
            onClick={onStop}
            disabled={stopRequested}
            data-testid={`${testId}-stop`}
          >
            {stopRequested ? 'Stopping…' : 'Stop'}
          </NoticeButton>
        }
      >
        {done} of {total} done.
      </Notice>
    );
  }
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (notStarted > 0) parts.push(`${notStarted} not started`);
  if (parts.length === 0) return null;
  return (
    <Notice
      data-testid={testId}
      intent="attention"
      role="status"
      title={`${PAST[verb]} ${done} of ${unitCountLabel(unitLabel, total)}`}
      actions={
        <NoticeButton onClick={onShowDetails} data-testid={`${testId}-details`}>
          Details
        </NoticeButton>
      }
      onDismiss={onDismiss}
      dismissTestId={`${testId}-dismiss`}
    >
      {parts.join(', ')}.
    </Notice>
  );
}
