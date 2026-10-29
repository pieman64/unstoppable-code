import type { SharedContainerRef } from '@canopy/protocol/shared-containers';
import { isSameWorkspaceContext } from '@canopy/protocol/workspace-context';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { sharedContainerHomeContext } from '@/lib/shared-containers/home-context';
import { useNavigationStore } from '@/stores/navigationStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

let openGeneration = 0;

export interface OpenSharedContainerInOwningContextOptions {
  /** Claims a link, returns existing access, or supplies a listed entry. */
  readonly resolveAccess: () => Promise<SharedContainerRef>;
  /** Accept records device consent; open is for an already accepted share. */
  readonly mode: 'accept' | 'open';
}

/**
 * Resolve the authoritative access path, enter the share's home context, then
 * open the viewer. The home of an accepted share is the context it was
 * accepted in (its acceptance record); a share with no record follows the
 * access path. The access path itself is still what main receives. Account
 * changes and competing opens invalidate the whole operation after every await
 * so stale work cannot reopen another account's share.
 */
export async function openSharedContainerInOwningContext({
  resolveAccess,
  mode,
}: OpenSharedContainerInOwningContextOptions): Promise<void> {
  const ticket = ++openGeneration;
  const initialContextState = useWorkspaceContextStore.getState();
  const accountEpoch = initialContextState.accountEpoch;
  let contextGeneration = initialContextState.appliedGeneration;
  const isOpenCurrent = (): boolean =>
    ticket === openGeneration &&
    useWorkspaceContextStore.getState().accountEpoch === accountEpoch;
  const isCurrent = (): boolean =>
    isOpenCurrent() &&
    useWorkspaceContextStore.getState().appliedGeneration === contextGeneration;
  const assertOpenCurrent = (): void => {
    if (!isOpenCurrent()) {
      throw new Error('The account changed while opening the shared project.');
    }
  };
  const assertCurrent = (): void => {
    assertOpenCurrent();
    if (!isCurrent()) {
      throw new Error(
        'The workspace context changed while opening the shared project.',
      );
    }
  };

  const ref = await resolveAccess();
  assertCurrent();

  if (mode === 'accept') {
    // Acceptance first, as the organization sync does. Claiming a link records
    // the acceptance in main, so main can hold a record this store has not
    // read, and that record decides the context entered below. A plain open
    // starts from a share the store already lists as accepted.
    await useSharedContainerReplicasStore.getState().loadAccepted();
    assertCurrent();
    // A failed read leaves no records, and the listing would then choose the
    // context. Stop here so the caller can retry instead.
    if (useSharedContainerReplicasStore.getState().acceptedStatus === 'error') {
      throw new Error('The accepted shared projects could not be read.');
    }
  }

  await useSharedContainerReplicasStore.getState().loadSharedWithMe();
  assertCurrent();

  // Read after both settled, so the record and the row agree.
  const listedState = useSharedContainerReplicasStore.getState();
  const listed = listedState.entries.find(
    (entry) => entry.container.id === ref.id,
  );
  const organizationId = listed ? listed.organizationId : ref.organizationId;
  const access = listed?.access ?? ref.access ?? 'organization';
  const { state: contextState, hydrated } = useWorkspaceContextStore.getState();
  const targetContext = sharedContainerHomeContext(
    { access, organizationId },
    listedState.acceptedRecords[ref.id],
    // Memberships that have not loaded are not "no memberships".
    hydrated ? contextState.organizations : undefined,
  );
  if (targetContext === null) {
    throw new Error('The shared container has no owning organization.');
  }
  const currentContext = getSidebarScopingContext();
  if (
    currentContext !== undefined &&
    !isSameWorkspaceContext(currentContext, targetContext)
  ) {
    await useWorkspaceContextStore.getState().setContext(targetContext);
    assertOpenCurrent();
    const switchedContextState = useWorkspaceContextStore.getState();
    if (
      !isSameWorkspaceContext(switchedContextState.state.context, targetContext)
    ) {
      throw new Error(
        'The workspace context changed while opening the shared project.',
      );
    }
    // The successful switch can apply its own broadcast. Adopt only that
    // generation; any later user or membership change invalidates the open.
    contextGeneration = switchedContextState.appliedGeneration;
  }

  dismissPageLikeViewers({ keepSharedContainerViewer: true });
  useNavigationStore.getState().navigate('main');
  const entry = {
    containerId: ref.id,
    ...(organizationId ? { organizationId } : {}),
    access,
  };
  const replicas = useSharedContainerReplicasStore.getState();
  // Accept mode goes through main even for an already accepted share. Main
  // keeps the record it has, so this cannot move the share, and it is the one
  // place that drops run consent when the owner identity changed.
  if (mode === 'accept') {
    await replicas.acceptContainer({ ...entry, shouldOpen: isCurrent });
  } else {
    await replicas.openContainer(entry);
  }
  assertCurrent();
  const viewer = useSharedContainerReplicasStore.getState().viewer;
  if (
    viewer?.containerId !== ref.id ||
    viewer.organizationId !== organizationId ||
    viewer.access !== access ||
    viewer.replica === null ||
    viewer.loading ||
    viewer.openError !== null
  ) {
    throw new Error('The shared project could not be opened.');
  }
}
