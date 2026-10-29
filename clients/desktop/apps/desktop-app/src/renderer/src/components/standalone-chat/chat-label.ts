import type { ArchivedChatSummary } from '@canopy/desktop-shared/types';
import { chatDisplayLabel } from '@canopy/desktop-shared/lib/chat-display-label';

interface StandaloneChatLabelOptions {
  customTitle?: string;
  title?: string;
  description?: string;
  liveTitle?: string;
  fallback: string;
}

/** See `chatDisplayLabel`, which the Ledger's owner picker shares. */
export function getStandaloneChatDisplayLabel(
  options: StandaloneChatLabelOptions,
): string {
  return chatDisplayLabel(options);
}

/**
 * The label every archived-chat surface shows for a chat: the hover popover,
 * the full list modal, the single-chat transcript viewer, and the archived
 * container viewer.
 *
 * Archived summaries carry the same `title` / `description` split as live
 * tabs — `title` is the literal name the chat was created with (a slash
 * command, a seeded label, or 'New Chat'), and the agent-generated summary
 * lands on `description`. A user-chosen `customTitle` wins over both, then the
 * generated title wins outright, and the raw title
 * is then dropped rather than demoted to a sub-line, so an archived chat reads
 * exactly the way its live tab did.
 */
export function getArchivedChatDisplayLabel(
  summary: Pick<ArchivedChatSummary, 'title' | 'description' | 'customTitle'>,
): string {
  return getStandaloneChatDisplayLabel({
    customTitle: summary.customTitle,
    title: summary.title,
    description: summary.description,
    fallback: 'Untitled chat',
  });
}
