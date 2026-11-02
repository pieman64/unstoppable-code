import type { QueuedChatMessage } from '@/stores/chatStore';
import type { ScheduledQueuedMessage } from '@/lib/worktreeSessionPromptAutomations';

/** A one-time scheduled send, shaped as a queued message for its bubble and editor. */
export function scheduledMessageAsQueuedMessage(
  scheduled: ScheduledQueuedMessage,
): QueuedChatMessage {
  return {
    text: scheduled.text,
    ...(scheduled.fileReferences
      ? { fileReferences: scheduled.fileReferences }
      : {}),
    ...(scheduled.attachmentPaths
      ? { attachmentPaths: scheduled.attachmentPaths }
      : {}),
    ...(scheduled.attachmentPromptContexts
      ? { attachmentPromptContexts: scheduled.attachmentPromptContexts }
      : {}),
    ...(scheduled.inputMode ? { inputMode: scheduled.inputMode } : {}),
    scheduledSendDraft: { runAt: scheduled.scheduledAt },
  };
}
