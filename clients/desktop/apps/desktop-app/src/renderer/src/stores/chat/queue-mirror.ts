import type { HostQueuedMessageView } from '@canopy/desktop-shared/types';

import {
  reconcilePendingQueueMessages,
  restoreDispatchedQueueRow,
} from './optimistic-presentation';
import type { ChatTab, QueuedChatMessage } from './types';

/**
 * Convert the host-owned queue view rows (broadcast over `chatQueueUpdated` or
 * pulled via `getChatQueueSnapshot`) into renderer `QueuedChatMessage` mirror
 * rows. Mirror rows carry `hostQueueEntryId` so the store can distinguish them
 * from renderer-local rows (hook placeholders, git-pending) that main does not
 * own. Single source of truth for the mapping so the live-event path and the
 * hydration path stay identical.
 */
export function hostQueueViewsToQueuedMessages(
  queue: HostQueuedMessageView[],
): QueuedChatMessage[] {
  return queue.map((message) => ({
    hostQueueEntryId: message.id,
    text: message.text,
    ...(message.promptSource ? { promptSource: message.promptSource } : {}),
    ...(message.fileReferences
      ? { fileReferences: message.fileReferences }
      : {}),
    ...(message.attachmentPaths
      ? { attachmentPaths: message.attachmentPaths }
      : {}),
    ...(message.attachmentPromptContexts
      ? { attachmentPromptContexts: message.attachmentPromptContexts }
      : {}),
    origin: message.origin,
    enqueuedAtMs: message.enqueuedAtMs,
    ...(message.editLocked === true ? { editLocked: true } : {}),
    ...(message.canSteer === true ? { canSteer: true } : {}),
    ...(message.steerBlockedByCapabilityChange === true
      ? { steerBlockedByCapabilityChange: true }
      : {}),
    ...(message.watcherFired ? { watcherFired: message.watcherFired } : {}),
    ...(message.agentSent ? { agentSent: message.agentSent } : {}),
  }));
}

export function attachHostQueueMirror(
  tabs: ChatTab[],
  queuedByChatId: Map<string, QueuedChatMessage[]>,
): ChatTab[] {
  if (queuedByChatId.size === 0) return tabs;

  return tabs.map((tab) => {
    const mirrored = queuedByChatId.get(tab.id);
    if (!mirrored || mirrored.length === 0) return tab;
    tab = restoreDispatchedQueueRow(tab, mirrored);
    // Preserve renderer-local rows (hook placeholders, git-pending) that main
    // does not own, then append the host-owned mirror rows.
    const localRows = tab.queuedMessages.filter(
      (message) => message.hostQueueEntryId === undefined,
    );
    return {
      ...tab,
      queuedMessages: [...localRows, ...mirrored],
      pendingQueueMessages: reconcilePendingQueueMessages(
        tab.pendingQueueMessages,
        mirrored,
      ),
    };
  });
}

/**
 * Keep the host-owned queue mirror when a renderer event rebuilds a tab from
 * persisted data. The caller remains responsible for deciding which
 * renderer-local rows survive that rebuild.
 */
export function preserveHostQueueMirror(
  previousRows: QueuedChatMessage[] | undefined,
  localRows: QueuedChatMessage[],
): QueuedChatMessage[] {
  const mirroredRows =
    previousRows?.filter((message) => message.hostQueueEntryId !== undefined) ??
    [];
  return [...localRows, ...mirroredRows];
}
