/**
 * The desktop `CostNavigator`: where the shared cost views send a person.
 * Each method acts on an `entry` scope only; a retained (archived or deleted)
 * entry's views are read-only, so every method ignores that scope.
 */
import type { CostNavigator, CostSubagentTarget } from '@canopy/app-core';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import type { SubagentKind } from '@canopy/protocol';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  openAutomationRunDestination,
  type AutomationRunDestination,
} from '@/components/automations/resolveAutomationRunDestination';
import { isArchivedChat, isLiveChat } from '@/lib/chat-archive-status';
import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { openSubagentChatPanel } from '@/lib/panels/subagent-panel-open';
import {
  useChatStore,
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
} from '@/stores/chatStore';
import { chatScopeKey } from '@/stores/chat/revisioned-sync';
import { loadChatTranscriptPage } from '@/stores/chat/transcript-pages';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  openCostPanel,
  openSessionBreakdownPanel,
  type CostPanelScope,
} from './open-cost-panels';

const CHAT_UNAVAILABLE = 'That chat is no longer available.';

/** The entry a scope names, or `null` for a retained scope. */
export function costEntryScope(scope: CostScopeRef): CostPanelScope | null {
  return scope.kind === 'entry'
    ? { projectId: scope.projectId, worktreeId: scope.worktreeId }
    : null;
}

/** The subagent chat panel's kind for a cost row's subagent kind. */
export function subagentKindForCostTarget(
  kind: CostSubagentTarget['kind'],
): SubagentKind {
  switch (kind) {
    case 'claude_task':
      return 'claude-native';
    case 'codex_agent':
      return 'codex-native';
    case 'delegation':
      return 'managed';
  }
}

function showError(message: string): void {
  useGitHubStore.getState().addToast(message, 'error');
}

function isCoworkProject(projectId: string): boolean {
  return useProjectsStore
    .getState()
    .projects.some(
      (project) => project.id === projectId && project.type === 'cowork',
    );
}

function chatDestination(
  scope: CostPanelScope,
  chatId: string,
): AutomationRunDestination {
  if (scope.projectId === APP_ADVISOR_PROJECT_ID) {
    return { kind: 'app-advisor-chat', chatId };
  }
  if (isCoworkProject(scope.projectId)) {
    return { kind: 'cowork-chat', workspaceId: scope.projectId, chatId };
  }
  return {
    kind: 'worktree-chat',
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId,
  };
}

/**
 * An archived chat past its restore window opens in the tab bar's read-only
 * archive viewer, as the Feed opens one. A Cowork chat's viewer lives on the
 * Cowork page, so the Cowork open selects its Work Entry and raises it there.
 */
async function openArchivedTranscript(
  scope: CostPanelScope,
  chatId: string,
): Promise<void> {
  if (isCoworkProject(scope.projectId)) {
    const result = await openAutomationRunDestination({
      kind: 'cowork-chat',
      workspaceId: scope.projectId,
      chatId,
    });
    if (!result.ok) showError(result.error);
    return;
  }
  useNavigationStore.getState().navigate('main');
  useChatStore.getState().selectWorktree(scope.projectId, scope.worktreeId);
  // A frame's delay lets the selected worktree's tab bar mount its listener.
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent(WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT, {
        detail: { ...scope, chatId },
      }),
    );
  });
}

/**
 * Reveals a chat of the entry. An archived chat is restored first when it
 * still can be; an older one opens read-only. App Advisor chats are opened
 * as they are.
 */
