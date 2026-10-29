import { useEffect } from 'react';
import type { CodeGraphBuildStatusChangedEvent } from '@canopy/desktop-shared/types';
import { useCodeGraphBuildStore } from '@/stores/codeGraphBuildStore';

/**
 * Subscribes to `codeGraphBuildStatusChanged` IPC events and routes them into
 * `codeGraphBuildStore`. Mirrors `useScriptEventSubscriptions` in shape but
 * intentionally does NOT gate on a "loaded worktree" set — the worktree row
 * badge must light up for any worktree, not just the currently selected one.
 * Mount once, beside `useScriptEventSubscriptions()`.
 */
export function useCodeGraphBuildEventSubscriptions(): void {
  useEffect(() => {
    const unsubscribe = window.api.onCodeGraphBuildStatusChanged(
      (event: CodeGraphBuildStatusChangedEvent) => {
        useCodeGraphBuildStore
          .getState()
          .setBuilding(
            event.projectId,
            event.worktreeId,
            event.status === 'building',
          );
      },
    );
    return unsubscribe;
  }, []);
}
