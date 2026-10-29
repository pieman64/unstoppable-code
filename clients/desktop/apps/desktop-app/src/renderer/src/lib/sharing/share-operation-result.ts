import { ShareFailureError } from '@canopy/ui-app/sharing';
import {
  parseShareFailure,
  type ShareOperationResult,
} from '@canopy/protocol/sharing';

const MALFORMED_FAILURE_MESSAGE = "Couldn't share. Try again.";

/**
 * Return a share operation's value, or throw {@link ShareFailureError} with
 * its validated failure. A failure that doesn't validate (version skew) is
 * reported as an unknown, uncertain failure rather than trusted.
 */
export function unwrapShareOperationResult<T>(
  result: ShareOperationResult<T>,
): T {
  if (result.ok) return result.value;
  throw new ShareFailureError(
    parseShareFailure(result.failure) ?? {
      version: 1,
      kind: 'unknown',
      stage: 'publish',
      message: MALFORMED_FAILURE_MESSAGE,
      commitState: 'unknown',
      retryable: false,
    },
  );
}
