import type { PersistedChatBlock, PersistedChatMessage } from '../types';
import { isTranscriptBlocksReference } from '../transcript-storage';

/** Block variants that visibly represent transcript structure without text. */
const NON_EMPTY_NON_TEXT_BLOCKS = new Set<PersistedChatBlock['type']>([
  'compaction_info',
  'claude_terminal_sync_warning',
  'account_proxy_switch',
]);

const CLAUDE_LOCAL_COMMAND_TAG_PATTERN =
  /<\/?(?:local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr)\b/i;

function isEmptyAssistantTextBlock(block: PersistedChatBlock): boolean {
  switch (block.type) {
    case 'text':
    case 'thinking':
      return block.text.trim().length === 0;
    default:
      return false;
  }
}

function isEmptyAssistantTextMessage(message: PersistedChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (message.blocks.length === 0)
    return !isTranscriptBlocksReference(message.blocksRef);
  if (message.blocks.some((block) => NON_EMPTY_NON_TEXT_BLOCKS.has(block.type)))
    return false;
  return message.blocks.every(isEmptyAssistantTextBlock);
}

function isTextBlock(
  block: PersistedChatBlock,
): block is Extract<PersistedChatBlock, { type: 'text' }> {
  return block.type === 'text';
}

function isClaudeLocalCommandMessage(message: PersistedChatMessage): boolean {
  return message.blocks.some(
    (block) =>
      isTextBlock(block) && CLAUDE_LOCAL_COMMAND_TAG_PATTERN.test(block.text),
  );
}

function isSyntheticNoResponseMessage(message: PersistedChatMessage): boolean {
  if (message.role !== 'assistant' || message.blocks.length !== 1) return false;
  const block = message.blocks[0];
  return isTextBlock(block) && block.text.trim() === 'No response requested.';
}

function hasAdjacentClaudeLocalCommandMessage(
  messages: readonly PersistedChatMessage[],
  index: number,
): boolean {
  const start = Math.max(0, index - 3);
  const end = Math.min(messages.length - 1, index + 3);
  for (let i = start; i <= end; i += 1) {
    const candidate = messages[i];
    if (i !== index && candidate && isClaudeLocalCommandMessage(candidate))
      return true;
  }
  return false;
}

export function isPersistedChatMessageVisible(
  messages: readonly PersistedChatMessage[],
  index: number,
): boolean {
  const message = messages[index];
  if (!message || isEmptyAssistantTextMessage(message)) return false;
  if (isClaudeLocalCommandMessage(message)) return false;
  return !(
    isSyntheticNoResponseMessage(message) &&
    hasAdjacentClaudeLocalCommandMessage(messages, index)
  );
}

export function sanitizePersistedChatMessages(
  messages: PersistedChatMessage[],
): PersistedChatMessage[] {
  return messages.filter((_message, index) =>
    isPersistedChatMessageVisible(messages, index),
  );
}

/** Apply the same three-row adjacency window without retaining the transcript. */
export async function* sanitizePersistedChatMessageStream(
  messages: AsyncIterable<PersistedChatMessage>,
  signal?: AbortSignal,
): AsyncGenerator<PersistedChatMessage> {
  const previous: PersistedChatMessage[] = [];
  const pending: PersistedChatMessage[] = [];
  const emit = function* (): Generator<PersistedChatMessage> {
    const message = pending.shift();
    if (!message) return;
    const window = [...previous, message, ...pending];
    if (isPersistedChatMessageVisible(window, previous.length)) yield message;
    previous.push(message);
    if (previous.length > 3) previous.shift();
  };

  for await (const message of messages) {
    signal?.throwIfAborted();
    pending.push(message);
    if (pending.length > 3) yield* emit();
  }
  signal?.throwIfAborted();
  while (pending.length) yield* emit();
}
