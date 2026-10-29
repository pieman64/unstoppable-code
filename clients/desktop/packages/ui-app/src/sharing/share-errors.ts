import { parseShareFailure, type ShareFailure } from '@canopy/protocol/sharing';

/** A share operation failed with a validated, structured {@link ShareFailure}. */
export class ShareFailureError extends Error {
  constructor(readonly failure: ShareFailure) {
    super(failure.message);
    this.name = 'ShareFailureError';
  }
}

/**
 * The structured failure behind `error`, or `null` when it carries none.
 * Accepts a {@link ShareFailureError}, a bare failure, or a failed
 * `ShareOperationResult`; anything else is unclassified.
 */
export function classifyShareFailure(error: unknown): ShareFailure | null {
  if (error instanceof ShareFailureError) return error.failure;
  const direct = parseShareFailure(error);
  if (direct) return direct;
  if (typeof error === 'object' && error !== null && 'failure' in error) {
    return parseShareFailure(error.failure) ?? null;
  }
  return null;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/** Plain-text sentence for a share failure, phrased for the resource `noun`. */
export function shareFailureCopy(noun: string, failure: ShareFailure): string {
  // Whatever failed afterwards, a landed share is not repeated.
  if (failure.commitState === 'committed')
    return `${capitalize(noun)} shared, but finishing up failed.`;
  switch (failure.kind) {
    case 'authentication':
      return `Sign in again to share this ${noun}.`;
    case 'organization-plan':
      return `This organization has no active plan, so this ${noun} can't be shared with it.`;
    case 'permission':
      return failure.reason === 'publisher_role_required'
        ? "Your account can view shared items but can't publish them."
        : `You don't have permission to share this ${noun} with this audience.`;
    case 'conflict':
    case 'unavailable':
      return failure.message;
    case 'dependency-review':
      return 'Review the updated dependencies, then share again.';
    case 'connection':
      if (failure.stage === 'access')
        return "Couldn't check access. Check your connection and try again.";
      if (failure.commitState === 'unknown')
        return `Couldn't confirm whether this ${noun} was shared. Check its current sharing status before trying again.`;
      return "Couldn't upload the included files. Check your connection and try again.";
    case 'unknown':
      if (failure.commitState === 'unknown')
        return `Couldn't confirm whether this ${noun} was shared. Check its current sharing status before trying again.`;
      // A server refusal (validation, size) carries its own explanation;
      // retrying unchanged would fail the same way.
      if (isClientErrorStatus(failure.httpStatus))
        return `Couldn't share this ${noun}. ${failure.message}`;
      return `Couldn't share this ${noun}. Try again.`;
  }
}

function isClientErrorStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500;
}

/** What a share dialog may offer after a failure. */
export type ShareFailureRecovery =
  | 'sign-in'
  | 'choose-plan'
  | 'review-files'
  | 'try-again'
  | 'none';

/**
 * Recovery for a failure. A publication whose outcome is uncertain never
 * offers a retry: repeating it could create a duplicate share.
 */
export function shareFailureRecovery(
  failure: ShareFailure,
): ShareFailureRecovery {
  // An uncertain or landed share is never repeated: either could duplicate it.
  if (failure.commitState !== 'not-committed') return 'none';
  switch (failure.kind) {
    case 'authentication':
      return 'sign-in';
    case 'organization-plan':
      return 'choose-plan';
    case 'dependency-review':
      return 'review-files';
    case 'connection':
      return failure.retryable ? 'try-again' : 'none';
    case 'unknown':
      return isClientErrorStatus(failure.httpStatus) ? 'none' : 'try-again';
    case 'conflict':
      return 'try-again';
    case 'permission':
    case 'unavailable':
      return 'none';
  }
}
