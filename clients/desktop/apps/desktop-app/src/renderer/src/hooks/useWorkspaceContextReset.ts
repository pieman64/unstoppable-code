import { useEffect, useRef } from 'react';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/**
 * Run `reset` whenever a Personal/organization context change is applied
 * (a switch in any window, an account change, or a membership update), so a
 * page's local selection or detail state from the previous context does not
 * survive the switch (CAN-3461). Inert while org projects are off, so the
 * legacy behavior is unchanged.
 */
export function useWorkspaceContextReset(reset: () => void): void {
  const scoped = useSidebarScopingContext() !== undefined;
  const generation = useWorkspaceContextStore(
    (state) => state.appliedGeneration,
  );
  const seenGeneration = useRef(generation);
  useEffect(() => {
    if (seenGeneration.current === generation) return;
    seenGeneration.current = generation;
    if (scoped) reset();
    // Fires only for a new generation; `reset` is a fresh closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);
}
