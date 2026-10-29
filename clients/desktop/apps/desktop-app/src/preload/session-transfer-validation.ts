import {
  type ChatSessionImportedEvent,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isChatSessionImportedEvent(
  value: unknown,
): value is ChatSessionImportedEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    typeof value.activateTab === 'boolean' &&
    isPersistedTabStub(value.tab)
  );
}

function isPersistedTabStub(value: unknown): value is PersistedChatTab {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    Array.isArray(value.messages) &&
    typeof value.createdAt === 'string'
  );
}
