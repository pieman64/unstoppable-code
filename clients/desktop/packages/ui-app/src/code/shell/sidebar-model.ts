import { deriveTerminalPrBadgeStatus } from '@canopy/ui-shared/lib/worktree-pr-status';
import type {
  WorkspaceKind,
  WorktreePrBadgeCheckStatus,
  WorktreeRowPrStatus,
} from '@canopy/ui-shared/components';
import {
  compareWorktrees,
  isTreeLayout,
  orderedWorkspaces,
  type SidebarWorkspace,
  type SnapshotWorktree,
} from './worktree-status';
import type { WorkspaceVisibilitySnapshot } from './worktree-status';
import {
  orderSidebarRows,
  toRecencyMs,
  type SidebarSortMode,
} from './sidebar/sidebar-ordering';

type GroupableWorktree = SnapshotWorktree & {
  readonly branchGroupingParentWorktreeId?: string;
  readonly pinned?: boolean;
};

/**
 * Orders roots and siblings by the section's mode, then keeps each known
 * branch-stack child attached to its parent.
 */
export function orderWorktreesForSidebar<T extends GroupableWorktree>(
  worktrees: readonly T[],
  mode: SidebarSortMode = 'manual',
): T[] {
  const matching = orderSidebarRows(worktrees.slice().sort(compareWorktrees), {
    mode,
    isPinned: (worktree) => worktree.pinned === true,
    recencyMs: (worktree) =>
      toRecencyMs(worktree.lastActivityAt) ?? toRecencyMs(worktree.createdAt),
  });
  const byId = new Map(
    matching.map((worktree) => [worktree.localId, worktree]),
  );
  // Pinning is section-scoped: a pinned row leads the section, so it and
  // every row beneath a pinned ancestor stay out of the nesting (desktop's
  // rule), while the depth badges keep the true structure.
  const hasPinnedAncestor = (worktree: T): boolean => {
    const visited = new Set<string>();
    let parentId = worktree.branchGroupingParentWorktreeId;
    while (parentId && !visited.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent) return false;
      if (parent.pinned === true) return true;
      visited.add(parentId);
      parentId = parent.branchGroupingParentWorktreeId;
    }
    return false;
  };
  // Desktop groups every descendant under its TOP-MOST ancestor, keeping the
  // descendants in their own order (a grandchild does not jump ahead of its
  // parent's later sibling); this mirrors the legacy `computeWorktreeGroups`
  // attachment-root buckets rather than a depth-first walk. Hosts insert new
  // worktrees at the top of the manual order, so each bucket is then stably
  // sorted by depth: a parent always renders above its descendants.
  const rootAndDepthOf = (
    worktree: T,
  ): { root: string; depth: number } | null => {
    if (worktree.pinned === true || hasPinnedAncestor(worktree)) return null;
    const visited = new Set<string>([worktree.localId]);
    let current = worktree;
    let root: string | null = null;
    let depth = 0;
    for (;;) {
      const parentId = current.branchGroupingParentWorktreeId;
      if (!parentId || visited.has(parentId)) break;
      const parent = byId.get(parentId);
      if (!parent) break;
      visited.add(parentId);
      root = parentId;
      depth += 1;
      current = parent;
    }
    return root === null ? null : { root, depth };
  };
  const childrenByRoot = new Map<string, T[]>();
  const depthById = new Map<string, number>();
  const childIds = new Set<string>();
  for (const worktree of matching) {
    const placement = rootAndDepthOf(worktree);
    if (!placement) continue;
    const children = childrenByRoot.get(placement.root) ?? [];
    children.push(worktree);
    childrenByRoot.set(placement.root, children);
    depthById.set(worktree.localId, placement.depth);
    childIds.add(worktree.localId);
  }
  childrenByRoot.forEach((children) => {
    children.sort(
      (left, right) =>
        (depthById.get(left.localId) ?? 0) -
        (depthById.get(right.localId) ?? 0),
    );
  });
  const ordered: T[] = [];
  const emitted = new Set<string>();
  const emit = (worktree: T): void => {
    if (emitted.has(worktree.localId)) return;
    emitted.add(worktree.localId);
    ordered.push(worktree);
    for (const child of childrenByRoot.get(worktree.localId) ?? []) {
      emit(child);
    }
  };
  for (const worktree of matching) {
    if (!childIds.has(worktree.localId)) emit(worktree);
  }
  for (const worktree of matching) emit(worktree);
  return ordered;
}

const WORKSPACE_COLORS = [
  '#3DA13D',
  '#479FFA',
  '#D2D714',
  '#D84F68',
  '#8AD87E',
  '#A78BFA',
  '#FB7185',
  '#22D3EE',
];
const TEMPORARY_WORKSPACE_COLOR = '#8A8F98';
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * The colour a project's badge paints with: its stored colour, else one
 * derived from its id, so every surface that shows the project's badge (the
 * sidebar header, a worktree top bar) agrees on it.
 */
export function workspaceColor(
  workspace: Pick<SidebarWorkspace, 'localId' | 'color' | 'temporary'>,
): string {
  if (workspace.temporary === true) return TEMPORARY_WORKSPACE_COLOR;
  if (workspace.color && HEX_COLOR_PATTERN.test(workspace.color)) {
    return workspace.color;
  }
  let hash = 0;
  for (let index = 0; index < workspace.localId.length; index += 1) {
    hash = (hash * 31 + workspace.localId.charCodeAt(index)) | 0;
  }
  return (
    WORKSPACE_COLORS[Math.abs(hash) % WORKSPACE_COLORS.length] ?? '#3DA13D'
  );
}

