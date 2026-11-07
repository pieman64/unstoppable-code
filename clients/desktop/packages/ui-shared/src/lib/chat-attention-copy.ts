// The copy of the alert a chat raises when it needs the user and is not on
// screen: the desktop's unread-chat toast and OS notification, and the web's
// toast and browser notification for a cloud chat (CAN-5656).

import { isOrchestratorLabel, ORCHESTRATOR_LABEL } from '@canopy/protocol';

export type UnreadChatToastReason = 'activity' | 'plan' | 'question';
/** Web cloud chats also alert on a tool approval; desktop does not yet. */
export type UnreadChatAlertReason = UnreadChatToastReason | 'approval';

/**
 * How a chat that needs the user alerts them, as the desktop does: a toast
 * when the chat is not on screen, and a system notification unless the
 * window is focused with the chat on screen.
 */
export function chatAttentionDelivery(options: {
  readonly chatInView: boolean;
  readonly windowFocused: boolean;
}): { readonly toast: boolean; readonly systemNotification: boolean } {
  return {
    toast: !options.chatInView,
    systemNotification: !(options.chatInView && options.windowFocused),
  };
}

/** `: <title>` to append to a headline, or '' for an untitled chat. */
export function getUnreadChatLabel(chatTitle: string | undefined): string {
  const trimmed = chatTitle?.trim();
  if (!trimmed) return '';
  const normalized = trimmed.toLowerCase();
  if (normalized === 'new chat' || isOrchestratorLabel(normalized)) return '';
  return `: ${trimmed}`;
}

export function getUnreadChatFallbackMessage(options: {
  reason: UnreadChatAlertReason;
  chatLabel: string;
  /** Left out where the toast headline already names the worktree. */
  worktreeName: string | undefined;
  isAppAdvisor: boolean;
}): string {
  if (options.isAppAdvisor) {
    if (options.reason === 'plan') {
      return `Plan ready for review in ${ORCHESTRATOR_LABEL}${options.chatLabel}`;
    }
    if (options.reason === 'question') {
      return `Question waiting in ${ORCHESTRATOR_LABEL}${options.chatLabel}`;
    }
    if (options.reason === 'approval') {
      return `Approval needed in ${ORCHESTRATOR_LABEL}${options.chatLabel}`;
    }
    return `New ${ORCHESTRATOR_LABEL} activity${options.chatLabel}`;
  }

  const where =
    options.worktreeName === undefined ? '' : ` in ${options.worktreeName}`;
  if (options.reason === 'plan') {
    return `Plan ready for review${where}${options.chatLabel}`;
  }
  if (options.reason === 'question') {
    return `Question waiting${where}${options.chatLabel}`;
  }
  if (options.reason === 'approval') {
    return `Approval needed${where}${options.chatLabel}`;
  }
  return `New chat activity${where}${options.chatLabel}`;
}
