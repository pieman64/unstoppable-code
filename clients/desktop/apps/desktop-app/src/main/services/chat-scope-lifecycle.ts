const CHAT_SCOPE_DELETING_ERROR_CODE = 'CHAT_SCOPE_DELETING';

export class ChatScopeDeletingError extends Error {
  public readonly code = CHAT_SCOPE_DELETING_ERROR_CODE;

  public constructor() {
    super('Chat scope is being deleted');
    this.name = 'ChatScopeDeletingError';
  }
}

export function isChatScopeDeletingError(
  error: unknown,
): error is ChatScopeDeletingError {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === CHAT_SCOPE_DELETING_ERROR_CODE
  );
}
