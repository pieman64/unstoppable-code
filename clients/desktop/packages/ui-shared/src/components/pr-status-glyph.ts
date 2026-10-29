import {
  CircleCheckIcon,
  CircleXIcon,
  FileDiff,
  GitBranchCompactIcon,
  GitDraftIcon,
  GitMergeConflictIcon,
  GitMergeIcon,
  GitMergeQueueIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from '../icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

/*
 * A pull request's status as the sidebar draws it: one glyph and one ink per
 * state. Shared by the worktree row, its hover card, and the GitHub reference
 * hover card, so every PR reads the same wherever it appears.
 */

export type WorktreePrBadgeCheckStatus =
  | 'passing'
  | 'failing'
  | 'pending'
  | 'neutral'
  | 'none';

/** Normalized GitHub merge queue entry phase for a queued PR. */
export type WorktreeRowMergeQueuePhase =
  | 'queued'
  | 'awaiting_checks'
  | 'mergeable'
  | 'locked'
  | 'unmergeable'
  | 'unknown';

export interface WorktreeRowPrStatus {
  state: 'open' | 'merged' | 'closed' | 'draft';
  /** Collapsed status driving the badge color (pending treated as none). */
  checkStatus?: WorktreePrBadgeCheckStatus;
  reviewStatus?: 'approved' | 'changes_requested' | 'pending' | 'none';
  isMergeReady?: boolean;
  url?: string;
  /** Optional pre-formatted label (e.g. `"PR #1234"` or `"3 PRs"`). */
  label?: string;
  // ---- Rich tooltip fields ----
  /** PR title (single-repo) or summary label (multi-repo). */
  title?: string;
  /** PR description/body (single-repo only). */
  description?: string;
  /** Real aggregated CI status for the tooltip (keeps `pending`). */
  ciStatus?: WorktreePrBadgeCheckStatus;
  /** Unresolved review-thread count; drives the yellow checkmark when > 0. */
  unresolvedCommentCount?: number;
  /** Whether GitHub reports merge conflicts on the PR(s). */
  hasConflicts?: boolean;
  /** Whether the open PR is in its base branch's merge queue. */
  inMergeQueue?: boolean;
  /** 1-based merge queue position, when GitHub reports one. */
  mergeQueuePosition?: number;
  /** Merge queue entry phase, when GitHub reports one for the queued PR. */
  mergeQueuePhase?: WorktreeRowMergeQueuePhase;
}

/** An open PR in its base branch's merge queue. */
export function isPrStatusInMergeQueue(status: WorktreeRowPrStatus): boolean {
  return status.state === 'open' && status.inMergeQueue === true;
}

/** Shared success rule for the sidebar and its PR preview. */
export function prHasSuccessIndicator(
  pr: WorktreeRowPrStatus | undefined,
): boolean {
  const checks = pr?.ciStatus ?? pr?.checkStatus;
  return (
    pr?.state === 'open' &&
    !pr.hasConflicts &&
    !isPrStatusInMergeQueue(pr) &&
    pr.reviewStatus !== 'changes_requested' &&
    checks !== 'pending' &&
    checks !== 'failing' &&
    (checks === 'passing' ||
      pr.reviewStatus === 'approved' ||
      pr.isMergeReady === true)
  );
}

export function prStatusColorClass(
  status: WorktreeRowPrStatus,
  neutralColor: 'fg-secondary' | 'fg-tertiary' = 'fg-secondary',
): string {
  if (status.state === 'merged') return 'fg-purple';
  if (status.state === 'closed' || status.hasConflicts === true) {
    return 'fg-destructive';
  }
  // Queued: GitHub is running the queue's checks, the same pending tint as
  // classic checks-pending.
  if (isPrStatusInMergeQueue(status)) return 'fg-warning';
  if (
    status.checkStatus === 'failing' ||
    status.reviewStatus === 'changes_requested'
  ) {
    return 'fg-destructive';
  }
  return neutralColor;
}

export type WorktreePrIconKind =
  | 'pull-request'
  | 'passing'
  | 'draft'
  | 'merged'
  | 'closed'
  | 'failing'
  | 'merge-conflict'
  | 'merge-queue';

export function prStatusIconKind(
  status: WorktreeRowPrStatus,
): WorktreePrIconKind {
  if (status.hasConflicts === true) return 'merge-conflict';
  if (isPrStatusInMergeQueue(status)) return 'merge-queue';
  if (status.state === 'merged') return 'merged';
  if (status.state === 'closed') return 'closed';
  if (status.state === 'draft') return 'draft';
  if (
    status.checkStatus === 'failing' ||
    status.reviewStatus === 'changes_requested'
  ) {
    return 'failing';
  }
  if (status.checkStatus === 'passing') return 'passing';
  return 'pull-request';
}

export const PR_STATUS_ICONS = {
  'pull-request': GitPullRequestIcon,
  passing: GitBranchCompactIcon,
  draft: GitDraftIcon,
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
  failing: GitPullRequestClosedIcon,
  'merge-conflict': GitMergeConflictIcon,
  'merge-queue': GitMergeQueueIcon,
} satisfies Record<WorktreePrIconKind, typeof GitPullRequestIcon>;

/**
 * The one state a PR card's status line names, most pressing first. Unlike
 * the sidebar glyph it tells every state apart, so the line needs no badge.
 */
export type PrStatusLineKind =
  | 'merge-conflict'
  | 'merge-queue'
  | 'merged'
  | 'closed'
  | 'draft'
  | 'checks-failing'
  | 'changes-requested'
  | 'checks-running'
  | 'checks-passing'
  | 'open';

export function prStatusLineKind(
  status: WorktreeRowPrStatus,
): PrStatusLineKind {
  if (status.hasConflicts === true) return 'merge-conflict';
  if (isPrStatusInMergeQueue(status)) return 'merge-queue';
  if (status.state === 'merged') return 'merged';
  if (status.state === 'closed') return 'closed';
  if (status.state === 'draft') return 'draft';
  if (status.checkStatus === 'failing') return 'checks-failing';
  if (status.reviewStatus === 'changes_requested') return 'changes-requested';
  if (status.checkStatus === 'pending') return 'checks-running';
  if (status.checkStatus === 'passing') return 'checks-passing';
  return 'open';
}

const PENDING_INK = 'fg-warning-strong';

/**
 * Each state's label, glyph and ink. Small text takes the intent's strong
 * ink; `null` glyph is drawn as the running spinner by the caller.
 */
export const PR_STATUS_LINES = {
  'merge-conflict': {
    label: 'Merge conflicts',
    Icon: GitMergeConflictIcon,
    ink: OPERATIONAL_STATUS_COLORS.failed.foreground,
  },
  'merge-queue': {
    label: 'In merge queue',
    Icon: GitMergeQueueIcon,
    ink: PENDING_INK,
  },
  merged: {
    label: 'Merged',
    Icon: GitMergeIcon,
    ink: OPERATIONAL_STATUS_COLORS.merged.foreground,
  },
  closed: {
    label: 'Closed',
    Icon: GitPullRequestClosedIcon,
    ink: OPERATIONAL_STATUS_COLORS.failed.foreground,
  },
  draft: {
    label: 'Draft',
    Icon: GitDraftIcon,
    ink: OPERATIONAL_STATUS_COLORS.paused.foreground,
  },
  'checks-failing': {
    label: 'Checks failing',
    Icon: CircleXIcon,
    ink: OPERATIONAL_STATUS_COLORS.failed.foreground,
  },
  'changes-requested': {
    label: 'Changes requested',
    Icon: FileDiff,
    ink: OPERATIONAL_STATUS_COLORS.failed.foreground,
  },
  'checks-running': { label: 'Checks running', Icon: null, ink: PENDING_INK },
  'checks-passing': {
    label: 'Checks passing',
    Icon: CircleCheckIcon,
    ink: OPERATIONAL_STATUS_COLORS.success.foreground,
  },
  open: {
    label: 'Open',
    Icon: GitPullRequestIcon,
    ink: OPERATIONAL_STATUS_COLORS.paused.foreground,
  },
} satisfies Record<
  PrStatusLineKind,
  { label: string; Icon: typeof GitPullRequestIcon | null; ink: string }
>;
