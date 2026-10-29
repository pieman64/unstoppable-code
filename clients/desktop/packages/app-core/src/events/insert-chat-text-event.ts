/**
 * Requests that a chat composer append plain text. Selection emitters target a
 * specific tab so exactly one live composer accepts the text; untargeted
 * requests remain supported for backwards-compatible visible-composer flows.
 */
export const INSERT_CHAT_TEXT_EVENT = 'canopy:insert-chat-text';

export interface InsertChatTextDetail {
  text: string;
  targetTabId?: string;
  targetChatId?: string;
  /** Synchronous acknowledgement used by callers that need a draft fallback. */
  markHandled?: () => void;
}

export function isInsertChatTextDetail(
  value: unknown,
): value is InsertChatTextDetail {
  if (typeof value !== 'object' || value === null) return false;
  if (!('text' in value) || typeof value.text !== 'string') return false;
  if (
    'targetTabId' in value &&
    value.targetTabId !== undefined &&
    typeof value.targetTabId !== 'string'
  ) {
    return false;
  }
  if (
    'targetChatId' in value &&
    value.targetChatId !== undefined &&
    typeof value.targetChatId !== 'string'
  )
    return false;
  return (
    !('markHandled' in value) ||
    value.markHandled === undefined ||
    typeof value.markHandled === 'function'
  );
}
