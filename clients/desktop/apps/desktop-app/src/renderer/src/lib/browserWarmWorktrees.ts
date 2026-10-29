// Keep a bounded set of recent worktrees’ browser views alive across switches.

import { useBrowserStore } from '@/stores/browserStore';
import { useChatStore } from '@/stores/chatStore';

const MAX_WARM_WORKTREES = 3;

/** Oldest-left first; keyed by the surface's `${projectId}/${worktreeId}`. */
const warmWorktrees = new Map<
  string,
  { projectId: string; worktreeId: string }
>();
let evictionGeneration = 0;
let evictionQueued = false;

function releaseWarmWorktree(key: string): void {
  const entry = warmWorktrees.get(key);
  if (!entry) return;
  warmWorktrees.delete(key);
  useBrowserStore
    .getState()
    .releaseWorktreeViews(entry.projectId, entry.worktreeId);
}

/** Keeps a just-left worktree's views alive, releasing the oldest beyond the limit. */
export function keepBrowserWorktreeViewsWarm(
  key: string,
  projectId: string,
  worktreeId: string,
): void {
  warmWorktrees.delete(key);
  warmWorktrees.set(key, { projectId, worktreeId });
  if (!evictionQueued) {
    // React can unmount the old surface well before the incoming one mounts.
    // Wait for navigation state to settle, then protect the selected worktree.
    evictionQueued = true;
    const generation = evictionGeneration;
    queueMicrotask(() => {
      if (generation !== evictionGeneration) return;
      evictionQueued = false;
      const selected = useChatStore.getState().selectedWorktree;
      const selectedKey = selected
        ? `${selected.projectId}/${selected.worktreeId}`
        : null;
      for (const oldest of Array.from(warmWorktrees.keys())) {
        if (warmWorktrees.size <= MAX_WARM_WORKTREES) break;
        if (oldest === selectedKey) continue;
        releaseWarmWorktree(oldest);
      }
    });
  }
}

/** A surface for this worktree mounted again; its views are in use. */
export function forgetWarmBrowserWorktree(key: string): void {
  warmWorktrees.delete(key);
}

/** Test-only: forget warm worktrees without releasing their views. */
export function resetWarmBrowserWorktreesForTest(): void {
  warmWorktrees.clear();
  evictionGeneration += 1;
  evictionQueued = false;
}
