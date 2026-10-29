import {
  useCallback,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react';
import { TranscriptPagingControls } from '@canopy/ui-shared/components';
import type { ChatInterestChatRef } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { chatScopeKey } from '@/stores/chat/revisioned-sync';
import { flushChatInterest } from '@/lib/chat-interest';
import {
  catchUpStaleChat,
  getStaleChatCatchUpState,
  subscribeStaleChatCatchUp,
} from '@/stores/chat/stale-catch-up';

/** The existing paging treatment, owned by catch-up only while rows are stale. */
export function StaleTranscriptCatchUpControls({
  target,
  children,
}: {
  target: ChatInterestChatRef | null;
  children: ReactNode;
}): JSX.Element {
  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const chatId = target?.chatId;
  // One lookup per store update on this hot path; a primitive keeps it stable.
  const staleRows = useChatStore((state) => {
    if (!projectId || !worktreeId) return 'fresh';
    const tab = state.worktreeChats[
      chatScopeKey(projectId, worktreeId)
    ]?.tabs.find((entry) => entry.id === chatId);
    if (tab?.transcriptStale !== true) return 'fresh';
    return tab.messages.length > 0 ? 'cached' : 'empty';
  });
  const stale = staleRows !== 'fresh';
  const cached = staleRows === 'cached';
  const readState = useCallback(
    () => (target ? getStaleChatCatchUpState(target) : null),
    [target],
  );
  const state = useSyncExternalStore(
    subscribeStaleChatCatchUp,
    readState,
    readState,
  );
  const retry = (): void => {
    if (target)
      void catchUpStaleChat(target, flushChatInterest).catch(() => undefined);
  };
  return stale ? (
    <TranscriptPagingControls
      loading={state?.loading === true}
      suspended
      error={state?.error ?? null}
      hasEarlier={false}
      needsLoad={!cached}
      onReload={retry}
      onLoadEarlier={retry}
    />
  ) : (
    <>{children}</>
  );
}
