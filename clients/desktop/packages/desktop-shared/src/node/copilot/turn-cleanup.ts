import { describeCopilotProcessFailure } from './process-ownership';

// Owners share one memoized close, so they see the same rejection, which is
// always an Error. A primitive would only be reported once per owner.
const reported = new WeakSet<object>();

/**
 * A runtime cleanup failure must never replace a failed turn's own error; it
 * is a warning, once per failure however many owners close the same runtime.
 * After a successful turn it fails the turn: an owned process may survive.
 */
export function handleCopilotTurnCleanupError(
  error: unknown,
  turnFailed: boolean,
): void {
  const object = typeof error === 'object' && error !== null;
  if (!turnFailed) {
    const thrown =
      error instanceof Error
        ? error
        : new Error('Copilot runtime cleanup failed.');
    // It becomes the turn's own error; a later owner must not report it again.
    reported.add(thrown);
    if (object) reported.add(error);
    throw thrown;
  }
  if (object) {
    if (reported.has(error)) return;
    reported.add(error);
  }
  const detail = describeCopilotProcessFailure(error);
  process.emitWarning('Copilot runtime cleanup failed after a turn error.', {
    code: 'COPILOT_TURN_CLEANUP_FAILED',
    ...(detail ? { detail } : {}),
  });
}
