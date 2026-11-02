import type { NoticeIntent } from '../components/Notice';

/** How long a success toast stays up: long enough to read, then it leaves. */
export const SUCCESS_TOAST_LIFETIME_MS = 6_000;

/**
 * A toast's lifetime in the shared `ToastStack`, by what it reports. A
 * failure stays until it is closed (`0`), so its `Try again` is never lost to
 * a timer; a success leaves after 6 s. `holdMs` is a longer lifetime a host
 * gives a toast the user may need to come back to (a share's Copy link); it
 * never shortens a failure's stay. Everything else keeps the host's
 * `defaultMs`.
 */
export function toastStackLifetimeMs(
  intent: NoticeIntent,
  defaultMs: number,
  holdMs?: number,
): number {
  if (intent === 'destructive') return 0;
  if (holdMs !== undefined) return holdMs;
  if (intent === 'positive') return SUCCESS_TOAST_LIFETIME_MS;
  return defaultMs;
}
