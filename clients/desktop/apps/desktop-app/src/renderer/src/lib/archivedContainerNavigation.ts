/**
 * Surface-routing helpers for archived containers (the "Archived and
 * deleted" overview page and the per-container viewer), shared by the
 * sidebar links, Cmd+K navigation, the archived-container viewer, and the
 * App Advisor action dispatcher so every entry point uses the exact same
 * store/navigation flow:
 *
 * - Code workspaces: the overview/viewer overlay `WorktreeManager` on the
 *   main page (the left nav stays visible).
 * - Cowork: the overview/viewer render in the chat page's shared archive
 *   overlay.
 * - App Advisor: the popout's shared overlay renders them.
 */
import type {
  ArchivedContainerRestoreResponse,
  ArchivedContainerViewerTab,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useChatStore } from '@/stores/chatStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';

/** Open the archived-container viewer on the surface owning `workspaceId`. */
export function openArchivedContainerSurface(
  workspaceId: string,
  containerId: string,
  options?: {
    tab?: ArchivedContainerViewerTab;
    chatId?: string;
    planId?: string;
  },
): void {
  const { openViewer } = useArchivedContainersStore.getState();
  // The container viewer and the legacy single-chat archive overlay share the
  // cowork surface; close the legacy overlay so it cannot cover the viewer.
  useStandaloneChatStore.getState().closeArchiveOverlay();
  useSharedContainerReplicasStore.getState().closeViewer();
  useSharedContainerReplicasStore.getState().closePastShares();
  if (workspaceId === APP_ADVISOR_PROJECT_ID) {
    // The App Advisor viewer renders in the popout window, whose renderer has
    // its OWN store instances — route the open through the window-open
    // request so the popout's store receives it, never the local one.
    useNavigationStore.getState().openAppAdvisor({
      archivedContainer: { containerId, ...options },
    });
    return;
  }
  if (isCoworkChatTarget(workspaceId)) {
    openViewer(workspaceId, containerId, options);
    useNavigationStore.getState().navigate('chat');
    return;
  }
  useNavigationStore.getState().navigate('main');
  openViewer(workspaceId, containerId, options);
}

/**
 * Open the workspace-scoped "Archived and deleted" overview page on the
 * surface owning `workspaceId`. The App Advisor branch mutates the local
 * store: its only caller is the popout's own nav, whose renderer owns the
 * App Advisor archive state.
 */
export function openArchivedOverviewSurface(workspaceId: string): void {
  const { openOverview } = useArchivedContainersStore.getState();
  useStandaloneChatStore.getState().closeArchiveOverlay();
  useSharedContainerReplicasStore.getState().closeViewer();
  useSharedContainerReplicasStore.getState().closePastShares();
  if (workspaceId === APP_ADVISOR_PROJECT_ID) {
    openOverview(workspaceId);
    return;
  }
  if (isCoworkChatTarget(workspaceId)) {
    openOverview(workspaceId);
    useNavigationStore.getState().navigate('chat');
    return;
  }
  useNavigationStore.getState().navigate('main');
  openOverview(workspaceId);
}

/**
 * Navigate to a fully restored container's destination. Callers must only
 * invoke this once the container has been consumed (a partial restore keeps
 * the viewer open instead).
 *
 * The viewer closes LAST — after the destination selection has landed — so
 * the restore reads as a single transition instead of flashing whatever was
 * selected underneath the overlay before revealing the restored target.
 */
export async function navigateToRestoredContainerDestination(
  workspaceId: string,
  result: ArchivedContainerRestoreResponse,
): Promise<void> {
  const closeViewer = useArchivedContainersStore.getState().closeViewer;
  if (result.kind === 'worktree' && result.restoredWorktreeId !== undefined) {
    const restoredWorktreeId = result.restoredWorktreeId;
    const selectRestored = (): boolean => {
      useChatStore.getState().selectWorktree(workspaceId, restoredWorktreeId);
      const selected = useChatStore.getState().selectedWorktree;
      return (
        selected?.projectId === workspaceId &&
        selected.worktreeId === restoredWorktreeId
      );
    };
    if (!selectRestored()) {
      // selectWorktree's navigation guard rejects worktrees missing from the
      // projects snapshot — a concurrently started (pre-restore) loadProjects
      // can overwrite the fresh snapshot with one that predates the restored
      // worktree. Refresh once and retry; the viewer stays pinned open, so a
      // still-failing selection just falls through to today's Home fallback.
      await useProjectsStore
        .getState()
        .loadProjects({ silent: true })
        .catch(() => undefined);
      selectRestored();
    }
    useNavigationStore.getState().navigate('main');
    closeViewer();
    return;
  }
  if (result.restoredEntryId !== undefined) {
    if (workspaceId === APP_ADVISOR_PROJECT_ID) {
      // Reveal the restored entry in the popout window (whose renderer owns
      // the App Advisor stores) — even when this runs inside the popout, the
      // round-trip lands back here via the window command queue, which
      // selects the entry and then closes the popout's viewer.
      useNavigationStore
        .getState()
        .openAppAdvisor({ workEntryId: result.restoredEntryId });
      closeViewer();
      return;
    }
    const standaloneStore = useStandaloneChatStore.getState();
    // The restored chat can already be selected underneath the archive
    // viewer. In that case openWorkEntryFromSidebar intentionally short-cuts,
    // so refresh the active workspace first to put the newly restored entry
    // back into the sidebar before the viewer is removed.
    if (standaloneStore.activeChatProjectId === workspaceId) {
      await standaloneStore.refreshWorkEntries(workspaceId);
    }
    await useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(workspaceId, result.restoredEntryId);
    useNavigationStore.getState().navigate('chat');
    closeViewer();
    return;
  }
  // No destination id (defensive): never leave a stale viewer covering the
  // surface.
  closeViewer();
}
