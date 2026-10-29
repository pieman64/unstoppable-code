import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';

export type WorktreeUiStatus =
  | 'idle'
  | 'planning'
  | 'working'
  | 'unread'
  | 'done';

export interface WorktreeStatusInputs {
  /** `worktree.status === 'done'`. */
  isDone: boolean;
  /** Chat unread, pipeline unseen success, or pipeline unseen failure. */
  hasUnread: boolean;
  /** Streaming chat or pipeline running. */
  isWorking: boolean;
  /** Pending plan-approval, or pipeline paused awaiting input. */
  isPlanning: boolean;
}

/**
 * Resolve a worktree's UI status from the four boolean inputs that today drive
 * the list-view dot, badges, and the new kanban grouping.
 *
 * Priority (highest → lowest): done > unread > working > planning > idle.
 */
export function computeWorktreeUiStatus(
  inputs: WorktreeStatusInputs,
): WorktreeUiStatus {
  if (inputs.isDone) return 'done';
  if (inputs.hasUnread) return 'unread';
  if (inputs.isWorking) return 'working';
  if (inputs.isPlanning) return 'planning';
  return 'idle';
}

export interface WorktreeStatusMeta {
  /** Human-readable column header / aria label. */
  label: string;
  /** Tailwind classes for the round status dot in list view. */
  dotClass: string;
  /** Tailwind text-color class for the kanban column accent line and count. */
  columnAccent: string;
}

/**
 * Visual tokens used by both the list-view dot and the kanban column headers.
 * These use the app-wide operational-state palette rather than theme intent
 * roles, so state hues remain consistent across every built-in theme.
 */
export const WORKTREE_STATUS_META: Record<
  WorktreeUiStatus,
  WorktreeStatusMeta
> = {
  idle: {
    label: 'Idle',
    dotClass: 'border-fg-secondary/60 bg-fg-secondary/15',
    columnAccent: 'fg-secondary',
  },
  planning: {
    label: 'Planning',
    dotClass: `${OPERATIONAL_STATUS_COLORS.unread.border} ${OPERATIONAL_STATUS_COLORS.unread.backgroundMuted}`,
    columnAccent: OPERATIONAL_STATUS_COLORS.unread.foreground,
  },
  working: {
    label: 'Working',
    dotClass: `${OPERATIONAL_STATUS_COLORS.active.border} ${OPERATIONAL_STATUS_COLORS.active.backgroundMuted}`,
    columnAccent: OPERATIONAL_STATUS_COLORS.active.foreground,
  },
  unread: {
    label: 'Unread',
    dotClass: `${OPERATIONAL_STATUS_COLORS.unread.border} ${OPERATIONAL_STATUS_COLORS.unread.backgroundMuted}`,
    columnAccent: OPERATIONAL_STATUS_COLORS.unread.foreground,
  },
  done: {
    label: 'Done',
    // The done dot is rendered as a checkmark glyph rather than a circle.
    dotClass: `${OPERATIONAL_STATUS_COLORS.success.border} ${OPERATIONAL_STATUS_COLORS.success.backgroundMuted}`,
    columnAccent: OPERATIONAL_STATUS_COLORS.success.foreground,
  },
};

export const WORKTREE_UI_STATUSES: readonly WorktreeUiStatus[] = [
  'idle',
  'planning',
  'working',
  'unread',
  'done',
];
