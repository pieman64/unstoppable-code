import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import type { PersistedChatMessage as ChatMessage } from '@canopy/agent-transcript/types';
import { isTurnTimerMessage } from './turn-utils';

// Display-message folding (tool results, agent and Codex agent blocks,
// structural sharing) lives in browser-safe `@canopy/agent-transcript` so the
// web app can share it. Re-exported here for existing desktop imports.
export {
  mergeToolResults,
  shareDisplayMessages,
} from '@canopy/agent-transcript/lib/message-transforms';

// ---------------------------------------------------------------------------
// Reorder messages so turn timers appear at end of their turn group
// ---------------------------------------------------------------------------

function getSingleTextBlockText(message: ChatMessage): string | null {
  if (message.blocks.length !== 1) {
    return null;
  }
  const block = message.blocks[0];
  return block.type === 'text' ? block.text : null;
}

function isPromptEchoWhitespace(codeUnit: number): boolean {
  return (
    (codeUnit >= 0x0009 && codeUnit <= 0x000d) ||
    codeUnit === 0x0020 ||
    codeUnit === 0x00a0 ||
    codeUnit === 0x1680 ||
    (codeUnit >= 0x2000 && codeUnit <= 0x200a) ||
    codeUnit === 0x2028 ||
    codeUnit === 0x2029 ||
    codeUnit === 0x202f ||
    codeUnit === 0x205f ||
    codeUnit === 0x3000 ||
    codeUnit === 0xfeff
  );
}

function skipPromptEchoWhitespace(value: string, offset: number): number {
  while (
    offset < value.length &&
    isPromptEchoWhitespace(value.charCodeAt(offset))
  ) {
    offset += 1;
  }
  return offset;
}

/**
 * Compare the same canonical form as `value.trim().replace(/\s+/g, ' ')`
 * without allocating two normalized copies of potentially large prompts.
 */
function haveEquivalentPromptEchoText(left: string, right: string): boolean {
  let leftOffset = skipPromptEchoWhitespace(left, 0);
  let rightOffset = skipPromptEchoWhitespace(right, 0);

  while (leftOffset < left.length && rightOffset < right.length) {
    const leftWhitespace = isPromptEchoWhitespace(left.charCodeAt(leftOffset));
    const rightWhitespace = isPromptEchoWhitespace(
      right.charCodeAt(rightOffset),
    );
    if (leftWhitespace || rightWhitespace) {
      if (!leftWhitespace || !rightWhitespace) {
        return false;
      }
      leftOffset = skipPromptEchoWhitespace(left, leftOffset);
      rightOffset = skipPromptEchoWhitespace(right, rightOffset);
      continue;
    }
    if (left.charCodeAt(leftOffset) !== right.charCodeAt(rightOffset)) {
      return false;
    }
    leftOffset += 1;
    rightOffset += 1;
  }

  return (
    skipPromptEchoWhitespace(left, leftOffset) === left.length &&
    skipPromptEchoWhitespace(right, rightOffset) === right.length
  );
}

function isLikelyClaudeQueueEcho(
  messages: ChatMessage[],
  index: number,
): boolean {
  const message = messages[index];
  const nextMessage = messages[index + 1];
  if (
    !message ||
    !nextMessage ||
    message.role !== 'assistant' ||
    nextMessage.role !== 'user'
  ) {
    return false;
  }
  const messageText = getSingleTextBlockText(message);
  const nextText = getSingleTextBlockText(nextMessage);
  if (!messageText || !nextText) {
    return false;
  }
  return (
    Math.abs(nextMessage.timestamp - message.timestamp) <= 1_000 &&
    haveEquivalentPromptEchoText(messageText, nextText)
  );
}

export function reorderMessagesForDisplay(
  messages: ChatMessage[],
): ChatMessage[] {
  const result: ChatMessage[] = [];
  let pendingTimer: ChatMessage | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (!msg || msg.hidden) {
      continue;
    }

    if (isLikelyClaudeQueueEcho(messages, index)) {
      continue;
    }

    if (isTurnTimerMessage(msg)) {
      pendingTimer = msg;
      continue;
    }

    if (isUserTurnBoundary(msg) && pendingTimer) {
      result.push(pendingTimer);
      pendingTimer = null;
    }

    result.push(msg);
  }

  if (pendingTimer) {
    result.push(pendingTimer);
  }

  return result;
}
