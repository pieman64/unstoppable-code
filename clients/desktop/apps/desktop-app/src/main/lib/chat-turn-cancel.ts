import type { ChatCancelRequest } from '@canopy/desktop-shared/types';
import {
  drainChatSessionEvents,
  suppressCodexAuthenticationRecovery,
  getSession,
  getSessionProviderType,
  markSessionForNextTurnRecreation,
} from '../agents/session-manager';
import { cancelChatTurnPreparations } from './chat-turn-preparation';

export { beginChatTurnPreparation } from './chat-turn-preparation';

/**
 * Stop the foreground turn, withdrawing pending input before query disposal.
 */
export async function cancelChatTurn(
  req: ChatCancelRequest,
  options: { preserveAuthRecovery?: boolean } = {},
): Promise<void> {
  if (!options.preserveAuthRecovery) {
    const { clearPendingAuthResume } = await import('./auth-failure-turn-stop');
    clearPendingAuthResume(req);
  }
  suppressCodexAuthenticationRecovery(req);
  // Lazy by design: chat-state and chat-queue both import this cancellation
  // helper. Deferring their reverse edges breaks those initialization cycles;
  // the packaged Electron main build exercises these local import paths.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  const { getChatQueueService } =
    await import('../services/chat-queue-service');
  getChatQueueService().invalidatePendingInputOperations(req);
  await cancelChatTurnPreparations(req);
  const session = getSession(req.projectId, req.worktreeId, req.chatId);

  // Claude-compatible providers cancel by aborting the session-wide
  // AbortController, which permanently tears down the underlying SDK query.
  // Mark the session for recreation so a next turn cannot write into an
  // aborted query. Codex cancels via interruptTurn() and intentionally keeps
  // its session alive.
  const providerType = getSessionProviderType(
    req.projectId,
    req.worktreeId,
    req.chatId,
  );
  if (providerType === 'claude' || providerType === 'ollama') {
    markSessionForNextTurnRecreation(req.projectId, req.worktreeId, req.chatId);
  }

  try {
    await getChatStateService().inputDelivery.stop(req, async () => {
      try {
        await session?.cancel();
      } finally {
        // Cancellation can emit the provider terminal and managed-child
        // snapshots while teardown is in flight. Commit that prefix before
        // Stop returns so the renderer cannot remain on stale running state.
        await drainChatSessionEvents(req.projectId, req.worktreeId, req.chatId);
      }
    });
  } catch {
    // Swallow cancel errors (e.g. interruptTurn() JSON-RPC failure). Callers
    // still reset UI/session state through their normal cleanup paths.
  }
}

/** Queued Interrupt preserves Claude's query and waits for its real result. */
export async function interruptChatTurnForQueuedMessage(
  req: ChatCancelRequest,
): Promise<void> {
  const session = getSession(req.projectId, req.worktreeId, req.chatId);
  if (!session) return;
  // Lazy by design: chat-state reaches this helper through chat-queue, so a
  // static reverse import would create an initialization cycle. The packaged
  // Electron main build exercises this local import path.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  const state = getChatStateService();
  await state.inputDelivery.stop(req, async () => {
    if (
      session.interruptWithPendingSweep &&
      session.getSteeringCapabilities?.()?.interrupt === true
    ) {
      await session.interruptWithPendingSweep();
    } else {
      if (session.hasPendingSteeringInput?.())
        throw new Error(
          'Pending input could not be withdrawn; the replacement remains queued.',
        );
      const provider = getSessionProviderType(
        req.projectId,
        req.worktreeId,
        req.chatId,
      );
      if (provider === 'claude' || provider === 'ollama')
        markSessionForNextTurnRecreation(
          req.projectId,
          req.worktreeId,
          req.chatId,
        );
      // Before receipt negotiation (or on an older runtime) retain the
      // established cancel/recreate fallback without invalidating this
      // queued replacement's operation epoch as a composer Stop would.
      await session.cancel();
    }
    // Session-manager participates in the same cancellation/chat-state cycle;
    // defer its reverse edge. Packaged Electron main exercises this path.
    const { drainChatSessionEvents } =
      await import('../agents/session-manager');
    await drainChatSessionEvents(req.projectId, req.worktreeId, req.chatId);
  });
}
