// Streaming-tab restore and stale-session replacement on renderer reload.
import type {
  ChatActiveSessionInfo,
  ChatActiveSessions,
} from '@canopy/desktop-shared/types';
import { SESSION_RESTORE_GRACE_MS } from './constants';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import type { ChatState } from './state';
import type { ChatTab, PendingQuestion } from './types';
import { hasPendingQuestionForChat } from './pending-questions';
import { hasPendingApprovalForChat } from './pending-approvals';
import {
  closeOpenToolUseBlocks,
  closeOpenTurnTimers,
  hasOpenTurnTimer,
  hasPausedTurnTimer,
  hasRecoverableStreamingState,
  isRestoreTerminalSessionEvent,
} from './event-transforms';

/**
 * Apply the shared "mark old tab read-only, append replacement tab, schedule
 * persistence" reducer used by `handleStaleSessionStartNew` and
 * `handleStaleSessionHandOff`. Returning the new state keeps the call site as
 * a one-liner inside the existing `set((state) => …)` callback.
 */
export function applyStaleSessionTabReplacement(
  state: ChatState,
  args: {
    key: string;
    projectId: string;
    worktreeId: string;
    sourceTabId: string;
    replacementTab: ChatTab;
  },
): ChatState | Partial<ChatState> {
  const currentWc = state.worktreeChats[args.key];
  if (!currentWc) {
    return state;
  }
  const tabs = currentWc.tabs.map((tab) =>
    tab.id === args.sourceTabId
      ? {
          ...tab,
          readOnly: true,
          staleSessionDetected: undefined,
          staleSessionResumeId: undefined,
          sdkSessionId: undefined,
          claudeForkSessionOnNextSend: undefined,
          queuedMessages: [],
          lastTurnWasResumeAttempt: undefined,
        }
      : tab,
  );
  const updated = {
    ...currentWc,
    tabs: [...tabs, args.replacementTab],
    activeTabId: args.replacementTab.id,
  };
  return {
    worktreeChats: {
      ...state.worktreeChats,
      [args.key]: updated,
    },
  };
}

/**
 * Decide whether to preserve a tab's streaming state on restore when it is
 * not in `activeChatIds`. Returns true only when there is a matching
 * main-process session, the session is not in a terminal state, the tab
 * still has recoverable streaming state (open turn timer or unresolved tool
 * use), and `lastActivityAt` is within the grace window.
 */
export function shouldPreserveStreamingOnRestore(
  tab: ChatTab,
  sessionInfo: ChatActiveSessionInfo | undefined,
  now: number,
): boolean {
  if (!sessionInfo) return false;
  if (!hasRecoverableStreamingState(tab.messages)) return false;
  if (isRestoreTerminalSessionEvent(sessionInfo.lastEventType)) return false;
  return now - sessionInfo.lastActivityAt <= SESSION_RESTORE_GRACE_MS;
}

/**
 * Preserve a freshly-started renderer turn while main-process dispatch catches
 * up. A delayed streaming verification can otherwise observe the previous
 * turn's terminal session snapshot in the short gap between optimistic user
 * message insertion and the new message being dequeued in main. Codex makes
 * this race visible when a trailing nonterminal event (for example
 * `thread.token_usage.updated`) arrives before the new `turn.started`.
 *
 * Explicit terminal events still settle the tab synchronously before the
 * verifier runs, so this grace applies only while the tab remains streaming
 * with recoverable work.
 */
export function shouldPreserveRecentStreamingActivity(
  tab: ChatTab,
  now: number,
): boolean {
  if (!hasRecoverableStreamingState(tab.messages)) return false;
  const openTurnStartedAt = tab.messages.reduce<number | undefined>(
    (latestStartedAt, message) =>
      message.blocks.reduce<number | undefined>((latest, block) => {
        if (
          block.type !== 'turn_timer' ||
          block.completedAt !== null ||
          typeof block.startedAt !== 'number'
        ) {
          return latest;
        }
        return Math.max(latest ?? block.startedAt, block.startedAt);
      }, latestStartedAt),
    undefined,
  );
  const latestActivityAt =
    typeof tab.lastEventAt === 'number' && openTurnStartedAt !== undefined
      ? Math.max(tab.lastEventAt, openTurnStartedAt)
      : (tab.lastEventAt ?? openTurnStartedAt);
  if (latestActivityAt === undefined) return false;
  return now - latestActivityAt <= SESSION_RESTORE_GRACE_MS;
}

export function shouldPreservePendingAskUserOnRestore(
  tab: ChatTab,
  options:
    | {
        projectId: string;
        worktreeId: string;
        pendingQuestions: Record<string, PendingQuestion>;
      }
    | undefined,
): boolean {
  if (!options) {
    return false;
  }
  return hasPendingQuestionForChat(
    options.pendingQuestions,
    options.projectId,
    options.worktreeId,
    tab.id,
  );
}

