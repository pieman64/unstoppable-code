/**
 * A question a person dismissed without answering. It keeps the transport's
 * own message, so the AskUserQuestion tool result is unchanged; callers that
 * act on the answer tell a dismissal apart from a question nobody could see.
 */
export class AskUserDismissedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskUserDismissedError';
  }
}

const ASK_USER_DISMISSAL_MESSAGES: ReadonlySet<string> = new Set([
  'ask_user_cancelled',
  'cancelled',
  'ask_user_timeout',
  'User dismissed',
]);

/**
 * Whether a failed question was dismissed, timed out or stopped, as opposed
 * to one nobody could be asked, which callers acting on the answer treat as
 * a closed failure.
 */
export function isAskUserDismissal(error: unknown): boolean {
  return (
    error instanceof AskUserDismissedError ||
    (error instanceof Error && ASK_USER_DISMISSAL_MESSAGES.has(error.message))
  );
}
