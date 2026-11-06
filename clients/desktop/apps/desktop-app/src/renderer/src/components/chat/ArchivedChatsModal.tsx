import type { JSX } from 'react';
import type { ArchivedChatSummary } from '@canopy/desktop-shared/types';
import { DialogModal } from '@canopy/ui-shared/components';
import { ArchivedChatRow } from './ArchivedChatRow';

export interface ArchivedChatsModalProps {
  summaries: ArchivedChatSummary[];
  /** Open the read-only transcript viewer for a chat (row click). */
  onOpenChat: (chatId: string) => void;
  onRestore: (chatId: string) => void;
  onSummarize: (chatId: string) => void;
  onClose: () => void;
  summarizingIds: ReadonlySet<string>;
  restoringIds: ReadonlySet<string>;
}

/**
 * Full, scrollable list of every archived chat for the worktree, with the same
 * Restore / Summarize actions as the hover popover. Opened from the archive
 * icon (click) or the popover's "N more…" row.
 */
export function ArchivedChatsModal({
  summaries,
  onOpenChat,
  onRestore,
  onSummarize,
  onClose,
  summarizingIds,
  restoringIds,
}: ArchivedChatsModalProps): JSX.Element {
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title="Archived chats"
      subtitle={
        summaries.length === 1
          ? '1 archived chat'
          : `${summaries.length} archived chats`
      }
      maxWidth="lg"
      dataTestId="archived-chats-modal"
    >
      {summaries.length === 0 ? (
        <p className="px-1 py-6 text-center text-s fg-secondary">
          No archived chats.
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {summaries.map((summary) => (
            <ArchivedChatRow
              key={summary.chatId}
              summary={summary}
              dataTestId="archived-chats-modal-row"
              onOpen={() => onOpenChat(summary.chatId)}
              onRestore={() => onRestore(summary.chatId)}
              onSummarize={() => onSummarize(summary.chatId)}
              summarizing={summarizingIds.has(summary.chatId)}
              restoring={restoringIds.has(summary.chatId)}
            />
          ))}
        </div>
      )}
    </DialogModal>
  );
}
