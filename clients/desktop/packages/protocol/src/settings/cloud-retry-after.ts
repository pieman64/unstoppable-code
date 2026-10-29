// ---------------------------------------------------------------------------
// `Retry-After` reading for `/cloud/*` responses.
//
// Moved verbatim from `apps/web/src/components/chat/cloud-request-error.ts`,
// which re-exports it, so the shared GitHub repository client and the chat
// fetch layer cap and parse the header the same way. Browser-safe.
// ---------------------------------------------------------------------------

/** The response headers `readRetryAfterSeconds` reads (a `Headers` qualifies). */
export interface RetryAfterHeaders {
  get(name: string): string | null;
}

/** Ceiling on an honored `Retry-After`, so a bad header cannot stall a click. */
const MAX_RETRY_AFTER_SECONDS = 30;

/**
 * A response's `Retry-After` in seconds, capped at 30, or null when absent or
 * in the HTTP-date form. Also read off a success: a 202 for a repository
 * project still being set up says when to check again.
 */
export function readRetryAfterSeconds(
  headers: RetryAfterHeaders,
): number | null {
  const raw = headers.get('Retry-After');
  if (raw === null) return null;
  const value = raw.trim();
  if (!/^[0-9]+$/.test(value)) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}
