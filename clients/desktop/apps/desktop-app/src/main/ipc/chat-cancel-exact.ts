import type {
  ChatCancelRequest,
  ChatCancelResult,
} from '@canopy/desktop-shared/types';

/** The Stops an exact-turn `chat:cancel` composes. */
export interface ExactChatTurnStopDeps {
  validateId(value: string, name: string): void;
  isCoworkWorkspace(projectId: string): boolean;
  /** The user's Stop, only while `expectedUserMessageId` is the active turn. */
  stopActiveTurn(
    request: ChatCancelRequest,
    expectedUserMessageId: string,
  ): Promise<ChatCancelResult | null>;
  /**
   * Portal's `portal.chat.cancel_turn` stop: the named worktree turn while it
   * runs, or its withdrawal while it still waits in the queue.
   */
  cancelWorktreeTurn(
    request: ChatCancelRequest & { turnId: string },
  ): Promise<{ outcome: 'stop_requested' | 'turn_not_active' }>;
}

/**
 * `chat:cancel` with an expected turn (CAN-5985): stops only that turn, never
 * a newer one, and says whether it still ran. Without `expectedUserMessageId`
 * the handler keeps the plain Stop, unchanged for older controllers.
 */
export async function stopExactChatTurn(
  request: ChatCancelRequest,
  expectedUserMessageId: string,
  deps: ExactChatTurnStopDeps,
): Promise<ChatCancelResult> {
  deps.validateId(request.projectId, 'projectId');
  deps.validateId(request.worktreeId, 'worktreeId');
  deps.validateId(request.chatId, 'chatId');
  deps.validateId(expectedUserMessageId, 'expectedUserMessageId');
  const scope: ChatCancelRequest = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
  };
  if (deps.isCoworkWorkspace(scope.projectId)) {
    const stopped = await deps.stopActiveTurn(scope, expectedUserMessageId);
    return stopped === null
      ? { outcome: 'turn_not_active' }
      : { ...stopped, outcome: 'stop_requested' };
  }
  const { outcome } = await deps.cancelWorktreeTurn({
    ...scope,
    turnId: expectedUserMessageId,
  });
  return { outcome };
}
