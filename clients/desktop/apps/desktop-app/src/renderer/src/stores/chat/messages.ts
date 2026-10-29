import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
// Pure helpers for reading text/file-reference content out of chat messages.
import type {
  FileReference,
  McpAskUserEvent,
  McpQuestionAnswer,
  PersistedChatBlock,
  PersistedChatMessage,
  StaleSessionInfo,
} from '@canopy/desktop-shared/types';
import type { ChatMessage, ChatTab } from './types';
import { isAskUserQuestionToolName } from '@/lib/canopy-tool-aliases';
export {
  buildHandoffConversationText,
  buildHandoffSummaryInput,
  HANDOFF_CONVERSATION_TEXT_LIMIT,
} from '@canopy/agent-transcript';
import { buildHandoffConversationText } from '@canopy/agent-transcript';

export function firstUserTextFromMessages(
  messages: readonly PersistedChatMessage[],
): string | null {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = message.blocks
      .filter(isTextChatBlock)
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text.length > 0) {
      return text;
    }
  }
  return null;
}

export function isTextChatBlock(
  block: PersistedChatBlock,
): block is Extract<PersistedChatBlock, { type: 'text' }> {
  return block.type === 'text';
}

export function redactMcpAnswersForDisplay(
  questions: McpAskUserEvent['questions'],
  answers: McpQuestionAnswer[],
): McpQuestionAnswer[] {
  return answers.map((answer, index) => {
    const matchedQuestion =
      questions.find(
        (question) =>
          typeof question.id === 'string' &&
          question.id.length > 0 &&
          question.id === answer.questionId,
      ) ?? questions[index];

    if (matchedQuestion?.secret !== true || !answer.freeformText) {
      return answer;
    }

    return {
      ...answer,
      freeformText: '[hidden]',
    };
  });
}

export function getTextBlocks(message: ChatMessage): string[] {
  return message.blocks.flatMap((block) =>
    block.type === 'text' ? [block.text] : [],
  );
}

export function getFileReferences(
  message: ChatMessage,
): FileReference[] | undefined {
  const references = message.blocks.flatMap((block) =>
    block.type === 'file_references' ? block.references : [],
  );
  return references.length > 0 ? references : undefined;
}

/** Returns true when a non-question tool call has not received its result. */
export function hasUnresolvedToolUse(messages: ChatMessage[]): boolean {
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.blocks)) continue;
    for (const block of message.blocks) {
      if (block.type === 'tool_result') {
        toolResultIds.add(block.toolUseId);
      }
    }
  }

  for (const message of messages) {
    if (!Array.isArray(message.blocks)) continue;
    for (const block of message.blocks) {
      if (
        block.type === 'tool_use' &&
        !toolResultIds.has(block.toolUseId) &&
        !isAskUserQuestionToolName(block.toolName)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns whether the latest user turn contains an unresolved non-question
 * tool call. Older turns cannot represent currently running work, so keeping
 * this scan turn-local avoids repeatedly walking long transcripts while the
 * provider streams updates.
 */
export function hasUnresolvedToolUseInCurrentTurn(
  messages: ChatMessage[],
): boolean {
  let turnStart = messages.length - 1;
  while (turnStart >= 0 && !isUserTurnBoundary(messages[turnStart])) {
    turnStart -= 1;
  }

  const toolResultIds = new Set<string>();
  for (let index = turnStart + 1; index < messages.length; index += 1) {
    const blocks = messages[index].blocks;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        toolResultIds.add(block.toolUseId);
      }
    }
  }

  for (let index = turnStart + 1; index < messages.length; index += 1) {
    const blocks = messages[index].blocks;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (
        block.type === 'tool_use' &&
        !toolResultIds.has(block.toolUseId) &&
        !isAskUserQuestionToolName(block.toolName)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function getRecoverableLastUserMessage(
  messages: ChatMessage[],
): StaleSessionInfo | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') {
      continue;
    }

    const droppedMessageText = getTextBlocks(message).join('\n').trim();
    if (!droppedMessageText) {
      return null;
    }

    const droppedFileReferences = getFileReferences(message);
    return {
      droppedMessageText,
      ...(droppedFileReferences ? { droppedFileReferences } : {}),
      ...(message.inputMode ? { droppedInputMode: message.inputMode } : {}),
    };
  }

  return null;
}

export const BRANCH_CHAT_NAMING_TEXT_LIMIT = 6000;

export function buildBranchChatNamingText(source: ChatTab): string {
  const conversationText = buildHandoffConversationText(source.messages).trim();
  const label = source.description?.trim() || source.title.trim();
  const parts = [label ? `Chat label: ${label}` : '', conversationText].filter(
    (part) => part.length > 0,
  );
  const text = parts.join('\n\n').trim();
  if (text.length <= BRANCH_CHAT_NAMING_TEXT_LIMIT) {
    return text;
  }
  return text.slice(text.length - BRANCH_CHAT_NAMING_TEXT_LIMIT);
}
