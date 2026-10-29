export { CHAT_CUSTOM_TITLE_MAX_LENGTH } from './canopy-core/common';

/**
 * The name people see for a chat, wherever chats are listed: its tab, the
 * archived chat list, and the Ledger's owner picker.
 *
 * A chat's `title` is the literal name it was created with (a slash command,
 * a plan's title, or "New Chat"); the agent-generated summary of what it is
 * about lands on `description`. A user-owned custom title wins, then the
 * generated name, then a live title, then the original one; a placeholder
 * ("New Chat") is used only when nothing
 * else is known. The original title is dropped rather than shown beneath, so
 * a chat reads the same everywhere.
 */
export interface ChatDisplayLabelInput {
  readonly customTitle?: string;
  readonly title?: string;
  readonly description?: string;
  /** The title a live tab shows now, when it differs from `title`. */
  readonly liveTitle?: string;
  /** Used when the chat has no name at all. */
  readonly fallback: string;
}

function normalizeLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function isPlaceholderLabel(value: string | undefined): boolean {
  const normalized = normalizeLabel(value)?.toLowerCase();
  return normalized === undefined || normalized === 'new chat';
}

export function chatDisplayLabel(input: ChatDisplayLabelInput): string {
  const customTitle = normalizeLabel(input.customTitle);
  if (customTitle !== undefined) return customTitle;
  const description = normalizeLabel(input.description);
  if (description !== undefined && !isPlaceholderLabel(description)) {
    return description;
  }
  const liveTitle = normalizeLabel(input.liveTitle);
  if (liveTitle !== undefined && !isPlaceholderLabel(liveTitle)) {
    return liveTitle;
  }
  const title = normalizeLabel(input.title);
  if (title !== undefined && !isPlaceholderLabel(title)) {
    return title;
  }
  return description ?? liveTitle ?? title ?? input.fallback;
}

/** The name fields a chat tab label reads. */
export interface ChatTabLabelFields {
  readonly customTitle?: string;
  readonly title: string;
  readonly description?: string;
}

/**
 * The name a chat tab strip shows: a non-blank custom title, else the
 * generated `description ?? title` the strips have always shown. Shared by the
 * desktop and Portal strips so both apply the same blank handling.
 */
export function chatTabLabel(tab: ChatTabLabelFields): string {
  return normalizeLabel(tab.customTitle) ?? tab.description ?? tab.title;
}
