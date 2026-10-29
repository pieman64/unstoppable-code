import {
  ensureLabsExperimentsSubscription,
  subscribeLabsFeature,
} from '@/stores/labsExperimentsStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import { isWorkspaceLayoutModeTransitionPending } from './workspace-layout-mode-actions';
import { refreshLiveMinimalLayout } from './persistence-bridge';

let unsubscribe: (() => void) | null = null;

/**
 * Turning early access off gives every Minimal worktree open in this window
 * back what Minimal holds without it (see {@link refreshLiveMinimalLayout}).
 *
 * Nothing else follows the toggle: turning early access on or off never
 * changes a worktree's mode or re-shapes a layout the user already has. Each
 * worktree keeps its own saved mode. Idempotent.
 */
export function ensureEarlyAccessMinimalSync(): void {
  if (unsubscribe !== null) return;
  ensureLabsExperimentsSubscription();
  unsubscribe = subscribeLabsFeature('minimal-layout', (enabled, previous) => {
    if (!previous || enabled) return;
    const { entries } = useWorkspaceLayoutModeStore.getState();
    for (const [worktreeKey, entry] of Object.entries(entries)) {
      // A worktree mid-switch commits its own layout; a loading one builds
      // its layout from the new value itself.
      if (
        entry.status === 'ready' &&
        !isWorkspaceLayoutModeTransitionPending(worktreeKey)
      ) {
        refreshLiveMinimalLayout(worktreeKey);
      }
    }
  });
}

/** Test-only: stop following early access changes. */
export function resetEarlyAccessMinimalSyncForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
}
