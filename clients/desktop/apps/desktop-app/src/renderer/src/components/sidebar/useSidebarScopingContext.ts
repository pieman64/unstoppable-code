import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import type { WorkspaceContext } from '@canopy/desktop-shared/types';
import { useCanopyOrgProjectsEnabled } from '@/hooks/useCanopyOrgProjectsEnabled';
import {
  useWorkspaceContext,
  useWorkspaceContextStore,
} from '@/stores/workspaceContextStore';

/** Preserve the existing list until organization scoping is enabled and hydrated. */
export function useSidebarScopingContext(): WorkspaceContext | undefined {
  const enabled = useCanopyOrgProjectsEnabled();
  const context = useWorkspaceContext();
  const hydrated = useWorkspaceContextStore((state) => state.hydrated);
  return enabled && hydrated ? context : undefined;
}

/** Read the same scoping rule outside React, including during page cleanup. */
export function getSidebarScopingContext(): WorkspaceContext | undefined {
  const enabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key);
  const { state, hydrated } = useWorkspaceContextStore.getState();
  return enabled && hydrated ? state.context : undefined;
}
