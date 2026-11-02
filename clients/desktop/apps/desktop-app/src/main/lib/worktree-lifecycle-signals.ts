/**
 * Dependency-free signal that persisted worktree membership may have changed
 * (CAN-4899). Main's branch observer subscribes and rereads membership on a
 * debounce. A `worktrees.json` write publishes only when it changes which
 * checkouts the observer watches: the GitHub poller's PR status and the
 * observer's own branch recording change no membership, so they never
 * re-sync it.
 *
 * Git-ready keeps its own hook (`worktree-git-ready-hooks.ts`), which names
 * the worktree whose checkout became ready while its row is still pending.
 */
export type WorktreeLifecycleChange =
  /** A `projects:load` completed; the first one starts enrollment. */
  | 'projects-loaded'
  | 'projects-saved'
  /** A worktree list write added, removed, or finished setting up a row. */
  | 'worktree-list-membership'
  /** An archive or delete settled, whether or not it removed the row. */
  | 'worktree-removal-settled'
  | 'workspace-deleted'
  /** Another writer (the CLI) changed a workspace's worktree list. */
  | 'external-snapshot';

type Listener = (change: WorktreeLifecycleChange) => void;

/** The row fields that decide whether the observer watches a checkout. */
export interface WorktreeMembershipRow {
  id: string;
  setupPhase?: string;
}

const listeners = new Set<Listener>();

export function subscribeWorktreeLifecycleChanges(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** Never throws: a listener failure must not fail the lifecycle step. */
export function publishWorktreeLifecycleChange(
  change: WorktreeLifecycleChange,
): void {
  listeners.forEach((listener): void => {
    try {
      listener(change);
    } catch {
      // Observational only; see the module comment.
    }
  });
}

function membershipKeys(rows: readonly WorktreeMembershipRow[]): Set<string> {
  return new Set(
    rows.map(
      (row) =>
        `${row.id}:${row.setupPhase === 'git-pending' ? 'pending' : 'ready'}`,
    ),
  );
}

/** Publishes `worktree-list-membership` when a list write changes membership. */
export function publishWorktreeListWrite(
  previous: readonly WorktreeMembershipRow[],
  next: readonly WorktreeMembershipRow[],
): void {
  const before = membershipKeys(previous);
  const after = membershipKeys(next);
  if (
    before.size === after.size &&
    Array.from(after).every((key) => before.has(key))
  )
    return;
  publishWorktreeLifecycleChange('worktree-list-membership');
}
