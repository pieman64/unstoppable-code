import type { McpQuestionAnswer } from '@canopy/desktop-shared/types';
import type { ChatWaitSettlement } from '@canopy/core-runtime/node/agent/waits';
import { getDesktopChatWaits } from '../chat-waits/desktop-chat-waits';

export interface PendingQuestionScope {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

function questionWaitError(
  settlement: Exclude<ChatWaitSettlement<unknown>, { status: 'answered' }>,
): string {
  switch (settlement.status) {
    case 'expired':
      return 'ask_user_timeout';
    case 'failed':
      return settlement.reason === 'no_client'
        ? 'ask_user_no_client'
        : settlement.reason;
    case 'cancelled':
      return settlement.reason;
  }
}

function answersOrThrow(
  settlement: ChatWaitSettlement<McpQuestionAnswer[]>,
): McpQuestionAnswer[] {
  if (settlement.status === 'answered') return settlement.value;
  throw new Error(questionWaitError(settlement));
}

/** True while a question for this session waits on the user. */
export function hasPendingRequestForSession(sessionKey: string): boolean {
  return getDesktopChatWaits().hasOpenForSession(sessionKey, 'question');
}

export function createPendingRequest(
  requestId: string,
  sessionKey: string,
  options?: {
    scope?: PendingQuestionScope;
    timeoutMs?: number;
    onTimeout?: () => void;
  },
): Promise<McpQuestionAnswer[]> {
  const wait = getDesktopChatWaits().open<McpQuestionAnswer[]>({
    waitId: requestId,
    kind: 'question',
    ...(options?.scope
      ? {
          scope: {
            workspaceId: options.scope.projectId,
            worktreeId: options.scope.worktreeId,
            chatId: options.scope.chatId,
          },
        }
      : {}),
    sessionKey,
    ...(options?.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options?.onTimeout ? { onExpired: options.onTimeout } : {}),
  });
  return wait.settled.then(answersOrThrow);
}

/** False once the request settled, including at open in the lifecycle's fail mode. */
export function isPendingRequestOpen(requestId: string): boolean {
  return getDesktopChatWaits().isOpen(requestId);
}

export function resolveRequest(
  requestId: string,
  answers: McpQuestionAnswer[],
): boolean {
  return getDesktopChatWaits().answer(requestId, answers);
}

export function rejectRequest(requestId: string, reason: string): boolean {
  const lifecycle = getDesktopChatWaits();
  return reason === 'ask_user_persistence_failed'
    ? lifecycle.fail(requestId, reason)
    : lifecycle.cancel(requestId, {
        reason,
        refuseLateAnswers: reason === 'ask_user_cancelled',
      });
}

export function isAskUserRequestCancelled(requestId: string): boolean {
  return getDesktopChatWaits().refusesLateAnswers(requestId);
}

export function clearAskUserRequestCancellation(requestId: string): void {
  getDesktopChatWaits().forgetLateAnswerRefusal(requestId);
}

export function hasPendingRequestsForSession(sessionKey: string): boolean {
  return getDesktopChatWaits().hasOpenForSession(sessionKey, 'question');
}

export function rejectAllForSession(sessionKey: string): void {
  getDesktopChatWaits().cancelSession(sessionKey, 'question', {
    reason: 'session_destroyed',
  });
}
