import { useEffect, useState } from 'react';
import type {
  ProviderCarryoverProvider,
  ProviderCarryoverSummary,
} from '@canopy/desktop-shared/types';

/**
 * What a connected provider carries over from the user's own setup. Read once
 * the provider is connected (`enabled`), and again when `refreshKey` changes,
 * so a fresh sign-in re-reads. `null` while nothing is known: before the
 * read, while disconnected, and after a failed read.
 */
export function useProviderCarryover(
  provider: ProviderCarryoverProvider,
  enabled: boolean,
  refreshKey = 0,
): ProviderCarryoverSummary | null {
  const [summary, setSummary] = useState<ProviderCarryoverSummary | null>(null);
  useEffect(() => {
    // A new provider starts from nothing: the previous provider's line must
    // not stand in while this one's read is pending.
    setSummary(null);
    if (!enabled) return;
    let cancelled = false;
    let read: Promise<ProviderCarryoverSummary | null>;
    try {
      read = window.api.getProviderCarryover(provider);
    } catch {
      // A host without the read (an older preload in a test harness) shows
      // nothing rather than a guess.
      read = Promise.resolve(null);
    }
    void read
      .catch((): null => null)
      .then((next) => {
        if (!cancelled) setSummary(next);
      });
    return (): void => {
      cancelled = true;
    };
  }, [provider, enabled, refreshKey]);
  // Only this provider's answer, and only while connected: a late answer for
  // another provider, or one that arrives after a sign-out, shows nothing.
  return enabled && summary?.provider === provider ? summary : null;
}
