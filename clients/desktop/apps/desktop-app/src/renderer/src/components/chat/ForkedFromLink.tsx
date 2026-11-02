import { memo, useCallback, type JSX } from 'react';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { ForkContextNotice } from '@canopy/ui-shared';
import { getProviderLabel } from '@/lib/providerLabels';
import { isCoworkChatTarget } from '@/lib/cowork';
import {
  useChatStore,
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
} from '@/stores/chatStore';
import { __chatStoreSurface } from '@/stores/chat/surface';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { BranchIcon as AppCatalogBranchIcon } from '@canopy/ui-shared/icons/AppIcons';

interface ForkSource {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** Anchor message id in the forked transcript; unused for navigation. */
  atMessageId?: string;
  /**
   * Set when the fork also crossed execution harnesses. Claude and Codex
   * sessions cannot be shared, so the transcript above this divider was
   * transferred to the new provider as a summary rather than verbatim. This
   * divider IS that disclosure, so its copy is load-bearing.
   */
  continuedFromProvider?: AgentProviderType;
  /**
   * `'fresh'` when the fork could not carry its source's provider session.
   * The transcript above the divider is a copy for reading; the agent has
   * none of it. Nothing else on screen says so, so this disclosure is
   * load-bearing. `visible-transcript` discloses the text-only OpenCode seed.
   */
  modelContext?: 'fresh' | 'visible-transcript';
}

/**
 * Returns true when a live (non-archived) chat tab with `chatId` still exists
 * in the worktree chat state for the given source. Archived chats are removed
 * from the active tab list, so their absence here means "open the archive
 * transcript view" rather than "switch to the tab".
 */
function isSourceChatActive(source: ForkSource): boolean {
  const key = `${source.projectId}/${source.worktreeId}`;
  const tabs = useChatStore.getState().worktreeChats[key]?.tabs;
  return Boolean(tabs?.some((tab) => tab.id === source.chatId));
}

async function navigateToStandaloneSource(source: ForkSource): Promise<void> {
  const store = useStandaloneChatStore.getState();
  const sourceWorkspaceId =
    source.projectId === STANDALONE_CHAT_PROJECT_ID
      ? source.worktreeId
      : source.projectId;
  // selectChat / selectArchive resolve the chat against the active chat
  // project, so switch projects first when the source lives in a different one.
  if (store.activeChatProjectId !== sourceWorkspaceId) {
    await store.switchChatProject(sourceWorkspaceId);
  }
  // selectChat resolves both live and archived Work Entry chats and keeps the
  // active Work Entry in sync with whichever source contains the chat.
  await useStandaloneChatStore.getState().selectChat(source.chatId);
}

async function navigateToWorktreeSource(source: ForkSource): Promise<void> {
  const chatStore = useChatStore.getState();
  useNavigationStore.getState().navigate('main');

  await chatStore.loadTabsForTarget(source.projectId, source.worktreeId);
  useChatStore.getState().selectWorktree(source.projectId, source.worktreeId);

  if (isSourceChatActive(source)) {
    useChatStore.getState().switchTab(source.chatId, {
      projectId: source.projectId,
      worktreeId: source.worktreeId,
    });
    return;
  }

  // Archived: hand off to the worktree tab bar, which owns the read-only
  // transcript viewer and archive refresh. A frame's delay lets the freshly
  // selected worktree's tab bar mount its listener before the request fires.
  const detail = {
    projectId: source.projectId,
    worktreeId: source.worktreeId,
    chatId: source.chatId,
  };
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent(WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT, { detail }),
    );
  });
}

/**
 * Divider link shown at a forked chat's fork point. Clicking it
 * navigates to the source conversation: its live tab when still active, or the
 * archived transcript view when it has been archived.
 */
interface ForkedFromLinkProps {
  forkedFrom: ForkSource;
}

export const ForkedFromLink = memo(function ForkedFromLink({
  forkedFrom,
}: ForkedFromLinkProps): JSX.Element {
  const handleClick = useCallback((): void => {
    if (forkedFrom.projectId === APP_ADVISOR_PROJECT_ID) {
      // App Advisor sources live in the popout window. Inside the popout the
      // scoped standalone store can resolve the chat directly; from the main
      // window we route through the popout's select_chat command instead of
      // navigating the main-window chat page.
      if (__chatStoreSurface === 'app-advisor') {
        void useStandaloneChatStore.getState().selectChat(forkedFrom.chatId);
      } else {
        void window.api.appAdvisor.openWindow({
          chatId: forkedFrom.chatId,
          focus: true,
        });
      }
      return;
    }
    if (isCoworkChatTarget(forkedFrom.projectId)) {
      void navigateToStandaloneSource(forkedFrom);
    } else {
      void navigateToWorktreeSource(forkedFrom);
    }
  }, [forkedFrom]);

  return (
    <>
      <div className="flex items-center gap-3 py-3">
        <div className="h-px flex-1 bg-line-base" />
        <button
          type="button"
          onClick={handleClick}
          className="flex items-center gap-1.5 text-xs font-medium fg-accent transition-colors hover:underline"
        >
          <AppCatalogBranchIcon width="14" height="14" aria-hidden="true" />
          {forkedFrom.continuedFromProvider
            ? `Continued from ${getProviderLabel(forkedFrom.continuedFromProvider)}, summary only`
            : 'Forked from conversation'}
        </button>
        <div className="h-px flex-1 bg-line-base" />
      </div>
      {forkedFrom.modelContext && (
        <ForkContextNotice mode={forkedFrom.modelContext} />
      )}
    </>
  );
});
