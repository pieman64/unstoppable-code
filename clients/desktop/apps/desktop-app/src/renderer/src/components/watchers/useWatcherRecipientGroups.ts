// Assembles the grouped recipient options shown by {@link WatcherRecipientPicker}.
//
// Both App Advisor chat tabs and worktree chat tabs are persisted in the shared
// chat store under `worktreeChats[`${projectId}/${worktreeId}`]`; App Advisor
// tabs are ENTRY-KEYED (`app-advisor/<workEntryId>`). The standalone App
// Advisor window owns the canonical tab lists, so the main window lazily
// hydrates every entry's slice (idempotent aggregate) before reading them
// here.

import { useEffect, useMemo } from 'react';
import {
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useChatStore } from '@/stores/chatStore';
import type {
  WatcherRecipientGroup,
  WatcherRecipientOption,
} from './WatcherRecipientPicker';
import type { ChatTab } from '@/stores/chatStore';

const APP_ADVISOR_KEY_PREFIX = `${APP_ADVISOR_PROJECT_ID}/`;

export interface UseWatcherRecipientGroupsOptions {
  /** Include the current worktree's chats as a second recipient group. */
  worktree?: { projectId: string; worktreeId: string } | null;
}

function tabLabel(title: string | undefined): string {
  const trimmed = title?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'Untitled chat';
}

function isDeliverableChatTab(tab: ChatTab): boolean {
  return tab.kind !== 'file' && tab.readOnly !== true;
}

export function useWatcherRecipientGroups(
  options: UseWatcherRecipientGroupsOptions = {},
): WatcherRecipientGroup[] {
  const worktree = options.worktree ?? null;

  // Ensure every App Advisor entry's tab slice is loaded in this window.
  useEffect(() => {
    void useAppAdvisorStore.getState().hydrateForNavigation();
  }, []);

  // Aggregate across entry-keyed App Advisor slices. Subscribing to the
  // whole map is acceptable here: this hook only mounts inside watcher
  // pickers/modals, not hot chat surfaces.
  const worktreeChats = useChatStore((state) => state.worktreeChats);
  const worktreeTabs = worktree
    ? worktreeChats?.[`${worktree.projectId}/${worktree.worktreeId}`]?.tabs
    : undefined;
  // The worktree's currently-active chat tab, used to mark the preferred
  // default recipient for the pipeline-run watcher picker.
  const worktreeActiveTabId = worktree
    ? worktreeChats?.[`${worktree.projectId}/${worktree.worktreeId}`]
        ?.activeTabId
    : undefined;

  return useMemo(() => {
    const groups: WatcherRecipientGroup[] = [];

    const appAdvisorOptions: WatcherRecipientOption[] = [];
    for (const [key, chat] of Object.entries(worktreeChats ?? {})) {
      if (!key.startsWith(APP_ADVISOR_KEY_PREFIX)) continue;
      const entryId = key.slice(APP_ADVISOR_KEY_PREFIX.length);
      for (const tab of chat.tabs) {
        if (!isDeliverableChatTab(tab)) continue;
        const destination: AppAdvisorWatcherDestination = {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: entryId,
          chatId: tab.id,
          chatTitle: tab.title,
        };
        appAdvisorOptions.push({ destination, label: tabLabel(tab.title) });
      }
    }
    groups.push({
      key: 'app-advisor',
      label: 'App Advisor',
      options: appAdvisorOptions,
    });

    if (worktree) {
      const worktreeOptions: WatcherRecipientOption[] = (worktreeTabs ?? [])
        .filter(isDeliverableChatTab)
        .map((tab) => {
          const destination: AppAdvisorWatcherDestination = {
            projectId: worktree.projectId,
            worktreeId: worktree.worktreeId,
            chatId: tab.id,
            chatTitle: tab.title,
          };
          return {
            destination,
            label: tabLabel(tab.title),
            preferredDefault: tab.id === worktreeActiveTabId,
          };
        });
      groups.push({
        key: 'worktree',
        label: 'This worktree',
        options: worktreeOptions,
      });
    }

    return groups;
  }, [worktreeChats, worktreeTabs, worktreeActiveTabId, worktree]);
}
