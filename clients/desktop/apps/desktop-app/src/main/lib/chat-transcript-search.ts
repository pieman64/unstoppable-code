import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { sanitizePersistedChatMessageStream } from '@canopy/agent-transcript/lib/message-sanitization';
import type {
  PersistedChatMessage,
  ChatTranscriptSearchResult,
} from '@canopy/desktop-shared/types';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Literal, case-insensitive counting with the same RegExp `i` canonicalization
 * the renderer's DOM highlighter uses, so main's counts and the highlighted
 * ranges agree for characters whose `toLowerCase()` differs (İ, K, ſ).
 */
function countOccurrences(text: string, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text) !== null) count++;
  return count;
}

/** Scan canonical rows without hydrating the renderer or retaining message bodies. */
export async function searchTranscriptMessages(
  messages: AsyncIterable<PersistedChatMessage>,
  query: string,
  signal?: AbortSignal,
): Promise<ChatTranscriptSearchResult> {
  const result: ChatTranscriptSearchResult = { matches: [], totalCount: 0 };
  if (query.length < 2 || query.length > 256) return result;
  const pattern = new RegExp(escapeRegExp(query), 'gi');
  const toolOwners = new Map<string, string>();
  let turnId = '';
  let rows = 0;
  for await (const message of sanitizePersistedChatMessageStream(
    messages,
    signal,
  )) {
    signal?.throwIfAborted();
    if (!turnId || isUserTurnBoundary(message)) turnId = message.id;
    for (const block of message.blocks)
      if (block.type === 'tool_use')
        toolOwners.set(block.toolUseId, message.id);
    if (
      message.role === 'user' ||
      message.role === 'assistant' ||
      message.role === 'system'
    ) {
      const groups = new Map<string, number>();
      for (const block of message.blocks) {
        const text =
          block.type === 'text' || block.type === 'thinking'
            ? block.text
            : block.type === 'tool_result'
              ? block.output
              : '';
        const count = countOccurrences(text, pattern);
        if (count) {
          const owner =
            block.type === 'tool_result'
              ? (toolOwners.get(block.toolUseId) ?? message.id)
              : message.id;
          groups.set(owner, (groups.get(owner) ?? 0) + count);
        }
      }
      for (const [owner, count] of Array.from(groups)) {
        result.matches.push({
          messageId: message.id,
          turnId,
          count,
          ...(owner !== message.id ? { renderMessageId: owner } : {}),
        });
        result.totalCount += count;
      }
    }
    if (++rows % 32 === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  signal?.throwIfAborted();
  return result;
}
