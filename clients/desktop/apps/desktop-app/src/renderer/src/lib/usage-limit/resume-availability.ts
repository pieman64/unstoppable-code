/**
 * Visibility logic for the Usage page/panel "Resume interrupted sessions"
 * button. The button is only offered when resuming could actually make
 * progress: a provider whose usage window is still pegged at 100% (and whose
 * reset time has not passed) would immediately re-limit anything resumed, so
 * a confirmed at-limit window suppresses the button. A window reported at
 * 100% whose `resetsAt` is already in the past is treated as stale data — the
 * limit has really reset even though the snapshot hasn't refreshed yet — and
 * does not block.
 */
import type { ProviderRateLimitSnapshot } from '@canopy/desktop-shared/types';

function resetsAtMs(resetsAt: string | number | undefined): number | undefined {
  if (resetsAt === undefined) {
    return undefined;
  }
  if (typeof resetsAt === 'number') {
    return resetsAt;
  }
  const parsed = Date.parse(resetsAt);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function windowBlocks(
  window: { usedPercent?: number; resetsAt?: string | number } | undefined,
  nowMs: number,
): boolean {
  if (window?.usedPercent === undefined || window.usedPercent < 100) {
    return false;
  }
  const resetMs = resetsAtMs(window.resetsAt);
  // An unparsable/absent reset time on a 100% window blocks: we can't prove
  // the limit has reset, and the rule is to hide only-if-reached, show
  // only-if-plausibly-resumable.
  return resetMs === undefined || resetMs > nowMs;
}

/**
 * True when any rate-limit window for the provider is confirmed still at its
 * limit (>= 100% used with no elapsed reset), meaning a resume would be
 * pointless right now.
 */
export function hasBlockingRateLimit(
  rateLimits: ProviderRateLimitSnapshot[] | undefined,
  nowMs: number,
): boolean {
  return (rateLimits ?? []).some(
    (limit) =>
      windowBlocks(limit.primary, nowMs) ||
      windowBlocks(limit.secondary, nowMs),
  );
}
