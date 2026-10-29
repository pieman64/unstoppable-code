import type { ChatMessage, ChatTab, StoppedTurnResumeState } from './types';

/**
 * Stopped-turn resume presentation rules (CAN-3137).
 *
 * Main owns whether a stopped turn may be resumed (`chat:cancel` returns the
 * offer; `chat:resume-stopped-turn` enforces it). The renderer only mirrors
 * that offer and hides it the moment it would describe an older turn, so a
 * stale Resume is never shown even before main is asked.
 */

function latestUserMessageId(
  messages: readonly ChatMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') return message.id;
  }
  return undefined;
}

/**
 * The offer the composer should present, or `undefined` when there is none.
 *
 * Presented only while the chat is idle and the stopped turn is still the
 * latest one: once another turn starts (typed, queued, or watcher-driven) its
 * user message becomes the newest and the old offer is stale.
 */
export function presentableStoppedTurnResume(
  tab: Pick<
    ChatTab,
    | 'status'
    | 'messages'
    | 'stoppedTurnResume'
    | 'pendingTurn'
    | 'pendingUserMessages'
    | 'queuedMessages'
  >,
): StoppedTurnResumeState | undefined {
  const offer = tab.stoppedTurnResume;
  if (!offer) return undefined;
  if (tab.status !== 'idle') return undefined;
  if (tab.pendingTurn || (tab.pendingUserMessages?.length ?? 0) > 0) {
    return undefined;
  }
  if (tab.queuedMessages.length > 0) return undefined;
  if (latestUserMessageId(tab.messages) !== offer.userMessageId) {
    return undefined;
  }
  return offer;
}

/** Display-safe copy for a stale offer that main refused. */
export const STOPPED_TURN_RESUME_STALE_MESSAGE =
  'That turn can no longer be resumed. Send a message to continue.';

/** Fallback copy when main returned no display-safe failure text. */
export const STOPPED_TURN_RESUME_FAILED_MESSAGE =
  'Could not resume the stopped turn. Try again.';
