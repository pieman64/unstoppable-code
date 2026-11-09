import { CHAT_CUSTOM_TITLE_MAX_LENGTH, chatTabLabel } from '@canopy/protocol';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';

type ChatTabLabelSource = Pick<
  PersistedChatTab,
  'title' | 'description' | 'customTitle'
>;

export { getChatTabLabel } from '@canopy/desktop-shared/lib/app-advisor-chat-reads';

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
