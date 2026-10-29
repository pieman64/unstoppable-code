import { useEffect } from 'react';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import { useObservabilityStore } from '@/stores/observabilityStore';

/**
 * How long a provider's usage counts as fresh after the popover refreshed it.
 * Reopening within this window reuses the numbers instead of asking the
 * provider again.
 */
const USAGE_REFRESH_ON_OPEN_INTERVAL_MS = 30_000;

const lastRefreshedAt = new Map<AgentProviderType, number>();

/**
 * Refreshes a provider's plan usage as the composer's usage popover opens,
 * so the numbers are current without a refresh button. Hosts mount this only
 * while the popover is open.
 */
export function useUsageRefreshOnOpen(
  provider: AgentProviderType,
  enabled = true,
): void {
  const refresh = useObservabilityStore(
    (state) => state.refreshProviderUsageDetails,
  );
  useEffect(() => {
    if (!enabled) return;
    const now = Date.now();
    const last = lastRefreshedAt.get(provider);
    if (last !== undefined && now - last < USAGE_REFRESH_ON_OPEN_INTERVAL_MS) {
      return;
    }
    lastRefreshedAt.set(provider, now);
    // A failed read surfaces through the provider's error state, where the
    // popover offers to try again.
    void refresh(provider).catch(() => undefined);
  }, [enabled, provider, refresh]);
}

/** Forgets every provider's last refresh (tests start from a clean slate). */
export function resetUsageRefreshOnOpen(): void {
  lastRefreshedAt.clear();
}
