import type { ChatMessage } from '@/stores/chat/types';

/**
 * Older persisted transcripts can hold a system message whose only content is
 * the retired `pending_setup_info` setup annotation. That block renders
 * nothing, but a standalone row would still mount an empty wrapper and leave
 * a gap above the prompt, so the display projection drops such messages.
 * Stored messages are never rewritten, and a message with any other block
 * keeps its row.
 */
function isLegacySetupAnnotationOnly(message: ChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.length > 0 &&
    message.blocks.every((block) => block.type === 'pending_setup_info')
  );
}

export function omitLegacySetupAnnotations(
  messages: ChatMessage[],
): ChatMessage[] {
  // Fast path for the hot streaming loop: most transcripts carry none.
  if (!messages.some(isLegacySetupAnnotationOnly)) return messages;
  return messages.filter((message) => !isLegacySetupAnnotationOnly(message));
}
