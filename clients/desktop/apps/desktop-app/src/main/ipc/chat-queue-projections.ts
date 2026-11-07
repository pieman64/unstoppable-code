import { randomUUID } from 'node:crypto';
import type {
  ChatCommand,
  ChatCommandRequest,
  ChatCommandResult,
  ChatQueueEditRequest,
  ChatQueueEntryRequest,
  ChatQueueSetEditLockRequest,
} from '@canopy/desktop-shared/types';

export type QueueCommandDispatch = (
  request: ChatCommandRequest,
) => Promise<ChatCommandResult>;

function queueCommand(
  request: ChatQueueEntryRequest,
  command: ChatCommand,
): ChatCommandRequest {
  return {
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    command,
  };
}

/** `chat:queue-edit` through `core.chat.queue.entry.update` (CAN-4112). Resolves for every outcome. */
export async function projectQueueEdit(
  request: ChatQueueEditRequest,
  dispatch: QueueCommandDispatch,
): Promise<void> {
  await dispatch(
    queueCommand(request, {
      type: 'chat.edit_queued_message',
      chatId: request.chatId,
      queuedMessageId: request.entryId,
      text: request.text,
      ...(request.inputMode !== undefined
        ? { inputMode: request.inputMode }
        : {}),
      ...(request.fileReferences !== undefined
        ? { fileReferences: request.fileReferences }
        : {}),
      ...(request.attachmentPaths !== undefined
        ? { attachmentPaths: request.attachmentPaths }
        : {}),
      ...(request.attachmentPromptContexts !== undefined
        ? { attachmentPromptContexts: request.attachmentPromptContexts }
        : {}),
    }),
  );
}

/** `chat:queue-cancel` through `core.chat.queue.entry.cancel`. Resolves for every outcome. */
export async function projectQueueCancel(
  request: ChatQueueEntryRequest,
  dispatch: QueueCommandDispatch,
): Promise<void> {
  await dispatch(
    queueCommand(request, {
      type: 'chat.cancel_queued_message',
      chatId: request.chatId,
      queuedMessageId: request.entryId,
    }),
  );
}

/** `chat:queue-force` through `core.chat.queue.entry.force`. Resolves for every outcome. */
export async function projectQueueForce(
  request: ChatQueueEntryRequest,
  dispatch: QueueCommandDispatch,
): Promise<void> {
  await dispatch(
    queueCommand(request, {
      type: 'chat.force_queued_message',
      chatId: request.chatId,
      queuedMessageId: request.entryId,
    }),
  );
}

/** `chat:queue-set-edit-lock` through `core.chat.queue.entry.update` `lock`. Throws the queue's reason unless applied. */
export async function projectQueueEditLock(
  request: ChatQueueSetEditLockRequest,
  dispatch: QueueCommandDispatch,
): Promise<void> {
  const result = await dispatch(
    queueCommand(request, {
      type: 'chat.set_queued_message_edit_lock',
      chatId: request.chatId,
      queuedMessageId: request.entryId,
      locked: request.locked,
    }),
  );
  if (result.outcome !== 'applied' && result.outcome !== 'already_applied')
    throw new Error(
      result.reason ?? 'This message is no longer available to edit.',
    );
}
