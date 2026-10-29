import { useEffect } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

export function useStandaloneChatEventSubscriptions(): void {
  useEffect(() => {
    const unsubscribe = window.api.standaloneChat.onMetaUpdated((event) => {
      const standaloneStore = useStandaloneChatStore.getState();
      if (standaloneStore.activeChatProjectId === event.projectId) {
        // Work-entry meta (title/provider/lastMessageAt) is derived from tab
        // files main-side, so re-derive the list instead of patching rows.
        void standaloneStore.refreshWorkEntries(event.projectId);
      } else {
        // Main-owned sends can create a Work Entry in an inactive cowork
        // workspace before its sidebar rows have ever been loaded. The event
        // identifies the exact project, so load/refresh that one snapshot even
        // when it was previously absent instead of waiting for a row click.
        void standaloneStore.loadSidebarProjectEntries(event.projectId);
      }

      // CAN-1305: `portal.standalone_chat.set_model` persists the tab's model
      // in main without going through this renderer, so the composer dropdown
      // would stay on the previous model until the scope reloaded. The work
      // entry refresh above does not carry per-tab model state.
      if (event.chatId) {
        void useChatStore
          .getState()
          .syncPersistedTabModel(event.projectId, event.chatId);
      }
    });

    return unsubscribe;
  }, []);
}
