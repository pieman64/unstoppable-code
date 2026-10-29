import { randomUUID } from 'node:crypto';
import type { ChatCancelRequest } from '@canopy/desktop-shared/types';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { cancelChatTurn } from './chat-turn-cancel';
import { cancelTransientRetryForChat } from './transient-error-retry-service';

const autoRoutingControllers = new Map<string, AbortController>();
function routingKey(request: ChatCancelRequest): string {
  return JSON.stringify([
    request.projectId,
    request.worktreeId,
    request.chatId,
  ]);
}

/** Register preparation so every ordinary Stop surface can abort Auto routing. */
export function beginChatAutoRouting(request: ChatCancelRequest): {
  controller: AbortController;
  dispose: () => void;
} {
  const key = routingKey(request);
  const controller = new AbortController();
  autoRoutingControllers.get(key)?.abort();
  autoRoutingControllers.set(key, controller);
  return {
    controller,
    dispose: (): void => {
      if (autoRoutingControllers.get(key) === controller)
        autoRoutingControllers.delete(key);
    },
  };
}

/** The shared ordinary Stop sequence, committed before any caller broadcasts. */
export async function stopChatTurn(
  request: ChatCancelRequest,
): Promise<{ type: 'result'; is_error: false; result: 'Cancelled' }> {
  autoRoutingControllers.get(routingKey(request))?.abort();
  cancelTransientRetryForChat(request, 'stop');
  deferredToolsReloadCoordinator.cancelActiveReload(
    request,
    'Deferred-tools reload was cancelled because the user stopped the chat.',
  );
  await cancelChatTurn(request);
  // Lazy local imports break the queue/state/cancellation initialization cycle.
  const [{ getChatQueueService }, { getChatStateService }] = await Promise.all([
    import('../services/chat-queue-service'),
    import('../services/chat-state-service'),
  ]);
  // Providers may stop silently. Release the gate and durably settle the turn;
  // duplicate provider terminal events remain idempotent.
  getChatQueueService().onTurnTerminal(request, 'cancelled');
  const data = {
    type: 'result',
    is_error: false,
    result: 'Cancelled',
  } as const;
  await getChatStateService().ingestProviderEvent({
    ...request,
    data,
    mutationId: `manual-cancellation:${request.chatId}:${randomUUID()}`,
  });
  return data;
}
