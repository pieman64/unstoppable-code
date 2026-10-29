import type { PersistedChatMessage } from '../types';

export const HANDOFF_CONVERSATION_TEXT_LIMIT = 24_000;

const HANDOFF_TRUNCATION_NOTICE =
  '[Earlier turns omitted: this conversation was too long to summarize in full. The transcript below is the most recent portion.]';

function conversationTurns(
  messages: readonly PersistedChatMessage[],
): string[] {
  return messages
    .filter(
      (message) =>
        message.role === 'user' ||
        message.role === 'assistant' ||
        message.role === 'system',
    )
    .map((message) => {
      const text = message.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();
      const fileReferences = message.blocks.flatMap((block) =>
        block.type === 'file_references' ? block.references : [],
      );
      return { message, text, fileReferences };
    })
    .filter(
      ({ message, text, fileReferences }) =>
        text.length > 0 ||
        (message.role === 'user' && fileReferences.length > 0),
    )
    .map(({ message, text, fileReferences }) => {
      const filePrefix =
        message.role === 'user' && fileReferences.length > 0
          ? `Files: ${fileReferences
              .map((reference) => reference.absolutePath)
              .join(', ')}\n`
          : '';
      const label =
        message.role === 'user'
          ? 'User'
          : message.role === 'system'
            ? 'System'
            : 'Assistant';
      return `${label}: ${filePrefix}${text}`.trimEnd();
    });
}

export function buildHandoffConversationText(
  messages: readonly PersistedChatMessage[],
): string {
  return conversationTurns(messages).join('\n\n');
}

export function buildHandoffSummaryInput(
  messages: readonly PersistedChatMessage[],
): string {
  return summaryFromTurns(conversationTurns(messages));
}

function summaryFromTurns(turns: readonly string[]): string {
  const text = turns.join('\n\n');
  if (text.length <= HANDOFF_CONVERSATION_TEXT_LIMIT) return text;

  const turnBudget =
    HANDOFF_CONVERSATION_TEXT_LIMIT - (HANDOFF_TRUNCATION_NOTICE.length + 2);
  const kept: string[] = [];
  let budget = turnBudget;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const cost = turn.length + (kept.length > 0 ? 2 : 0);
    if (cost > budget) break;
    budget -= cost;
    kept.unshift(turn);
  }
  const keptLength = kept.join('\n\n').length;
  const droppedIndex = turns.length - 1 - kept.length;
  if (droppedIndex >= 0 && keptLength * 2 < turnBudget) {
    const room = budget - (kept.length > 0 ? 2 : 0);
    if (room > 0) {
      const dropped = turns[droppedIndex] ?? '';
      kept.unshift(dropped.slice(Math.max(0, dropped.length - room)));
    }
  }
  return `${HANDOFF_TRUNCATION_NOTICE}\n\n${kept.join('\n\n')}`;
}

/** Keep enough rendered context for turn-aware truncation without retaining message blocks. */
export async function buildHandoffSummaryInputFromTranscript(
  messages: AsyncIterable<PersistedChatMessage>,
): Promise<string> {
  const turns: string[] = [];
  const retainedLimit = HANDOFF_CONVERSATION_TEXT_LIMIT * 2;
  let length = 0;
  for await (const message of messages) {
    const text = buildHandoffConversationText([message]);
    if (!text) continue;
    length += text.length + (turns.length > 0 ? 2 : 0);
    turns.push(text);
    while (length > retainedLimit) {
      const first = turns[0];
      const excess = length - retainedLimit;
      if (turns.length > 1 && first.length <= excess) {
        turns.shift();
        length -= first.length + 2;
      } else {
        // Preserve the tail of an oversized turn when a short error follows it.
        turns[0] = first.slice(excess);
        length -= excess;
      }
    }
  }
  return summaryFromTurns(turns);
}
