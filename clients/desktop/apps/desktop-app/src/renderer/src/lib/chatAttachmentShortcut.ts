export const OPEN_CHAT_ATTACHMENTS_EVENT = 'canopy:open-chat-attachments';

export interface ChatAttachmentShortcutTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isChatAttachmentShortcutTarget(
  value: unknown,
  target: ChatAttachmentShortcutTarget,
): boolean {
  return (
    isRecord(value) &&
    value.projectId === target.projectId &&
    value.worktreeId === target.worktreeId &&
    value.chatId === target.chatId
  );
}