/**
 * The workspace's CLASSIFICATION, for the kind badge. Follows `type` and
 * nothing else — a cloud workspace is repoless and so reports `'cowork'`, with
 * no `backend` special-case (REG-2819). Placement is a separate axis; see
 * `workspaceLayout`.
 */
export function workspaceKind(workspace: SidebarWorkspace): WorkspaceKind {
  if (workspace.type === 'multi-repo') return 'multi-repo';
  if (workspace.type === 'single-repo') return 'single-repo';
  if (workspace.type === 'cowork') return 'cowork';
  return workspace.repos && workspace.repos.length > 1
    ? 'multi-repo'
    : 'single-repo';
}

export function visibleWorkspaceCount(
  snapshot: WorkspaceVisibilitySnapshot,
): number {
  return orderedWorkspaces(snapshot).filter(isTreeLayout).length;
}

export function firstVisibleWorkspaceId(
  snapshot: WorkspaceVisibilitySnapshot,
): string | undefined {
  return orderedWorkspaces(snapshot).find(isTreeLayout)?.localId;
}

export function hasAllKnownPrsMerged(
  status: SnapshotWorktree['lastKnownPrStatus'],
): boolean {
  if (!status) return false;
  const reposWithPrs = status.repos.filter((repo) => repo.status !== null);
  return (
    reposWithPrs.length > 0 &&
    reposWithPrs.every((repo) => repo.status?.state === 'merged')
  );
}

type RepoPrStatus = NonNullable<
  NonNullable<SnapshotWorktree['lastKnownPrStatus']>['repos'][number]['status']
>;

function aggregateCheckStatus(
  statuses: WorktreePrBadgeCheckStatus[],
): WorktreePrBadgeCheckStatus {
  if (statuses.includes('failing')) return 'failing';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('passing')) return 'passing';
  if (statuses.includes('neutral')) return 'neutral';
  return 'none';
}

function isInMergeQueue(status: RepoPrStatus): boolean {
  return status.state === 'open' && status.mergeQueue?.inQueue === true;
}

function isMergeReady(status: RepoPrStatus): boolean {
  return (
    status.state === 'open' &&
    !status.hasConflicts &&
    // A queued PR has nothing left to merge or enqueue.
    !isInMergeQueue(status) &&
    status.reviewStatus === 'approved' &&
    status.checkStatus === 'passing'
  );
}

export function derivePrBadgeStatus(
  status: SnapshotWorktree['lastKnownPrStatus'],
): WorktreeRowPrStatus | undefined {
  if (!status) return undefined;
  const openRepos = status.repos.filter(
    (repo): repo is typeof repo & { status: RepoPrStatus } =>
      repo.status !== null &&
      (repo.status.state === 'open' || repo.status.state === 'draft'),
  );
  if (openRepos.length === 0)
    return deriveTerminalPrBadgeStatus(
      status.repos.map((repo) => repo.status),
      status.repos.length > 1,
    );
  const checks = openRepos.map((repo) => repo.status.checkStatus);
  // Preserve the legacy portal contract: the compact check badge only exposes
  // actionable passing/failing states, while ciStatus retains pending/neutral
  // for the richer status presentation.
  const effectiveCheckStatus: WorktreePrBadgeCheckStatus = checks.includes(
    'failing',
  )
    ? 'failing'
    : checks.includes('passing')
      ? 'passing'
      : 'none';
  const unresolvedCommentCount = openRepos.reduce(
    (sum, repo) => sum + (repo.status.unresolvedReviewThreadCount ?? 0),
    0,
  );
  const hasConflicts = openRepos.some((repo) => repo.status.hasConflicts);
  if (status.repos.length > 1) {
    const label = `${openRepos.length} ${openRepos.length === 1 ? 'PR' : 'PRs'}`;
    return {
      state: openRepos[0].status.state,
      checkStatus: effectiveCheckStatus,
      ...(openRepos.some(
        (repo) => repo.status.reviewStatus === 'changes_requested',
      )
        ? { reviewStatus: 'changes_requested' as const }
        : openRepos.every((repo) => repo.status.reviewStatus === 'approved')
          ? { reviewStatus: 'approved' as const }
          : {}),
      isMergeReady: openRepos.every((repo) => isMergeReady(repo.status)),
      label,
      title: label,
      ciStatus: aggregateCheckStatus(checks),
      unresolvedCommentCount,
      hasConflicts,
      // The row reads "in merge queue" only when every open PR is queued.
      // Position and phase are per-PR, so the summary never carries them.
      ...(openRepos.every((repo) => isInMergeQueue(repo.status))
        ? { inMergeQueue: true }
        : {}),
    };
  }
  const first = openRepos[0].status;
  return {
    state: first.state,
    checkStatus: effectiveCheckStatus,
    reviewStatus: first.reviewStatus,
    isMergeReady: isMergeReady(first),
    url: first.prUrl,
    label: `PR #${first.prNumber}`,
    title: first.title,
    ciStatus: aggregateCheckStatus(checks),
    unresolvedCommentCount: first.unresolvedReviewThreadCount ?? 0,
    hasConflicts,
    ...(isInMergeQueue(first)
      ? {
          inMergeQueue: true,
          ...(typeof first.mergeQueue?.position === 'number'
            ? { mergeQueuePosition: first.mergeQueue.position }
            : {}),
          ...(first.mergeQueue?.phase
            ? { mergeQueuePhase: first.mergeQueue.phase }
            : {}),
        }
      : {}),
  };
}
