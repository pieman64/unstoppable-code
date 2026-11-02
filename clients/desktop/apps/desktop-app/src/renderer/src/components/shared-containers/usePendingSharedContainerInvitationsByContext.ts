import { useMemo } from 'react';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { useSharedContainerEntryPointVisible } from '@/hooks/useSharedContainerEntryPointVisible';
import { pendingInvitationsByContext } from '@/lib/shared-containers/pending-invitations-by-context';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/** Never mutated; one identity so an idle switcher does not re-render. */
const NO_PENDING_INVITATIONS: ReadonlyMap<string, number> = new Map();

/**
 * Pending share invitations per home context (CAN-4783), for the context
 * switcher's dots. Reads the same listing, acceptances and homing the
 * Shared with you section does, so the switcher points at exactly the
 * invitations the destination context will list. Empty while sharing is
 * hidden or context scoping is not on and hydrated. Reads only: the existing
 * inbox refresh keeps the listing current.
 */
export function usePendingSharedContainerInvitationsByContext(): ReadonlyMap<
  string,
  number
> {
  const entries = useSharedContainerReplicasStore((state) => state.entries);
  const acceptedIds = useSharedContainerReplicasStore(
    (state) => state.acceptedIds,
  );
  const acceptedRecords = useSharedContainerReplicasStore(
    (state) => state.acceptedRecords,
  );
  // As the section reads them: memberships that have not loaded are
  // `undefined`, not none.
  const organizations = useWorkspaceContextStore((store) =>
    store.hydrated ? store.state.organizations : undefined,
  );
  const entryPointVisible = useSharedContainerEntryPointVisible();
  const scoped = useSidebarScopingContext() !== undefined;
  return useMemo(
    () =>
      entryPointVisible && scoped
        ? pendingInvitationsByContext(
            entries,
            acceptedIds,
            acceptedRecords,
            organizations,
          )
        : NO_PENDING_INVITATIONS,
    [
      entryPointVisible,
      scoped,
      entries,
      acceptedIds,
      acceptedRecords,
      organizations,
    ],
  );
}
