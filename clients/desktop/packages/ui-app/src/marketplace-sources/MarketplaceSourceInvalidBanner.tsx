'use client';

import type { JSX } from 'react';
import type { MarketplaceSource } from '@canopy/app-core/client';
import { MarketplaceSourceStatusNotice } from './MarketplaceSourceStatusNotice';
import type { UseMarketplaceSourcesResult } from './useMarketplaceSources';

export interface MarketplaceSourceInvalidBannerProps {
  readonly source: MarketplaceSource;
  readonly state: UseMarketplaceSourcesResult;
}

/**
 * Invalid-source banner with the recovery actions this source permits.
 * Refresh only re-reads status; Update is the repair attempt. Never offers
 * Remove: removal stays on the row, where protected rows have none.
 */
export function MarketplaceSourceInvalidBanner({
  source,
  state,
}: MarketplaceSourceInvalidBannerProps): JSX.Element | null {
  const busy = state.operations[source.id] !== undefined;
  return (
    <MarketplaceSourceStatusNotice
      source={source}
      updating={busy}
      refreshing={state.refreshing || Object.keys(state.operations).length > 0}
      onUpdate={() => void state.update(source.id)}
      onRefresh={() => void state.refresh()}
    />
  );
}
