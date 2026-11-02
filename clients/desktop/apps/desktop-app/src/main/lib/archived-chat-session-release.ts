import type {
  ArchivedChatEntry,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';
import {
  releaseChatSessionWhenIdle,
  type IdleChatSessionReleaseDecision,
} from '../agents/session-manager';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import type { ChatScopeKey } from '../services/chat-state-contracts';

interface ArchivedChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * The chat-state reads behind the release decision, supplied by the archiving
 * caller from the chat state it already holds; this module acquires none.
 */
export interface ArchivedChatStateReads {
  readCompatibilityArchive(
    scope: ChatScopeKey,
    chatId: string,
    fullTranscript: boolean,
  ): Promise<ArchivedChatEntry | null>;
  getCompatibilityTabs(
    scope: ChatScopeKey,
    selection: { chatIds: readonly string[] },
  ): Promise<ChatTabsFile>;
  isDispatchInFlight(target: ChatScopeKey & { chatId: string }): boolean;
}

/**
 * An auto-archive (`keepSession`) leaves the provider session alive so work
 * still running can stream and un-archive the chat. Once the session can no
 * longer start a turn by itself, release it; restoring the chat and sending
 * resumes the same provider session.
 */
export function releaseArchivedChatSessionWhenIdle(
  target: ArchivedChatTarget,
  chatState: ArchivedChatStateReads,
): void {
  releaseChatSessionWhenIdle(target, () =>
    confirmArchivedChatRelease(target, chatState),
  );
}

async function confirmArchivedChatRelease(
  target: ArchivedChatTarget,
  chatState: ArchivedChatStateReads,
): Promise<IdleChatSessionReleaseDecision> {
  if (deferredToolsReloadCoordinator.hasActiveReload(target)) return 'wait';
  // An accepted send not yet handed to the session host.
  if (chatState.isDispatchInFlight(target)) return 'wait';
  const scope = { projectId: target.projectId, worktreeId: target.worktreeId };
  const archived = await chatState.readCompatibilityArchive(
    scope,
    target.chatId,
    false,
  );
  // Restored or un-archived by a continuation: an open chat keeps its session.
  if (!archived) return 'retain';
  const live = await chatState.getCompatibilityTabs(scope, {
    chatIds: [target.chatId],
  });
  if (live.tabs.some((tab) => tab.id === target.chatId)) return 'retain';
  if (archived.tab.pendingPlanExit !== undefined) return 'wait';
  return 'release';
}
