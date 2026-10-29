import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import { getChatStateService } from '../services/chat-state-service';
import { enqueueChatTabMutation } from './chat-tab-mutation-queue';
import { isRecord } from './type-guards';

/** The new Claude session id from a forked session's `system/init` event. */
export function claudeForkSessionIdFromInit(data: unknown): string | null {
  if (!isRecord(data)) return null;
  return data.type === 'system' &&
    data.subtype === 'init' &&
    typeof data.session_id === 'string'
    ? data.session_id
    : null;
}

/**
 * Records a forked Claude chat's own session id once its first turn starts and
 * clears the one-shot fork marker, so later sends resume the fork rather than
 * forking the source session again. Returns the updated tab and the full tab
 * list, or `null` when there was no pending fork to consume.
 */
export async function consumePersistedClaudeForkSessionMarker(input: {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
  sessionId: string;
}): Promise<{ tab: PersistedChatTab; tabs: PersistedChatTab[] } | null> {
  return enqueueChatTabMutation(
    input.workspaceId,
    input.worktreeId,
    async () => {
      const result = await getChatStateService().updateCompatibilityTab(
        { projectId: input.workspaceId, worktreeId: input.worktreeId },
        input.chatId,
        (tab) => {
          if (
            !tab.claudeForkSessionOnNextSend ||
            tab.sdkSessionId === input.sessionId
          ) {
            return null;
          }
          const updatedTab: PersistedChatTab = {
            ...tab,
            sdkSessionId: input.sessionId,
          };
          delete updatedTab.claudeForkSessionOnNextSend;
          if (updatedTab.forkedFrom?.resumePointRequired === true) {
            updatedTab.forkedFrom = { ...updatedTab.forkedFrom };
            delete updatedTab.forkedFrom.resumePointRequired;
          }
          return updatedTab;
        },
        `consume-claude-fork:${input.chatId}:${input.sessionId}`,
      );
      if (!result.updated) return null;
      const updatedTab = result.tabsFile.tabs.find(
        (candidate) => candidate.id === input.chatId,
      );
      return updatedTab
        ? { tab: updatedTab, tabs: result.tabsFile.tabs }
        : null;
    },
  );
}
