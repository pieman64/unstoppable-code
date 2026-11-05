import { useEffect } from 'react';
import type { ChatInterestChatRef } from '@canopy/desktop-shared/types';
import type { PanelLayoutViewModel } from '@canopy/ui-shared/panels';
import { useSubagentViewStateStore } from '@canopy/ui-app/subagents';
import { getChatInterest, subscribeChatInterest } from '@/lib/chat-interest';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import {
  retainChatTranscriptView,
  startChatTranscriptResidency,
  type ChatTranscriptResidencyHost,
  type ChatTranscriptResidencyInterest,
  type ChatTranscriptViewRef,
} from './transcript-residency';

function parseScopeKey(
  scopeKey: string,
): { projectId: string; worktreeId: string } | null {
  const separator = scopeKey.indexOf('/');
  if (separator <= 0 || separator === scopeKey.length - 1) return null;
  return {
    projectId: scopeKey.slice(0, separator),
    worktreeId: scopeKey.slice(separator + 1),
  };
}

/**
 * Root chats that visible Subagents and subagent chat panels render from the
 * chat store (`useSubagentTree`, `DesktopSubagentChatPanelHost`). The chat
 * interest names only chat panels, so these are added here: each visible
 * group's active tab, honouring a maximized group and skipping collapsed ones.
 */
export function subagentPanelRootChats(
  scopeKey: string,
  viewModel: PanelLayoutViewModel,
  selectedRootId: (scopeKey: string) => string | null | undefined,
): ChatInterestChatRef[] {
  const scope = parseScopeKey(scopeKey);
  if (!scope) return [];
  const maximized = viewModel.groups.filter(
    (group) => group.groupId === viewModel.maximizedGroupId,
  );
  const groups = maximized.length > 0 ? maximized : viewModel.groups;
  const roots: ChatInterestChatRef[] = [];
  for (const group of groups) {
    if (group.collapsed !== undefined) continue;
    const tab = group.tabs.find(
      (candidate) => candidate.panelId === group.activePanelId,
    );
    const rootChatId =
      tab?.kind === 'subagent-chat'
        ? tab.instance?.rootChatId
        : tab?.kind === 'subagents'
          ? (selectedRootId(scopeKey) ?? undefined)
          : undefined;
    if (rootChatId) roots.push({ ...scope, chatId: rootChatId });
  }
  return roots;
}

function panelRenderedChats(): ChatInterestChatRef[] {
  const layouts = usePanelLayoutStore.getState().layouts;
  const auxWindows = Object.values(usePanelWindowsStore.getState().auxWindows);
  const subagentScopes = useSubagentViewStateStore.getState().scopes;
  const selectedRootId = (scopeKey: string): string | null | undefined =>
    subagentScopes[scopeKey]?.selectedRootId;
  const refs: ChatInterestChatRef[] = [];
  for (const [layoutKey, layout] of Object.entries(layouts)) {
    // A pulled-out window's layout belongs to its owning worktree's scope.
    const scopeKey =
      auxWindows.find((aux) => aux.layoutKey === layoutKey)?.worktreeKey ??
      layoutKey;
    refs.push(
      ...subagentPanelRootChats(scopeKey, layout.viewModel, selectedRootId),
    );
  }
  return refs;
}

/** The renderer ports used by the transcript residency policy. */
export const browserChatTranscriptResidencyHost: ChatTranscriptResidencyHost = {
  currentInterest: (): ChatTranscriptResidencyInterest | null => {
    const interest = getChatInterest();
    const panelRoots = panelRenderedChats();
    if (interest === null && panelRoots.length === 0) return null;
    return {
      focused: [...(interest?.focused ?? []), ...panelRoots],
      warm: interest?.warm ?? [],
    };
  },
  subscribeInterest: (listener): (() => void) =>
    subscribeChatInterest(() => listener()),
  now: (): number => Date.now(),
};

/** Keep this chat's transcript resident for as long as this view is mounted. */
export function useChatTranscriptResidency(
  ref: ChatTranscriptViewRef | null,
): void {
  const projectId = ref?.projectId;
  const worktreeId = ref?.worktreeId;
  const chatId = ref?.chatId;
  useEffect(() => {
    if (!projectId || !worktreeId || !chatId) return undefined;
    const disposeResidency = startChatTranscriptResidency(
      browserChatTranscriptResidencyHost,
    );
    const releaseView = retainChatTranscriptView({
      projectId,
      worktreeId,
      chatId,
    });
    return (): void => {
      releaseView();
      disposeResidency();
    };
  }, [projectId, worktreeId, chatId]);
}
