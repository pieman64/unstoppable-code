import type { UsageFetchErrorKind } from '../types/observability';

/**
 * Classify a raw provider usage-fetch failure message into a broad
 * {@link UsageFetchErrorKind}. This is the string-based fallback for failures
 * whose only context is an opaque message (the Codex app-server surfaces
 * upstream HTTP failures as JSON-RPC error strings such as
 * `failed to fetch codex rate limits: GET https://.../usage failed: 404 Not
 * Found; content-type=; body=`). Call sites that know the failure
 * structurally (an HTTP status they issued themselves, a credential-store
 * read failure) should map to a kind directly instead of round-tripping
 * through this matcher.
 *
 * Match order matters: auth markers win over status-code buckets so a
 * `401 Unauthorized` is `auth`, not `service`; network transport markers win
 * over `404`/`5xx` because a transport failure has no meaningful status.
 * Only explicit throttling evidence is `rate_limited`: the resource name
 * `rate limits` (as in `failed to fetch codex rate limits`) is not.
 */
export function classifyUsageFetchErrorMessage(
  message: string,
): UsageFetchErrorKind {
  const normalized = message.toLowerCase();

  if (
    /\b40[13]\b/.test(normalized) ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('token_revoked') ||
    normalized.includes('token revoked') ||
    normalized.includes('invalidated oauth') ||
    normalized.includes('credential')
  ) {
    return 'auth';
  }

  if (
    /\be(notfound|connrefused|connreset|timedout|ai_again|hostunreach|netunreach|pipe)\b/.test(
      normalized,
    ) ||
    normalized.includes('fetch failed') ||
    normalized.includes('network') ||
    normalized.includes('socket hang up') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('offline') ||
    normalized.includes('could not reach') ||
    normalized.includes('dns')
  ) {
    return 'network';
  }

  if (
    /\b429\b/.test(normalized) ||
    normalized.includes('too many requests') ||
    /\brate[ _-]?limited\b/.test(normalized) ||
    /\brate[ _-]?limit[ _-]?(exceeded|error)\b/.test(normalized)
  ) {
    return 'rate_limited';
  }

  if (/\b404\b/.test(normalized) || normalized.includes('not found')) {
    return 'unsupported';
  }

  if (
    /\b5\d\d\b/.test(normalized) ||
    normalized.includes('internal server error') ||
    normalized.includes('bad gateway') ||
    normalized.includes('service unavailable') ||
    normalized.includes('overloaded') ||
    normalized.includes('invalid') ||
    normalized.includes('unreadable') ||
    normalized.includes('malformed')
  ) {
    return 'service';
  }

  return 'unknown';
}

/**
 * Map an HTTP status from a usage request the app issued itself to a
 * {@link UsageFetchErrorKind}. Used by call sites (e.g. the Claude usage
 * fetch) that have the numeric status rather than an opaque message.
 */
export function classifyUsageFetchHttpStatus(
  status: number,
): UsageFetchErrorKind {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 404) {
    return 'unsupported';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  return 'service';
}

/**
 * User-safe headline for a failed usage fetch of `label` (e.g. `Claude`).
 * Shared by the desktop usage notices and the Remote Control projection, which
 * must never forward the raw provider/transport message.
 */
export function usageFetchErrorHeadline(
  kind: UsageFetchErrorKind,
  label: string,
): string {
  switch (kind) {
    case 'auth':
      return `Sign in to ${label} again to see live usage.`;
    case 'network':
      return `Check your connection, then try reaching ${label} again.`;
    case 'service':
      return `${label} is not answering right now, so try again in a moment.`;
    case 'rate_limited':
      return `${label} is limiting usage checks right now. Try again later.`;
    case 'unsupported':
      return `This ${label} account doesn't expose usage details.`;
    case 'unknown':
      return `Try again to load ${label} usage.`;
  }
}
