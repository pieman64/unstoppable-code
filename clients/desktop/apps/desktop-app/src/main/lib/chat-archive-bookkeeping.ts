import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import { getChatSearchService } from '../chat-search/service';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { notifyLedgerSessionEnded } from '../ledger/session-end-sweep-ports';
import { logMainProcessError } from './main-process-logging';

export interface ChatArchiveTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * Ledger handback and search index after a committed chat archive (CAN-4113;
 * lifted from chat:archive-tab). The handback is keyed by the archive's
 * `archivedAt`, so a repeat is deduplicated.
 */
export async function recordChatArchived(
  target: ChatArchiveTarget,
  archivedAt: string,
): Promise<void> {
  // The archive is committed first. A quit before the intent write lands
  // can lose this handback; startup completes every intent recorded after
  // that accepted commit-to-intent window. Never await the sweep itself.
  try {
    await notifyLedgerSessionEnded({
      target: { projectId: target.projectId, worktreeId: target.worktreeId },
      actor: { kind: 'chat', originKey: target.chatId },
      recipient: { kind: 'user' },
      reason: 'chat_archived',
      transitionKey: `chat-archive:${target.projectId}:${target.worktreeId}:${target.chatId}:${archivedAt}`,
      transitionAt: archivedAt,
    });
  } catch {
    // Ledger bookkeeping must never fail a committed archive.
  }
  getChatSearchService().worktreeChatArchived(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
}

/** Ends an archived chat's deferred-tools reload (lifted from chat:archive-tab). */
export function cancelArchivedChatDeferredToolsReload(
  target: ChatArchiveTarget,
): void {
  deferredToolsReloadCoordinator.cancelActiveReload(
    target,
    'Deferred-tools reload was cancelled because the chat was archived.',
  );
  deferredToolsReloadCoordinator.unregisterResumeHandler(target);
}

/** Removes the watchers an archived chat's delegates created; logs and never throws. */
export async function removeArchivedChatDelegateWatchers(
  target: ChatArchiveTarget,
): Promise<void> {
  // The archive stopped this chat's delegates; the watchers they created
  // end with them. Best-effort for the same reason as the teardown above.
  try {
    // Defer the scheduler-backed watcher service until an archive needs
    // it; importing chat persistence alone must not initialize it.
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    await getAppAdvisorWatcherService().removeDelegateWatchersForChat(target);
  } catch (error) {
    logMainProcessError(
      `[chatArchiveTab] Failed to remove delegate watchers for ${target.worktreeId}/${target.chatId}:`,
      error,
    );
  }
}

/** Search index after a committed restore (lifted from chat:restore-archive). */
export function recordChatRestored(
  scope: { projectId: string; worktreeId: string },
  tab: PersistedChatTab,
): void {
  getChatSearchService().worktreeChatRestored(
    scope.projectId,
    scope.worktreeId,
    tab,
  );
}
