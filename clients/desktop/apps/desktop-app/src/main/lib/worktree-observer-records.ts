import type { WorktreeChatBadgesSummary } from '@canopy/desktop-shared/types';
import { validateId } from './validation';
import { isWorkEntryWorkspace } from './workspace-registry';
import {
  applyWorktreeListDecision,
  applyWorktreeRowDecision,
} from './worktree-record-decision-port';
import type {
  WorktreeActivityRecordOutcome,
  WorktreeChatBadgesRecordOutcome,
  WorktreeChatBadgesSource,
} from './worktree-record-decisions';

export {
  CHAT_BADGES_SUMMARY_VERSION,
  chatBadgesSummariesEquivalent,
} from './worktree-record-decision-apply';
export type {
  WorktreeActivityRecordOutcome,
  WorktreeChatBadgesRecordOutcome,
  WorktreeChatBadgesSource,
} from './worktree-record-decisions';

/**
 * An activity record, by caller. A watermark advances one row; the Auto
 * Delete baseline advances every row of the workspace when Auto Delete is
 * first enabled, so activity that predates tracking is not archived at once.
 */
export type WorktreeActivityRecordRequest =
  | {
      source: 'activity_watermark';
      workspaceId: string;
      worktreeId: string;
      /** An ISO timestamp. */
      touchedAt: string;
    }
  | {
      source: 'auto_delete_baseline';
      workspaceId: string;
      /** An ISO timestamp. */
      touchedAt: string;
    };

export interface WorktreeChatBadgesRecordRequest {
  source: WorktreeChatBadgesSource;
  workspaceId: string;
  worktreeId: string;
  summary: WorktreeChatBadgesSummary;
}

export type WorktreeObserverRecordRefusal =
  | 'work-entry-workspace'
  | 'invalid-timestamp';

/** An observer record was refused before the worktree list was read. */
export class WorktreeObserverRecordRefusedError extends Error {
  constructor(
    readonly reason: WorktreeObserverRecordRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeObserverRecordRefusedError';
  }
}

/**
 * Cowork and app-managed projects keep activity and chats in Work Entries,
 * not a worktree list, so no observer record may create one for them.
 */
function admitWorkspace(workspaceId: string): void {
  validateId(workspaceId, 'workspaceId');
  if (isWorkEntryWorkspace(workspaceId)) {
    throw new WorktreeObserverRecordRefusedError(
      'work-entry-workspace',
      `Project ${workspaceId} has no worktree list.`,
    );
  }
}

/** The timestamp normalized to ISO. */
function admitTimestamp(touchedAt: string): string {
  const time = Date.parse(touchedAt);
  if (!Number.isFinite(time)) {
    throw new WorktreeObserverRecordRefusedError(
      'invalid-timestamp',
      'Invalid workspace activity timestamp',
    );
  }
  return new Date(time).toISOString();
}

/**
 * `internal.worktree.activity.record` (CAN-3821): the typed in-process
 * command behind every worktree activity watermark. It never moves
 * `lastTouchedAt` backward, so a late or reordered touch is a no-op, and it
 * never creates a list or row for an unknown worktree. One locked read and at
 * most one write of the worktree list, the same as the observer did before;
 * the per-target coalescing stays in `workspace-activity.ts`. It takes no
 * client revision (D9) and makes no idempotency guarantee.
 */
export async function recordWorktreeActivity(
  request: WorktreeActivityRecordRequest,
): Promise<WorktreeActivityRecordOutcome> {
  admitWorkspace(request.workspaceId);
  if (request.source === 'activity_watermark') {
    validateId(request.worktreeId, 'worktreeId');
  }
  const touchedAt = admitTimestamp(request.touchedAt);

  if (request.source === 'auto_delete_baseline') {
    return applyWorktreeListDecision(request.workspaceId, {
      kind: 'activity.auto-delete-baseline',
      touchedAt,
    });
  }
  return applyWorktreeRowDecision(
    { workspaceId: request.workspaceId, worktreeId: request.worktreeId },
    { kind: 'activity.watermark', touchedAt },
  );
}

/**
 * `internal.worktree.chatBadges.record` (CAN-3821): the typed in-process
 * command that persists a worktree's chat badge summary. It never creates a
 * list or row for an unknown worktree, and writes nothing when the stored
 * summary already matches. It takes no client revision (D9) and makes no
 * idempotency guarantee.
 */
export async function recordWorktreeChatBadges(
  request: WorktreeChatBadgesRecordRequest,
): Promise<WorktreeChatBadgesRecordOutcome> {
  admitWorkspace(request.workspaceId);
  validateId(request.worktreeId, 'worktreeId');

  return applyWorktreeRowDecision(
    { workspaceId: request.workspaceId, worktreeId: request.worktreeId },
    { kind: 'chatBadges', source: request.source, summary: request.summary },
  );
}
