/**
 * Navigation for a freshly forked container (CAN-2552).
 *
 * A fork lands in ordinary user-owned storage, so getting to it is the same
 * navigation any other workspace uses. There is deliberately no fork-specific
 * viewer. The two call sites (the accepted row's menu and the viewer header)
 * share this helper rather than each re-deriving the code-vs-Cowork split.
 *
 * Main created the workspace, worktree, or Work Entry after the renderer's last
 * listing, and the renderer keeps two parallel lists. `projectsStore.loadProjects`
 * below feeds the sidebar rows; it does *not* feed the Cowork store's own
 * `chatProjects`, which `switchChatProject` re-lists for itself when the target
 * is missing. So one reload here is not enough on its own, and adding a second
 * one would duplicate that funnel rather than replace it.
 */
import type { SharedContainerForkResponse } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';

export async function openForkedContainer(
  response: SharedContainerForkResponse,
): Promise<void> {
  await useProjectsStore.getState().loadProjects({ silent: true });

  if (response.containerType === 'COWORK_WORK_ENTRY') {
    // Cowork Work Entries live on the 'chat' page, and the entry id occupies
    // the `worktreeId` slot. The dynamic import breaks the module cycle the
    // chat store's own cowork navigation already works around.
    const { useStandaloneChatStore } =
      await import('@/stores/standaloneChatStore');
    await useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(response.projectId, response.worktreeId);
    useNavigationStore.getState().navigate('chat');
    return;
  }

  useChatStore
    .getState()
    .selectWorktree(response.projectId, response.worktreeId);
  useNavigationStore.getState().navigate('main');
}
