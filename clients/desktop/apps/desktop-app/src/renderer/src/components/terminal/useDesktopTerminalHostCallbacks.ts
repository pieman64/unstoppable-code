'use client';

import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import {
  INSERT_CHAT_TEXT_EVENT,
  resolveSelectionTargetTabId,
  type InsertChatTextDetail,
} from '@/lib/editorSelectionContext';

export interface DesktopTerminalHostCallbacks {
  onSendToChat?: (text: string) => void;
  getPathsForFiles: (files: ReadonlyArray<File>) => Promise<string[]>;
  /** The desktop text-field menu would act on xterm's hidden textarea. */
  suppressNativeContextMenu: true;
  onOpenLink: (url: string) => void;
}

export function useDesktopTerminalHostCallbacks(
  projectId?: string,
  worktreeId?: string,
): DesktopTerminalHostCallbacks {
  const onSendToChat = useCallback(
    (text: string): void => {
      if (projectId === undefined || worktreeId === undefined) return;
      const worktreeChat =
        useChatStore.getState().worktreeChats[`${projectId}/${worktreeId}`];
      if (worktreeChat === undefined) return;
      const targetTabId = resolveSelectionTargetTabId({
        tabs: worktreeChat.tabs,
        activeTabId: worktreeChat.activeTabId,
        ...(worktreeChat.lastActiveEditableChatId
          ? { lastActiveEditableChatId: worktreeChat.lastActiveEditableChatId }
          : {}),
      });
      if (targetTabId === null) return;
      const detail: InsertChatTextDetail = { text, targetTabId };
      document.dispatchEvent(
        new CustomEvent(INSERT_CHAT_TEXT_EVENT, { detail }),
      );
    },
    [projectId, worktreeId],
  );
  const getPathsForFiles = useCallback(
    (files: ReadonlyArray<File>): Promise<string[]> =>
      window.api.getPathsForFiles(files),
    [],
  );
  const onOpenLink = useCallback((url: string): void => {
    void window.api.browser.openExternal({ url });
  }, []);

  return {
    ...(projectId !== undefined && worktreeId !== undefined
      ? { onSendToChat }
      : {}),
    getPathsForFiles,
    suppressNativeContextMenu: true,
    onOpenLink,
  };
}
