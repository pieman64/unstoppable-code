import type { PostHogSessionState } from '@canopy/desktop-shared/types/observability';

/** PostHog bootstrap requires UUIDv7, with a timestamp no more than one
 * minute in the future. The browser owns idle and maximum-age rotation. */
export function isValidPostHogSessionId(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    return false;
  const timestamp = Number.parseInt(value.slice(0, 13).replace('-', ''), 16);
  const age = Date.now() - timestamp;
  return age >= -60_000;
}

export function isPostHogSessionState(
  value: unknown,
): value is PostHogSessionState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sessionId' in value &&
    isValidPostHogSessionId(value.sessionId) &&
    'revision' in value &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}
