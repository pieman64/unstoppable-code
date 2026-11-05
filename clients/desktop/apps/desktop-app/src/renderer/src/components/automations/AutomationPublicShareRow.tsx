import type { JSX } from 'react';
import type { SharedByYouFacts } from '@canopy/ui-app/sharing';
import { MarketplaceShareDetails } from '../plugins/MarketplaceShareDetails';
export function AutomationPublicShareRow({
  remoteId,
  facts,
  name,
}: {
  remoteId: string;
  initialShare?: SharedByYouFacts['publicShare'];
  canManage?: boolean;
  facts?: SharedByYouFacts;
  name?: string;
}): JSX.Element {
  return (
    <MarketplaceShareDetails
      key={remoteId}
      kind="automation"
      itemId={remoteId}
      facts={facts}
      name={name}
    />
  );
}
