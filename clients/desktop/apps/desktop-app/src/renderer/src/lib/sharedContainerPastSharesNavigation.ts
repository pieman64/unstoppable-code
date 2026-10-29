/**
 * Surface routing for the recipient's Past shares page (CAN-4052), shared by
 * the sidebar row and the page so both use the same store/navigation flow.
 *
 * The page overlays `WorktreeManager` on the main page, in the same slot as
 * the "Archived and deleted" overview and the shared-container viewer, so
 * opening it closes those first.
 */
import type { SharedContainerListEntry } from '@/stores/sharedContainerReplicasStore';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';

export function openPastSharesSurface(): void {
  const archived = useArchivedContainersStore.getState();
  archived.closeViewer();
  archived.closeOverview();
  const shared = useSharedContainerReplicasStore.getState();
  shared.closeViewer();
  useNavigationStore.getState().navigate('main');
  shared.openPastShares();
}

/**
 * Opens an accepted share in the viewer, from its sidebar row or its Past
 * shares row. Closes every other page-like overlay, the Past shares page
 * included.
 */
export function openAcceptedSharedContainer(
  entry: SharedContainerListEntry,
): void {
  // The destination is this viewer, so it must stay mounted: closing it
  // erases the state `openContainer`'s already-mounted guard reads, and
  // re-clicking the share on screen would re-open it from `loading`.
  dismissPageLikeViewers({ keepSharedContainerViewer: true });
  useNavigationStore.getState().navigate('main');
  void useSharedContainerReplicasStore.getState().openContainer({
    containerId: entry.container.id,
    ...(entry.organizationId ? { organizationId: entry.organizationId } : {}),
    ...(entry.access ? { access: entry.access } : {}),
  });
}