/**
 * Same preservation contract as {@link shouldPreservePendingAskUserOnRestore}
 * for pending tool-approval prompts: a chat with a live approval prompt must
 * keep its open `tool_use` block (and paused turn timer) intact on reload.
 * The approval dock itself renders from `pendingApprovals` state and does not
 * depend on any transcript block, but stamping a synthetic 'Cancelled'
 * result via `closeOpenToolUseBlocks` would misrepresent the still-pending
 * tool call in the transcript and close the turn timer while the prompt is
 * genuinely awaiting the user.
 */
export function shouldPreservePendingApprovalOnRestore(
  tab: ChatTab,
  options:
    | {
        projectId: string;
        worktreeId: string;
        pendingApprovals?: Record<string, ApprovalRequestEvent>;
      }
    | undefined,
): boolean {
  if (!options?.pendingApprovals) {
    return false;
  }
  return hasPendingApprovalForChat(
    options.pendingApprovals,
    options.projectId,
    options.worktreeId,
    tab.id,
  );
}

/**
 * Live-poll (`verifyStreamingTabs`) analogue of the two restore-time checks
 * above. A streaming tab whose session has dropped out of `activeChatIds`
 * (which happens the instant an approval or ask-user prompt pauses the turn)
 * must not be force-closed just because the grace window elapsed — the
 * backend approval promise has no timeout, so closing here would stamp a
 * synthetic 'Cancelled' result and permanently hide the pending prompt's
 * card while the main process is still waiting on a decision.
 */
export function hasPendingPromptForLiveTab(
  tab: ChatTab,
  options: {
    projectId: string;
    worktreeId: string;
    pendingQuestions: Record<string, PendingQuestion>;
    pendingApprovals: Record<string, ApprovalRequestEvent>;
  },
): boolean {
  return (
    shouldPreservePendingAskUserOnRestore(tab, options) ||
    shouldPreservePendingApprovalOnRestore(tab, options)
  );
}

/**
 * Apply the post-restore streaming reconciliation that runs after a worktree's
 * persisted tabs are loaded:
 *
 * - Tabs whose chat id is in `active.activeChatIds` are stamped streaming
 *   immediately.
 * - Tabs with no active session id but with a matching session that still
 *   shows recent nonterminal activity are kept streaming for the grace window
 *   (post-crash recovery). `preservedAnyOnRestore` flips true when this
 *   branch fires so callers can schedule a follow-up verification.
 * - Otherwise we close any stale `turn_timer` / `tool_use` blocks left open
 *   from the old turn so the transcript settles cleanly.
 *
 * Both `loadTabs` (single worktree) and `loadAllWorktreeTabs` (batch) used to
 * inline this logic verbatim; sharing it here removes the duplicated mapper
 * while keeping behavior identical.
 */
export function restoreStreamingTabs(
  tabs: ChatTab[],
  active: ChatActiveSessions,
  hydratedAt: number,
  pendingAskUser?: {
    projectId: string;
    worktreeId: string;
    pendingQuestions: Record<string, PendingQuestion>;
    pendingApprovals?: Record<string, ApprovalRequestEvent>;
  },
): { tabs: ChatTab[]; preservedAnyOnRestore: boolean } {
  const activeSet = new Set(active.activeChatIds);
  const sessionByChatId = new Map(
    (active.sessions ?? []).map((s) => [s.chatId, s]),
  );
  let preservedAnyOnRestore = false;
  const nextTabs = tabs.map((tab): ChatTab => {
    if (activeSet.has(tab.id)) {
      if (hasPausedTurnTimer(tab.messages) && !hasOpenTurnTimer(tab.messages)) {
        return { ...tab, status: 'idle', lastEventAt: hydratedAt };
      }
      return { ...tab, status: 'streaming', lastEventAt: hydratedAt };
    }
    if (
      shouldPreserveStreamingOnRestore(
        tab,
        sessionByChatId.get(tab.id),
        hydratedAt,
      )
    ) {
      preservedAnyOnRestore = true;
      return { ...tab, status: 'streaming', lastEventAt: hydratedAt };
    }
    if (
      shouldPreservePendingAskUserOnRestore(tab, pendingAskUser) ||
      shouldPreservePendingApprovalOnRestore(tab, pendingAskUser)
    ) {
      return { ...tab, status: 'idle' as const, lastEventAt: hydratedAt };
    }
    // Close any stale turn_timer / tool_use blocks for tabs that are no longer
    // streaming (e.g. the app reloaded while an agent was running).
    return {
      ...tab,
      messages: closeOpenToolUseBlocks(closeOpenTurnTimers(tab.messages)),
    };
  });
  return { tabs: nextTabs, preservedAnyOnRestore };
}
