import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import type { ChatPreviewRow } from '@canopy/ui-shared/components';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import type { ChatTab } from '@/stores/chat/types';

type IdleWatcherChatTab = Pick<
  ChatTab,
  'id' | 'title' | 'providerType' | 'status'
>;

interface BuildIdleWatcherChatRowsArgs {
  projectId: string;
  worktreeId: string;
  tabs: readonly IdleWatcherChatTab[] | undefined;
  watchers: AppAdvisorWatcherSummary[];
}

function isActiveWorktreeWatcher(
  watcher: AppAdvisorWatcherSummary,
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    watcher.status === 'active' &&
    watcher.destination.projectId === projectId &&
    watcher.destination.worktreeId === worktreeId
  );
}

/** Lightweight status-only companion used by the streaming chat selector. */
export function hasIdleWatcherChat({
  projectId,
  worktreeId,
  tabs,
  watchers,
}: BuildIdleWatcherChatRowsArgs): boolean {
  if (watchers.length === 0) return false;
  const tabsById = new Map<string, IdleWatcherChatTab>(
    tabs?.map((tab) => [tab.id, tab] as const) ?? [],
  );
  return watchers.some((watcher) => {
    if (!isActiveWorktreeWatcher(watcher, projectId, worktreeId)) {
      return false;
    }
    const tab = tabsById.get(watcher.destination.chatId);
    return tab?.status !== 'streaming';
  });
}

/**
 * Group active watchers by their destination chat for one worktree.
 * A destination with a streaming tab is intentionally omitted: the sidebar
 * broadcast indicator is only for chats waiting idly for watcher events.
 * Delivery failures remain available in watcher-management surfaces for
 * diagnostics, but have already fired and are not waiting for a future event.
 *
 * Worktree chats are hydrated lazily, so an unknown tab is treated as idle and
 * rendered from the destination metadata captured by the watcher service.
 */
export function buildIdleWatcherChatRows({
  projectId,
  worktreeId,
  tabs,
  watchers,
}: BuildIdleWatcherChatRowsArgs): ChatPreviewRow[] {
  const tabsById = new Map<string, IdleWatcherChatTab>(
    tabs?.map((tab) => [tab.id, tab] as const) ?? [],
  );
  const watchersByChatId = new Map<string, AppAdvisorWatcherSummary[]>();

  for (const watcher of watchers) {
    if (!isActiveWorktreeWatcher(watcher, projectId, worktreeId)) continue;

    const tab = tabsById.get(watcher.destination.chatId);
    if (tab?.status === 'streaming') continue;

    const existing = watchersByChatId.get(watcher.destination.chatId);
    if (existing) {
      existing.push(watcher);
    } else {
      watchersByChatId.set(watcher.destination.chatId, [watcher]);
    }
  }

  const tabOrder = new Map<string, number>(
    tabs?.map((tab, index) => [tab.id, index] as const) ?? [],
  );
  const entries: Array<[string, AppAdvisorWatcherSummary[]]> = [];
  watchersByChatId.forEach((chatWatchers, chatId) => {
    entries.push([chatId, chatWatchers]);
  });
  entries.sort(
    ([leftId], [rightId]) =>
      (tabOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
      (tabOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER),
  );

  const rows: ChatPreviewRow[] = [];
  for (const [chatId, chatWatchers] of entries) {
    const tab = tabsById.get(chatId);
    const tabTitle = tab?.title?.trim();
    const destinationTitle = chatWatchers
      .map((watcher) => watcher.destination.chatTitle?.trim())
      .find((title): title is string => Boolean(title));
    const count = chatWatchers.length;
    rows.push({
      chatId,
      title: tabTitle || destinationTitle || `New ${CHAT_UNIT_LABEL}`,
      providerType: tab?.providerType,
      preview: `${count} ${count === 1 ? 'watcher' : 'watchers'} registered`,
    });
  }
  return rows;
}
