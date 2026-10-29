import { CHAT_CUSTOM_TITLE_MAX_LENGTH, chatTabLabel } from '@canopy/protocol';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';

type ChatTabLabelSource = Pick<
  PersistedChatTab,
  'title' | 'description' | 'customTitle'
>;

/**
 * The label a user already associates with a chat.
 *
 * `title` holds the literal name the chat was created with, which stays
 * 'New Chat' for the entire life of most chats; the Haiku-generated summary
 * lands on `description` and is what `ChatTabBar` actually renders
 * (`description ?? title`). A user-chosen `customTitle` wins over both. Any
 * surface that lists chats has to use the same precedence, or every named
 * chat reads as 'New Chat' to the user.
 *
 * The trim guards are the one deliberate difference from `ChatTabBar`'s inline
 * expression: a whitespace-only field falls through here instead of rendering
 * as blank.
 */
export function getChatTabLabel(
  tab: Pick<PersistedChatTab, 'id' | 'title' | 'description' | 'customTitle'>,
): string {
  if (tab.customTitle?.trim()) return tab.customTitle.trim();
  if (tab.description?.trim()) return tab.description;
  if (tab.title?.trim()) return tab.title;
  return tab.id;
}

/** The generated name a chat tab shows when it has no custom title. */
export function generatedChatTabLabel(tab: ChatTabLabelSource): string {
  return tab.description ?? tab.title;
}

/** The name a chat tab shows in the tab strips and their tooltips. */
export function chatTabStripLabel(tab: ChatTabLabelSource): string {
  return chatTabLabel(tab);
}

/**
 * Normalize a rename draft: trimmed text, or `null` to clear the custom
 * title. Returns `undefined` when the draft exceeds the shared limit.
 */
export function normalizeChatCustomTitle(
  value: string | null,
): string | null | undefined {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return null;
  return trimmed.length > CHAT_CUSTOM_TITLE_MAX_LENGTH ? undefined : trimmed;
}
