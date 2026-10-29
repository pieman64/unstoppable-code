import type { PersistedChatTab } from '../types';

type ChatNameSource = Pick<
  PersistedChatTab,
  'kind' | 'title' | 'description' | 'customTitle' | 'createdAt'
>;

/** Untitled chats keep this placeholder until their first message. */
const PLACEHOLDER_CHAT_TITLE = 'new chat';

function usableName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === PLACEHOLDER_CHAT_TITLE) {
    return undefined;
  }
  return trimmed;
}

/**
 * The human name for a worktree, taken from the chat that started it: the
 * oldest chat tab's generated summary, else its title. Later chats are only
 * consulted while the earlier ones are still unnamed. Returns `undefined`
 * when no chat has a name yet.
 *
 * Main derives this into the persisted `chatBadges.chatName`; the renderer
 * applies the same rule to live tabs, so both agree on which chat names a
 * worktree.
 */
export function deriveWorktreeChatName(
  tabs: readonly ChatNameSource[],
): string | undefined {
  const chats = tabs
    .filter((tab) => (tab.kind ?? 'chat') === 'chat')
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const chat of chats) {
    const name =
      chat.customTitle?.trim() ||
      usableName(chat.description) ||
      usableName(chat.title);
    if (name) return name;
  }
  return undefined;
}
