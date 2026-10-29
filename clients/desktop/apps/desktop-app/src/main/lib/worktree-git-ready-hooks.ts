import type { WorktreeGitReadyEvent } from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from './main-process-logging';

/** A worktree whose checkout became ready, and the kind of its workspace. */
export interface WorktreeGitReadyHookEvent extends WorktreeGitReadyEvent {
  workspaceKind: 'single-repo' | 'multi-repo';
}

type WorktreeGitReadyHook = (
  event: WorktreeGitReadyHookEvent,
) => void | Promise<void>;

const hooks = new Set<WorktreeGitReadyHook>();

/**
 * Main-process subscribers to a worktree checkout becoming ready, whichever
 * caller created it. Returns a function that removes the hook; registering the
 * same hook twice keeps one registration.
 */
export function registerWorktreeGitReadyHook(
  hook: WorktreeGitReadyHook,
): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/** Runs every hook; a hook that throws or rejects never reaches the creator. */
export async function publishWorktreeGitReady(
  event: WorktreeGitReadyHookEvent,
): Promise<void> {
  await Promise.all(
    Array.from(hooks, async (hook) => {
      try {
        await hook(event);
      } catch (error) {
        logMainProcessWarn('Worktree git-ready hook failed', {
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}
