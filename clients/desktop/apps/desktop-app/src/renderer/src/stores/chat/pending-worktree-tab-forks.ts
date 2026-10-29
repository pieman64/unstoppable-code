const pendingWorktreeTabForks = new Map<string, number>();

function worktreeTabForkKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Suppress starter-tab materialization while a branched worktree's canonical
 * tabs are being replaced with forks of the source worktree's open tabs.
 */
export function beginPendingWorktreeTabFork(
  projectId: string,
  worktreeId: string,
): () => void {
  const key = worktreeTabForkKey(projectId, worktreeId);
  pendingWorktreeTabForks.set(key, (pendingWorktreeTabForks.get(key) ?? 0) + 1);
  let ended = false;
  return (): void => {
    if (ended) return;
    ended = true;
    const remaining = (pendingWorktreeTabForks.get(key) ?? 1) - 1;
    if (remaining <= 0) {
      pendingWorktreeTabForks.delete(key);
    } else {
      pendingWorktreeTabForks.set(key, remaining);
    }
  };
}

export function isWorktreeTabForkPending(
  projectId: string,
  worktreeId: string,
): boolean {
  return pendingWorktreeTabForks.has(worktreeTabForkKey(projectId, worktreeId));
}
