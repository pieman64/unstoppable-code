import type { ReactElement } from 'react';
import type {
  ChatAttachmentPromptContext,
  FileReference,
} from '@canopy/desktop-shared/types';
import type { QueuedChatMessage } from '@/stores/chatStore';
import type { ScheduledQueuedMessage } from '@/lib/worktreeSessionPromptAutomations';
import { QueuedMessageEditor } from './QueuedMessageEditor';
import type { ActiveComposerView } from './types';
import { scheduledMessageAsQueuedMessage } from './scheduledMessageAsQueuedMessage';
import { useQueuedMessageKey } from './useQueuedMessageKey';

type SaveEditedMessage<Target> = (
  target: Target,
  text: string,
  fileReferences: FileReference[],
  attachmentPaths: string[],
  attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
  inputMode: 'typed' | 'voice',
  scheduledSendDraft: { runAt: string } | undefined,
  expected?: QueuedChatMessage,
) => void;

export interface QueuedMessageComposerEditorOptions {
  queuedMessages: readonly QueuedChatMessage[] | undefined;
  editingQueuedMessageIndex: number | undefined;
  /** False when focus moved elsewhere while the edit was opening. */
  autoFocus?: boolean;
  onCancelEditQueuedMessage?: () => void;
  onSaveEditQueuedMessage?: SaveEditedMessage<number>;
  scheduledMessages?: readonly ScheduledQueuedMessage[];
  editingScheduledMessageId?: string | null;
  onCancelEditScheduledMessage?: () => void;
  onSaveEditScheduledMessage?: SaveEditedMessage<string>;
  composerTab: ActiveComposerView | null;
  /** Allow the editor to add, change or remove a one-time schedule. */
  scheduleEnabled?: boolean;
}

/**
 * The editor for the queued or scheduled message being edited, rendered in
 * the composer's place through `QueuedEditComposerSlot` (CAN-3607), or null
 * when nothing is being edited. Keyed by the message so switching the edit
 * target remounts the editor, while a queue-head drain that only shifts
 * indices keeps the edit in progress.
 */
export function useQueuedMessageComposerEditor({
  queuedMessages,
  editingQueuedMessageIndex,
  autoFocus,
  onCancelEditQueuedMessage,
  onSaveEditQueuedMessage,
  scheduledMessages,
  editingScheduledMessageId,
  onCancelEditScheduledMessage,
  onSaveEditScheduledMessage,
  composerTab,
  scheduleEnabled = false,
}: QueuedMessageComposerEditorOptions): ReactElement | null {
  const getQueuedMessageKey = useQueuedMessageKey();

  const queued =
    editingQueuedMessageIndex === undefined
      ? undefined
      : queuedMessages?.[editingQueuedMessageIndex];
  if (
    queued &&
    editingQueuedMessageIndex !== undefined &&
    onCancelEditQueuedMessage &&
    onSaveEditQueuedMessage
  ) {
    return (
      <QueuedMessageEditor
        autoFocus={autoFocus}
        key={`editor-${getQueuedMessageKey(queued)}`}
        message={queued}
        index={editingQueuedMessageIndex}
        composerTab={composerTab}
        onCancel={onCancelEditQueuedMessage}
        onSave={onSaveEditQueuedMessage}
        scheduleEnabled={scheduleEnabled}
      />
    );
  }

  const scheduled = editingScheduledMessageId
    ? scheduledMessages?.find(
        (candidate) =>
          candidate.automationId === editingScheduledMessageId &&
          candidate.scheduleKind === 'one_time',
      )
    : undefined;
  if (scheduled && onCancelEditScheduledMessage && onSaveEditScheduledMessage) {
    return (
      <QueuedMessageEditor
        key={`scheduled-editor-${scheduled.automationId}`}
        message={scheduledMessageAsQueuedMessage(scheduled)}
        index={0}
        composerTab={composerTab}
        onCancel={onCancelEditScheduledMessage}
        onSave={(
          _index,
          text,
          fileReferences,
          attachmentPaths,
          attachmentPromptContexts,
          inputMode,
          scheduledSendDraft,
        ): void =>
          onSaveEditScheduledMessage(
            scheduled.automationId,
            text,
            fileReferences,
            attachmentPaths,
            attachmentPromptContexts,
            inputMode,
            scheduledSendDraft,
          )
        }
        scheduleEnabled={scheduleEnabled}
      />
    );
  }
  return null;
}
