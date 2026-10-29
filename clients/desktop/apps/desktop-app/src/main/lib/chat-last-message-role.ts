import type {
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';

export type ChatLastMessageRole = 'user' | 'assistant';

/** Chronological rows; tool/system rows never imply a conversational role. */
export function lastConversationalRole(
  messages: readonly PersistedChatMessage[],
): ChatLastMessageRole | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role === 'user' || role === 'assistant') return role;
  }
  return undefined;
}

/** Transcript metadata is authoritative, even if a stale inline copy exists. */
export function chatLastMessageRole(
  tab: Pick<PersistedChatTab, 'transcript' | 'messages'>,
): ChatLastMessageRole | undefined {
  return tab.transcript
    ? tab.transcript.lastMessageRole
    : lastConversationalRole(tab.messages);
}
