import {
  IPC_CHANNELS,
  type WorktreeDiscardResult,
} from '@canopy/desktop-shared/types';
import { removeCachedWorktreeDiffStats } from '../services/worktree-diff-stats-cache';
import { sendToAllWindows } from './window-send';
import { readWorkspaceWorktrees } from './workspace-persistence';
import { discardWorktree } from './worktree-discard';

/**
 * The discard as a user interface runs it (CAN-5334). IPC and Portal both call
 * this, so a discard has the same effects on either: the discarded
 * incarnation's diff stats are dropped before a same-id worktree can read
 * them, and every window gets the post-discard list.
 */
export async function discardWorktreeFromInterface(
  request: Parameters<typeof discardWorktree>[0],
): Promise<WorktreeDiscardResult> {
  const result = await discardWorktree(request);
  if (result.status !== 'discarded') return result;
  const { workspaceId, worktreeId } = request;
  removeCachedWorktreeDiffStats(workspaceId, worktreeId);
  // Best effort: the discard committed. An id-only event makes the renderer reload.
  const worktrees = await readWorkspaceWorktrees(workspaceId).catch(() => null);
  sendToAllWindows(
    IPC_CHANNELS.workspaceWorktreesUpdated,
    worktrees ? { workspaceId, worktrees } : { workspaceId },
  );
  return result;
}