export async function openCostChat(
  scope: CostPanelScope,
  chatId: string,
): Promise<void> {
  if (scope.projectId !== APP_ADVISOR_PROJECT_ID) {
    const chatStore = useChatStore.getState();
    if (!isLiveChat(scope, chatId)) {
      try {
        await chatStore.loadTabsForTarget(scope.projectId, scope.worktreeId);
      } catch {
        // The live list stays as it was; the archive check below decides.
      }
    }
    if (!isLiveChat(scope, chatId)) {
      try {
        await useChatStore
          .getState()
          .loadArchivedChats(scope.projectId, scope.worktreeId);
      } catch {
        // Best-effort: an unknown chat falls through to the open below.
      }
      const archived = useChatStore
        .getState()
        .archivedChats[
          `${scope.projectId}/${scope.worktreeId}`
        ]?.find((chat) => chat.chatId === chatId);
      if (archived !== undefined) {
        if (!archived.restorable) {
          await openArchivedTranscript(scope, chatId);
          return;
        }
        try {
          await useChatStore
            .getState()
            .restoreArchivedChat(scope.projectId, scope.worktreeId, chatId);
        } catch {
          showError(CHAT_UNAVAILABLE);
          return;
        }
      }
    }
  }
  const result = await openAutomationRunDestination(
    chatDestination(scope, chatId),
  );
  if (!result.ok) {
    showError(result.error);
    return;
  }
  // Selecting the chat that is already active changes nothing, so the grid
  // is asked to show its panel, which may sit behind a cost tab.
  requestChatPanelReveal(scope.projectId, scope.worktreeId, chatId);
}

/**
 * The subagent viewer builds a subagent's chat from its root chat's loaded
 * transcript. A root chat open as a tab but not yet read in this window would
 * read as "no longer available", so load its latest page first. A failed read
 * still opens the panel, which reports a chat it cannot read.
 */
async function openSubagentWithRootChat(
  entry: CostPanelScope,
  target: CostSubagentTarget,
): Promise<void> {
  if (
    entry.projectId !== APP_ADVISOR_PROJECT_ID &&
    (await isArchivedChat(entry, target.chatId))
  ) {
    // The viewer cannot build a subagent from an archived root chat. Show
    // that chat read-only; restoring it stays with Open chat.
    await openArchivedTranscript(entry, target.chatId);
    return;
  }
  const tab = useChatStore
    .getState()
    .worktreeChats[
      chatScopeKey(entry.projectId, entry.worktreeId)
    ]?.tabs.find((candidate) => candidate.id === target.chatId);
  if (tab?.transcript !== undefined && tab.transcriptLoaded !== true) {
    try {
      await loadChatTranscriptPage({
        projectId: entry.projectId,
        worktreeId: entry.worktreeId,
        chatId: target.chatId,
      });
    } catch {
      // Opened below either way.
    }
  }
  await openSubagentChatPanel(entry, {
    rootChatId: target.chatId,
    subagentId: target.subagentId,
    subagentKind: subagentKindForCostTarget(target.kind),
    // The panel names itself from the subagent once it loads.
    title: '',
  });
}

function withEntry(
  scope: CostScopeRef,
  run: (entry: CostPanelScope) => Promise<unknown>,
): void {
  const entry = costEntryScope(scope);
  if (entry === null) return;
  void run(entry);
}

export const DESKTOP_COST_NAVIGATOR: CostNavigator = {
  openSessionBreakdown: (scope, chatId) => {
    withEntry(scope, (entry) => openSessionBreakdownPanel(entry, chatId));
  },
  openPipelineRun: (scope, executionId) => {
    withEntry(scope, (entry) =>
      openPipelineExecutionFromUi({
        executionId,
        owner: entry,
        target: { entry: 'cost' },
      }),
    );
  },
  openSubagent: (scope, target) => {
    withEntry(scope, (entry) => openSubagentWithRootChat(entry, target));
  },
  openChat: (scope, chatId) => {
    withEntry(scope, (entry) => openCostChat(entry, chatId));
  },
  openCostPanel: (scope) => {
    withEntry(scope, (entry) => openCostPanel(entry));
  },
  openPipelineJob: (scope, executionId, jobId) => {
    withEntry(scope, (entry) =>
      openPipelineExecutionFromUi({
        executionId,
        owner: entry,
        target: { jobId },
      }),
    );
  },
};
