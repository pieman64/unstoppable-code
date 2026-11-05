import { useMemo } from 'react';
import { useShallow } from 'zustand/shallow';
import type { LedgerFeedRootChat } from '@canopy/ui-app/ledger';
import { getChatTabLabel } from '@/lib/chatTabLabel';
import { hydratedKeys } from '@/stores/chat/hydration';
import { useChatStore, type ChatTab } from '@/stores/chatStore';

const EMPTY_TABS: readonly ChatTab[] = [];

/**
 * The root chat picker's choices from a task's tabs, in tab order: each chat
 * is the root of its own agents' work, working while its tab streams. File
 * tabs are not chats.
 */
export function ledgerRootChatsFromTabs(
  tabs: readonly Pick<
    ChatTab,
    'id' | 'kind' | 'status' | 'title' | 'description' | 'customTitle'
  >[],
): LedgerFeedRootChat[] {
  return tabs
    .filter((tab) => tab.kind !== 'file')
    .map((tab) => ({
      chatId: tab.id,
      title: getChatTabLabel(tab),
      live: tab.status === 'streaming',
    }));
}

/**
 * The task's open chats for the Feed panel's root chat picker; undefined
 * until its chats have loaded, so a partial list never reads as a closed chat.
 */
export function useLedgerRootChats(
  projectId: string,
  worktreeId: string,
): readonly LedgerFeedRootChat[] | undefined {
  const key = `${projectId}/${worktreeId}`;
  const tabs = useChatStore(
    useShallow((state): { readonly tabs: readonly ChatTab[] } | null =>
      hydratedKeys.has(key)
        ? { tabs: state.worktreeChats[key]?.tabs ?? EMPTY_TABS }
        : null,
    ),
  );
  return useMemo(
    () => (tabs === null ? undefined : ledgerRootChatsFromTabs(tabs.tabs)),
    [tabs],
  );
}
