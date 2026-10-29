import type {
  ShowFilesRendererFileResult,
  ShowFilesWorkspaceTarget,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useBrowserStore } from '@/stores/browserStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { isCoworkChatTarget } from '@/lib/cowork';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';

/** User activation must reveal the owner, even when main is on another page. */
export async function revealTurnFileTarget(
  target: ShowFilesWorkspaceTarget,
): Promise<void> {
  dismissPageLikeViewers();
  if (isCoworkChatTarget(target.projectId)) {
    await useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(target.projectId, target.worktreeId);
    const state = useStandaloneChatStore.getState();
    if (
      state.activeChatProjectId !== target.projectId ||
      state.activeWorkEntryId !== target.worktreeId
    )
      throw new Error('The file’s workspace is no longer available.');
    useNavigationStore.getState().navigate('chat');
  } else {
    useChatStore.getState().selectWorktree(target.projectId, target.worktreeId);
    const selected = useChatStore.getState().selectedWorktree;
    if (
      selected?.projectId !== target.projectId ||
      selected.worktreeId !== target.worktreeId
    )
      throw new Error('The file’s workspace is no longer available.');
    useNavigationStore.getState().navigate('main');
  }
}

/** Subscribe only while a viewer is open; remove the listener before notifying. */
export function onTurnFileViewerClosed(
  target: ShowFilesWorkspaceTarget,
  opened: ShowFilesRendererFileResult | undefined,
  onClose: () => void,
): () => void {
  const key = `${target.projectId}/${target.worktreeId}`;
  let dispose = (): void => {};
  const close = (): void => {
    dispose();
    onClose();
  };
  if (opened?.ok && opened.tabId) {
    const tabId = opened.tabId;
    dispose = useChatStore.subscribe((state) => {
      if (!state.worktreeChats[key]?.tabs.some((tab) => tab.id === tabId))
        close();
    });
  } else if (opened?.ok && opened.browserId) {
    const browserId = opened.browserId;
    dispose = useBrowserStore.subscribe((state) => {
      if (!state.worktrees[key]?.browsers[browserId]) close();
    });
  }
  return (): void => dispose();
}
