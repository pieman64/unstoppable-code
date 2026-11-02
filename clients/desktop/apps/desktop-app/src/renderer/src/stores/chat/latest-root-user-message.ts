import { isRootUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import type { ChatMessage } from './types';

/** Latest root turn; child prompts and user-role tool results are not turns. */
export function latestRootUserMessageId(
  messages: readonly ChatMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isRootUserTurnBoundary(message)) return message.id;
  }
  return undefined;
}
