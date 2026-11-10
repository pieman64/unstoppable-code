import { useEffect, useState } from 'react';
import type { MarketplaceInfo } from '@canopy/execution-engine/types/plugins';

/**
 * Read-only marketplace snapshot for related-item computation (CAN-2382).
 * Deliberately NOT `useMarketplaceList`: that hook subscribes to marketplace
 * operation progress on `window.plugins` unconditionally, which crashes hosts
 * (and jsdom tests) that never touch the plugins bridge. Fail-soft on any
 * error: consumers fall back to their empty states.
 */
export function useInstalledMarketplaces(): {
  marketplaces: MarketplaceInfo[];
  loading: boolean;
} {
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const result = await window.plugins.loadMarketplaces();
        if (!cancelled && result.success && result.data) {
          setMarketplaces(result.data.marketplaces);
        }
      } catch {
        // Consumers fall back to their empty states.
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);
  return { marketplaces, loading };
}
