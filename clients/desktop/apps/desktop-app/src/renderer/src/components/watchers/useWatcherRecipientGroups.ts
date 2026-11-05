// Assembles the grouped recipient options shown by {@link WatcherRecipientPicker}.
//
// Both App Advisor chat tabs and worktree chat tabs are persisted in the shared
// chat store under `worktreeChats[`${projectId}/${worktreeId}`]`; App Advisor
// tabs are ENTRY-KEYED (`app-advisor/<workEntryId>`). The standalone App
// Advisor window owns the canonical tab lists, so the main window lazily
// hydrates every entry's slice (idempotent aggregate) before reading them
// here.

import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
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
import type { ChatTab, WorktreeChatState } from '@/stores/chatStore';

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

const NO_FIELDS: readonly string[] = [];

/** Entry id, chat id and title of each deliverable App Advisor tab, flat. */
function appAdvisorRecipientFields(
  worktreeChats: Readonly<Record<string, WorktreeChatState>>,
): string[] {
  const fields: string[] = [];
  for (const [key, chat] of Object.entries(worktreeChats)) {
    if (!key.startsWith(APP_ADVISOR_KEY_PREFIX)) continue;
    const entryId = key.slice(APP_ADVISOR_KEY_PREFIX.length);
    for (const tab of chat.tabs)
      if (isDeliverableChatTab(tab)) fields.push(entryId, tab.id, tab.title);
  }
  return fields;
}

/** Chat id and title of each deliverable tab, flat. */
function worktreeRecipientFields(
  tabs: readonly ChatTab[] | undefined,
): string[] {
  const fields: string[] = [];
  for (const tab of tabs ?? [])
    if (isDeliverableChatTab(tab)) fields.push(tab.id, tab.title);
  return fields;
}

export function useWatcherRecipientGroups(
  options: UseWatcherRecipientGroupsOptions = {},
): WatcherRecipientGroup[] {
  const projectId = options.worktree?.projectId;
  const worktreeId = options.worktree?.worktreeId;
  const worktreeKey =
    projectId === undefined || worktreeId === undefined
      ? null
      : `${projectId}/${worktreeId}`;

  // Ensure every App Advisor entry's tab slice is loaded in this window.
  useEffect(() => {
    void useAppAdvisorStore.getState().hydrateForNavigation();
  }, []);

  // The hook runs in hot chat surfaces (the composer's pipeline run watcher,
  // the worktree manager), so it selects only the fields the groups show, flat
  // for a shallow comparison: streamed content and runtime activity, which
  // replace `worktreeChats` on every update, leave the selection equal.
  const appAdvisorFields = useChatStore(
    useShallow((state) => appAdvisorRecipientFields(state.worktreeChats)),
  );
  const worktreeFields = useChatStore(
    useShallow((state) =>
      worktreeKey === null
        ? NO_FIELDS
        : worktreeRecipientFields(state.worktreeChats[worktreeKey]?.tabs),
    ),
  );
  // The worktree's currently-active chat tab, used to mark the preferred
  // default recipient for the pipeline-run watcher picker.
  const worktreeActiveTabId = useChatStore((state) =>
    worktreeKey === null
      ? undefined
      : state.worktreeChats[worktreeKey]?.activeTabId,
  );

  return useMemo(() => {
    const groups: WatcherRecipientGroup[] = [];

    const appAdvisorOptions: WatcherRecipientOption[] = [];
    for (let index = 0; index + 2 < appAdvisorFields.length; index += 3) {
      const entryId = appAdvisorFields[index];
      const chatId = appAdvisorFields[index + 1];
      const title = appAdvisorFields[index + 2];
      if (entryId === undefined || chatId === undefined || title === undefined)
        continue;
      const destination: AppAdvisorWatcherDestination = {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: entryId,
        chatId,
        chatTitle: title,
      };
      appAdvisorOptions.push({ destination, label: tabLabel(title) });
    }
    groups.push({
      key: 'app-advisor',
      label: ORCHESTRATOR_LABEL,
      options: appAdvisorOptions,
    });

    if (projectId !== undefined && worktreeId !== undefined) {
      const worktreeOptions: WatcherRecipientOption[] = [];
      for (let index = 0; index + 1 < worktreeFields.length; index += 2) {
        const chatId = worktreeFields[index];
        const title = worktreeFields[index + 1];
        if (chatId === undefined || title === undefined) continue;
        const destination: AppAdvisorWatcherDestination = {
          projectId,
          worktreeId,
          chatId,
          chatTitle: title,
        };
        worktreeOptions.push({
          destination,
          label: tabLabel(title),
          preferredDefault: chatId === worktreeActiveTabId,
        });
      }
      groups.push({
        key: 'worktree',
        label: 'This worktree',
        options: worktreeOptions,
      });
    }

    return groups;
  }, [
    appAdvisorFields,
    worktreeFields,
    worktreeActiveTabId,
    projectId,
    worktreeId,
  ]);
}
