import type { JSX } from 'react';
import type { SharedByYouFacts } from '@canopy/ui-app/sharing';
import { MarketplaceShareDetails } from '../plugins/MarketplaceShareDetails';
export function PipelinePublicShareRow({
  remoteId,
  facts,
  name,
  readFacts,
}: {
  remoteId: string;
  initialShare?: SharedByYouFacts['publicShare'];
  canManage?: boolean;
  facts?: SharedByYouFacts;
  name?: string;
  readFacts?: SharedByYouFacts;
}): JSX.Element {
  return (
    <MarketplaceShareDetails
      key={remoteId}
      kind="pipeline"
      itemId={remoteId}
      facts={facts}
      readFacts={readFacts}
      name={name}
    />
  );
}
