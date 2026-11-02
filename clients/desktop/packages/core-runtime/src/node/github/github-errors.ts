import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  CanopyErrorPayload,
  CanopyOperationCode,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import { GitHubRequestError } from './request-handle';

/** The operation codes a GitHub failure maps to, per operation family. */
export interface GitHubFailureCodes {
  readonly notAuthenticated: CanopyOperationCode;
  readonly notFound?: CanopyOperationCode;
  readonly baseRejected?: CanopyOperationCode;
}

const NEVER = { kind: 'never' } as const;
const SAME_REQUEST = { kind: 'same_request' } as const;

function payloadFor(
  error: GitHubRequestError,
  codes: GitHubFailureCodes,
): CanopyErrorPayload {
  switch (error.code) {
    case 'not_authenticated':
      return {
        kind: 'failed_precondition',
        code: codes.notAuthenticated,
        message: 'No GitHub credential is configured, or GitHub rejected it.',
        retry: { kind: 'after_refresh', resource: 'github-credential' },
      };
    case 'not_found':
      return {
        kind: 'not_found',
        ...(codes.notFound ? { code: codes.notFound } : {}),
        message: 'GitHub has no such item, or the credential cannot see it.',
        retry: NEVER,
      };
    case 'rate_limited':
      return {
        kind: 'resource_exhausted',
        message: 'GitHub rate limited the request.',
        retry:
          error.retryAfterMs === undefined
            ? SAME_REQUEST
            : {
                kind: 'same_request',
                delayMs: Math.min(
                  86_400_000,
                  Math.max(0, Math.round(error.retryAfterMs)),
                ),
              },
      };
    case 'timeout':
      return {
        kind: 'deadline_exceeded',
        message: 'The GitHub request timed out.',
        retry: SAME_REQUEST,
      };
    case 'unavailable':
      return {
        kind: 'unavailable',
        message: 'GitHub is unavailable.',
        retry: SAME_REQUEST,
      };
    case 'cancelled':
      return {
        kind: 'cancelled',
        message: 'The GitHub request was cancelled.',
        retry: NEVER,
      };
    case 'projection_unavailable':
      return {
        kind: 'capability_unavailable',
        message: 'This context reads no canonical result from GitHub.',
        retry: NEVER,
      };
    case 'invalid_response':
      return {
        kind: 'internal',
        message: 'GitHub returned an unexpected response.',
        retry: NEVER,
      };
    case 'duplicate':
      return {
        kind: 'already_exists',
        message: 'GitHub reports an open pull request for the head branch.',
        retry: NEVER,
      };
    case 'base_rejected':
      return {
        kind: 'failed_precondition',
        ...(codes.baseRejected ? { code: codes.baseRejected } : {}),
        message: 'GitHub refused the base branch.',
        retry: { kind: 'after_refresh', resource: 'github-branch' },
      };
  }
}

/**
 * The canonical error for a failure of the request handle. The host's own
 * error stays the runtime cause, so in-process projections rethrow it; the
 * canonical message never carries a URL, path or provider text.
 */
export function gitHubFailure(
  error: unknown,
  codes: GitHubFailureCodes,
): CanopyOperationError {
  if (error instanceof CanopyOperationError) return error;
  if (error instanceof GitHubRequestError)
    return new CanopyOperationError(
      payloadFor(error, codes),
      error.cause ?? error,
    );
  return new CanopyOperationError(
    {
      kind: 'internal',
      message: 'The GitHub request failed.',
      retry: NEVER,
    },
    error,
  );
}

/**
 * {@link gitHubFailure} for a keyed instruction: a request a retry may
 * repeat is retried with the same idempotency key.
 */
export function keyedGitHubFailure(
  error: unknown,
  codes: GitHubFailureCodes,
): CanopyOperationError {
  const failure = gitHubFailure(error, codes);
  const { retry } = failure.payload;
  if (retry.kind !== 'same_request') return failure;
  return new CanopyOperationError(
    {
      ...failure.payload,
      retry: {
        kind: 'same_idempotency_key',
        ...(retry.delayMs === undefined ? {} : { delayMs: retry.delayMs }),
      },
    },
    failure.runtimeCause,
  );
}

/**
 * Opaque continuations authenticated with a per-process key: a cursor names
 * a position for exactly the params (and snapshot) it was minted for, and
 * becomes invalid on restart, as a listing continuation may.
 */
export function createContinuations(): {
  mint(position: string, binding: string): string;
  read(cursor: string, binding: string): string | null;
} {
  const key = randomBytes(32);
  const sign = (position: string, binding: string): string =>
    createHmac('sha256', key)
      .update(`${position}\n${binding}`)
      .digest('base64url');
  return {
    mint: (position, binding) =>
      `${Buffer.from(position).toString('base64url')}.${sign(position, binding)}`,
    read: (cursor, binding) => {
      const match = /^([\w-]*)\.([\w-]{43})$/.exec(cursor);
      if (!match) return null;
      const position = Buffer.from(match[1], 'base64url').toString('utf8');
      const expected = Buffer.from(sign(position, binding));
      const actual = Buffer.from(match[2]);
      return expected.length === actual.length &&
        timingSafeEqual(expected, actual)
        ? position
        : null;
    },
  };
}
