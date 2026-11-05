import { publishMarketplaceShare } from '@/lib/publishMarketplaceShare';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { mayChangeCanopyCloudIdentity } from '@/lib/canopyCloudAccountChange';
import {
  publicAudienceLocked,
  deriveExistingShare,
} from '@canopy/ui-app/sharing';
import { type JSX, useEffect, useRef, useState } from 'react';
import {
  MarketplaceOwnerRow,
  useResourceContext,
} from '@canopy/ui-app/capability';
import {
  sharedByYouRow,
  marketplaceShareLink,
  type SharedByYouAudience,
  type SharedByYouFacts,
  type SharedLinkKind,
} from '@canopy/ui-app/sharing';
import { useCloudOrigin } from '@/lib/cloud-origin';
import { copyTextToClipboard } from '@/lib/clipboard';
import { unshareMarketplaceResource } from '@/lib/marketplaceUnshare';
import { revokeMarketplacePublicShare } from '@/lib/revokePublicShare';
import { postShareToast } from '@/lib/share-toast';

function SharedByYouBound({
  kind,
  shareId,
  name,
  facts,
  onUnshared,
  onRefresh,
}: {
  kind: SharedLinkKind;
  shareId: string;
  name: string;
  facts: SharedByYouFacts;
  onUnshared: (audience: SharedByYouAudience) => void;
  onRefresh?: () => Promise<void>;
}): JSX.Element | null {
  const { personalOrganizationId } = useResourceContext();
  const origin = useCloudOrigin();
  const active = useRef(true);
  const generation = useRef(0);
  const [invalidatedFacts, setInvalidatedFacts] =
    useState<SharedByYouFacts | null>(null);
  useEffect(() => {
    active.current = true;
    const changed = (event: Event): void => {
      if (!mayChangeCanopyCloudIdentity(event)) return;
      active.current = false;
      generation.current += 1;
      setInvalidatedFacts(facts);
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
    return (): void => {
      active.current = false;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
    };
  }, [facts]);
  const [published, setPublished] = useState<{
    source: SharedByYouFacts['publicShare'];
    value: NonNullable<SharedByYouFacts['publicShare']>;
  } | null>(null);
  const pinnedFacts =
    published && published.source === facts.publicShare
      ? { ...facts, publicShare: published.value }
      : facts;
  const [removedSnapshot, setRemovedSnapshot] = useState<string | null>(null);
  const snapshotKey = `${shareId}:${facts.publicShare?.externalId ?? ''}:${facts.publicShare?.updatedAt ?? ''}`;
  const currentFacts =
    removedSnapshot === snapshotKey
      ? { ...pinnedFacts, publicShare: null }
      : pinnedFacts;
  const row = sharedByYouRow(currentFacts, personalOrganizationId, {
    identity: `${kind}:${shareId}`,
    deleteShare: {
      available: true,
      run: async (): Promise<void> => {
        if (!active.current)
          throw new Error('Sharing access changed. Refresh and try again.');
        await unshareMarketplaceResource(kind, shareId);
      },
    },
    revokePublicLink: {
      available: true,
      run: async (): Promise<void> => {
        if (!active.current)
          throw new Error('Sharing access changed. Refresh and try again.');
        await revokeMarketplacePublicShare(kind, shareId);
      },
    },
    ...(facts.canUpdate === true &&
    !publicAudienceLocked(deriveExistingShare(facts), personalOrganizationId)
      ? {
          refresh: {
            available: true as const,
            run: async (): Promise<void> => {
              if (!active.current)
                throw new Error(
                  'Sharing access changed. Refresh and try again.',
                );
              const attempt = generation.current;
              const next = await publishMarketplaceShare(kind, shareId);
              if (!active.current || attempt !== generation.current) return;
              setPublished({ source: facts.publicShare, value: next });
              if (onRefresh) {
                try {
                  await onRefresh();
                } catch {
                  postShareToast({
                    tone: 'warning',
                    message:
                      'The public link was updated. Refresh to see its current status.',
                  });
                }
              }
            },
          },
        }
      : {}),
    copy: {
      link: marketplaceShareLink(origin, kind, shareId),
      port: { write: copyTextToClipboard, notify: postShareToast },
    },
  });
  return invalidatedFacts === facts ? null : (
    <MarketplaceOwnerRow
      kind={kind}
      name={name}
      row={row}
      onUnshared={(mode) => {
        if (!active.current) return;
        if (mode === 'revoke') setRemovedSnapshot(snapshotKey);
        // Keep existing host refresh/navigation callbacks explicit about the effect.
        onUnshared(
          mode === 'revoke'
            ? {
                id: 'public',
                audience: 'public',
                name: 'Public link',
                action: { available: false, reason: 'Removed' },
              }
            : {
                id: 'account',
                audience: facts.shareScope === 'team' ? 'team' : 'organization',
                name: facts.owner?.name ?? '',
                alsoRevokesPublicLink: !!facts.publicShare,
                action: { available: false, reason: 'Unshared' },
              },
        );
        if (onRefresh)
          void onRefresh().catch(() =>
            postShareToast({
              tone: 'warning',
              message: 'The share changed. Refresh to see its current status.',
            }),
          );
      }}
    />
  );
}

export function SharedByYou(
  props: Parameters<typeof SharedByYouBound>[0],
): JSX.Element {
  return <SharedByYouBound key={`${props.kind}:${props.shareId}`} {...props} />;
}
