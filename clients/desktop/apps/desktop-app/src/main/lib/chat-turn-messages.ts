import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';

/**
 * The messages of one turn: those after the user message that opened it, up
 * to the next user message that started a turn. A user message whose place
 * in the transcript is not yet its turn's (`provisional`: persisted before
 * dispatch, which moves it to its dispatch position, or never dispatched)
 * neither ends the turn nor belongs to it, so output the turn produced after
 * it still counts as the turn's. Null when the opening message is absent.
 */
export function turnMessages(
  messages: readonly PersistedChatMessage[],
  turnUserMessageId: string,
  provisional: ReadonlySet<string>,
): PersistedChatMessage[] | null {
  const start = messages.findIndex(
    (message) => message.id === turnUserMessageId && message.role === 'user',
  );
  if (start < 0) return null;
  const turn: PersistedChatMessage[] = [];
  for (const message of messages.slice(start + 1)) {
    if (message.role === 'user' && provisional.has(message.id)) continue;
    if (isUserTurnBoundary(message)) break;
    turn.push(message);
  }
  return turn;
}
