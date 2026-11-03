import { type JSX, useMemo } from 'react';
import {
  SharedByYouSection,
  useResourceContext,
} from '@canopy/ui-app/capability';
import {
  sharedByYouAudiences,
  type SharedByYouAudience,
  type SharedByYouFacts,
} from '@canopy/ui-app/sharing';
import type { MarketplaceUnshareKind } from '@canopy/ui-shared/lib/marketplace-unshare';
import { brand } from '@/lib/brand';
import { copyTextToClipboard } from '@/lib/clipboard';
import { unshareMarketplaceResource } from '@/lib/marketplaceUnshare';
import { revokeMarketplacePublicShare } from '@/lib/revokePublicShare';
import { postShareToast } from '@/lib/share-toast';

/**
 * The desktop's "Shared by you" section (CAN-4842): the owner's audiences
 * for one shared item, each removed through the existing preload methods.
 * `shareId` is the key both transports take for `kind`, and the id the
 * account row's member link carries (CAN-5452).
 */
export function SharedByYou({
  kind,
  shareId,
  name,
  facts,
  onUnshared,
}: {
  kind: MarketplaceUnshareKind;
  shareId: string;
  name: string;
  facts: SharedByYouFacts;
  onUnshared: (audience: SharedByYouAudience) => void;
}): JSX.Element | null {
  const { personalOrganizationId } = useResourceContext();
  const audiences = useMemo(
    () =>
      sharedByYouAudiences(facts, personalOrganizationId, {
        deleteShare: {
          available: true,
          run: () => unshareMarketplaceResource(kind, shareId),
        },
        revokePublicLink: {
          available: true,
          run: () => revokeMarketplacePublicShare(kind, shareId),
        },
        copyLink: {
          target: { scheme: brand.internalName, kind, shareId },
          write: copyTextToClipboard,
          notify: postShareToast,
        },
      }),
    [facts, kind, personalOrganizationId, shareId],
  );
  return (
    <SharedByYouSection
      kind={kind}
      name={name}
      audiences={audiences}
      onUnshared={onUnshared}
    />
  );
}
