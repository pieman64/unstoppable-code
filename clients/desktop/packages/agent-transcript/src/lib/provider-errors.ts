const CLAUDE_AUTH_FAILURE_MESSAGES = new Set([
  'Claude is not authenticated.',
  'Claude is not authenticated. Sign in from Settings before using Claude Workers.',
  'Claude is not authenticated. Sign in from Settings before using terminal mode.',
  'Please run /login - API Error: 401 Invalid authentication credentials',
]);

const CLAUDE_TURN_LIMIT_MESSAGE = 'Claude turn limit reached.';

/** Error results carry `errors`, while success-shaped results carry `result`. */
export function claudeResultErrorMessage(
  event: Record<string, unknown>,
): string {
  if (typeof event.result === 'string' && event.result.trim().length > 0) {
    return event.result;
  }
  const errors: unknown[] = Array.isArray(event.errors) ? event.errors : [];
  const messages = errors.flatMap((error): string[] =>
    typeof error === 'string' && error.trim().length > 0 ? [error.trim()] : [],
  );
  if (messages.length > 0) return messages.join('\n');
  if (
    event.subtype === 'error_max_turns' ||
    event.terminal_reason === 'max_turns'
  ) {
    return CLAUDE_TURN_LIMIT_MESSAGE;
  }
  return 'Unknown error';
}

/** Only the SDK's turn-cap failure offers turn-limit recovery. */
export function isClaudeTurnLimitMessage(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value === CLAUDE_TURN_LIMIT_MESSAGE ||
      /^Reached maximum number of turns \(\d+\)$/.test(value.trim()))
  );
}

/**
 * Recognize Claude messages that mean the native account must authenticate
 * again. Keep this intentionally narrow: it is also used to prevent an auth
 * failure carrying HTTP 429 metadata from surfacing as a usage-limit warning.
 */
export function isClaudeAuthenticationFailureMessage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const message = value.trim();
  return (
    CLAUDE_AUTH_FAILURE_MESSAGES.has(message) ||
    message.startsWith('Failed to authenticate:')
  );
}

/** Read structured HTTP evidence first; rendered status is an absent-field fallback. */
export function readClaudeApiErrorStatus(event: unknown): number | undefined {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return undefined;
  }
  if ('api_error_status' in event) {
    const status = event.api_error_status;
    return typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
      ? status
      : undefined;
  }
  if (!('result' in event) || typeof event.result !== 'string')
    return undefined;
  const match = /^API Error: (\d{3})\b/.exec(event.result.trim());
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}
