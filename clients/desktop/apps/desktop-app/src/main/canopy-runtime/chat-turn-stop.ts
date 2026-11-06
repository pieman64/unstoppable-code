import type {
  ChatCancelRequest,
  ChatCancelResult,
} from '@canopy/desktop-shared/types';

/** The exact-turn Stop shared by core.chat.turn.cancel and turn-run cancellation. */
export async function stopChatTurnExactly(
  request: ChatCancelRequest,
  userMessageId: string,
): Promise<ChatCancelResult | null> {
  // Lazy: the chat IPC module's graph loads only on the first Stop.
  const [{ stopChatForUser }, { getMainWindow }] = await Promise.all([
    import('../ipc/chat'),
    import('../lib/main-window-focus'),
  ]);
  return stopChatForUser(request, getMainWindow, userMessageId);
}
