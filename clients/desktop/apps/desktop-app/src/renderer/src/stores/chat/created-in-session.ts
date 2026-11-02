// Creation provenance belongs to this renderer lifetime, never persisted tab
// metadata. Restoring an empty chat does not make it a first-use target.
const createdChatIds = new Set<string>();

export function noteChatCreatedInSession(chatId: string): void {
  createdChatIds.add(chatId);
}

export interface ChatCreationInSession {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly confirmation: Promise<boolean>;
}

// Keep outcomes as well as pending attempts so a bridge mounted after creation
// can replay the same facts. Only locally constructed chat IDs qualify; file
// tabs and restored canonical chats never enter this registry.
const creations = new Map<string, ChatCreationInSession>();
const listeners = new Set<(creation: ChatCreationInSession) => void>();

export function noteChatCreationOutcomeInSession(
  creation: ChatCreationInSession,
): void {
  if (!createdChatIds.has(creation.chatId)) return;
  creations.set(creation.chatId, creation);
  listeners.forEach((listener) => listener(creation));
}

export function subscribeChatCreationsInSession(
  listener: (creation: ChatCreationInSession) => void,
): () => void {
  listeners.add(listener);
  creations.forEach(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
