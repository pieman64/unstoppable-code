export type ChatVisualReadFailureReason = 'not_found' | 'invalid_state';

/** Host details must not cross the portable visual-read boundary. */
export class ChatVisualReadError extends Error {
  public constructor(public readonly reason: ChatVisualReadFailureReason) {
    super(
      reason === 'not_found'
        ? 'Chat visual not found.'
        : 'Chat visual failed integrity validation.',
    );
    this.name = 'ChatVisualReadError';
  }
}
