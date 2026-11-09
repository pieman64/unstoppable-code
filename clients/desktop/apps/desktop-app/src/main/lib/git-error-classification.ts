import { classifyError } from '@canopy/protocol/app-errors/classification';
import { classifySystemError } from '@canopy/desktop-shared/node/lib/app-error-classification';
import { safeErrorProperty } from '@canopy/desktop-shared/ipc/app-error-rejection';

const MAX_DIAGNOSTIC_LENGTH = 4096;

export const GIT_AUTHENTICATION_FAILURE_PATTERNS = [
  /\bauth(?:entication)? failed\b/i,
  /could not read (?:username|password)/i,
  /terminal prompts disabled/i,
  /invalid (?:username|password)/i,
  /permission denied \(publickey\)/i,
  /http basic: access denied/i,
  /requested url returned error: (?:401|403)\b/i,
] as const;

/** Adapter stderr is evidence, never stable wire detail. Cancellation wins;
 * then disk exhaustion, credentials, rate limits, HTTP 5xx and network. */
export function classifyGitError<Value>(error: Value): Value {
  try {
    if (
      safeErrorProperty(error, 'name') === 'AbortError' ||
      safeErrorProperty(error, 'code') === 'ABORT_ERR' ||
      safeErrorProperty(error, 'code') === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    )
      return error;
    const text = ['message', 'stderr']
      .map((key): string => {
        const value = safeErrorProperty(error, key);
        if (typeof value === 'string')
          return value.slice(-MAX_DIAGNOSTIC_LENGTH);
        if (Buffer.isBuffer(value))
          return value.subarray(-MAX_DIAGNOSTIC_LENGTH).toString();
        return '';
      })
      .join('\n')
      .toLowerCase();
    if (
      /no space left on device|disk quota exceeded|\b(?:ENOSPC|EDQUOT)\b/i.test(
        text,
      )
    )
      return classifyError(error, 'external.disk_full');
    if (
      GIT_AUTHENTICATION_FAILURE_PATTERNS.some((pattern): boolean =>
        pattern.test(text),
      )
    )
      return classifyError(error, 'external.sign_in_required');
    if (/requested url returned error: 429\b|too many requests/i.test(text))
      return classifyError(error, 'external.rate_limited');
    if (/requested url returned error: 5\d\d\b/i.test(text))
      return classifyError(error, 'external.service_unavailable');
    if (
      /could not resolve (?:host|proxy)|network is (?:unreachable|down)/i.test(
        text,
      ) ||
      text.split('\n').some((line): boolean => {
        const access = line.indexOf('unable to access ');
        return access >= 0 && line.includes("couldn't resolve host", access);
      })
    )
      return classifyError(error, 'external.offline');
    if (
      /failed to connect|connection (?:reset|refused)|connection timed out/i.test(
        text,
      )
    )
      return classifyError(error, 'external.service_unavailable');
    return classifySystemError(error);
  } catch {
    return error;
  }
}

export function rethrowClassifiedGitError(error: unknown): never {
  throw classifyGitError(error);
}
