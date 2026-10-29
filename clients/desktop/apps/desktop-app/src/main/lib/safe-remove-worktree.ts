import { rm } from 'node:fs/promises';
import { bestEffortPruneWorktrees, removeWorktree } from './git';

export async function safeRemoveWorktree(
  repoPath: string,
  worktreePath: string,
  pruneReason: string,
): Promise<void> {
  try {
    await removeWorktree(repoPath, worktreePath);
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
    bestEffortPruneWorktrees(repoPath, pruneReason);
  }
}
