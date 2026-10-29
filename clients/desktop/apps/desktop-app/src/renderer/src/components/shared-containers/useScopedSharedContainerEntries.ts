/**
 * The received shares the active workspace context lists (CAN-2954), split
 * the way the recipient surfaces show them. One source for the sidebar
 * section and the Past shares page, so the page's rows and the sidebar row's
 * count cannot disagree about which context a share belongs to.
 */
import {
  isSameWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { sharedContainerHomeContext } from '@/lib/shared-containers/home-context';
import { sharedContainerCanView } from '@/lib/shared-containers/panel-allowlist';
import {
  useSharedContainerReplicasStore,
  type SharedContainerListEntry,
  type SharedContainerRemovedEntry,
} from '@/stores/sharedContainerReplicasStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

export interface ScopedSharedContainerEntries {
  /** `undefined` while the section keeps today's unscoped list. */
  scopingContext: WorkspaceContext | undefined;
  /** Invitations and accepted shares the context lists. */
  viewableEntries: SharedContainerListEntry[];
  invitations: SharedContainerListEntry[];
  acceptedEntries: SharedContainerListEntry[];
  /** Removed shares the context lists; empty when the server keeps none. */
  removedEntries: SharedContainerRemovedEntry[];
  /** The context that lists a share; `null` when no context does. */
  homeOf: (entry: SharedContainerListEntry) => WorkspaceContext | null;
}

export function useScopedSharedContainerEntries(): ScopedSharedContainerEntries {
  const entries = useSharedContainerReplicasStore((state) => state.entries);
  const acceptedIds = useSharedContainerReplicasStore(
    (state) => state.acceptedIds,
  );
  const acceptedRecords = useSharedContainerReplicasStore(
    (state) => state.acceptedRecords,
  );
  const removed = useSharedContainerReplicasStore(
    (state) => state.removedEntries,
  );
  const removedSupported = useSharedContainerReplicasStore(
    (state) => state.removedStatus !== 'unsupported',
  );
  // Memberships that have not loaded are not "no memberships": `undefined`
  // keeps an accepted share where its record says until they arrive.
  const organizations = useWorkspaceContextStore((store) =>
    store.hydrated ? store.state.organizations : undefined,
  );
  // Context scoping (CAN-2954): each share is listed in one home context. An
  // invitation follows the listing: an organization share is listed under the
  // organization that shared it, and a direct share (by email, or from outside
  // this account's organizations) belongs to no organization context of the
  // recipient's, so it is listed under Personal. An accepted share stays in
  // the context it was accepted in, named by its acceptance record, however a
  // later listing round classifies it. A removed share has no record and
  // follows its listing, like the invitation it would be restored as. Same
  // gate as the Projects list: only once the org-projects flag is on and the
  // context store has hydrated; until then the section keeps today's
  // unscoped list.
  const scopingContext = useSidebarScopingContext();
  const homeOf = (entry: SharedContainerListEntry): WorkspaceContext | null =>
    sharedContainerHomeContext(
      entry,
      acceptedRecords[entry.container.id],
      organizations,
    );
  const listedHere = (entry: SharedContainerListEntry): boolean => {
    if (!sharedContainerCanView(entry.container.capabilities)) return false;
    if (scopingContext === undefined) return true;
    const home = homeOf(entry);
    return home !== null && isSameWorkspaceContext(scopingContext, home);
  };
  const viewableEntries = entries.filter(listedHere);
  return {
    scopingContext,
    viewableEntries,
    // Invitations sort above accepted shares: they are the only rows that
    // need a decision, and an accepted share is already reachable from
    // wherever it was last opened.
    invitations: viewableEntries.filter(
      (entry) => !acceptedIds.includes(entry.container.id),
    ),
    acceptedEntries: viewableEntries.filter((entry) =>
      acceptedIds.includes(entry.container.id),
    ),
    removedEntries: removedSupported ? removed.filter(listedHere) : [],
    homeOf,
  };
}
