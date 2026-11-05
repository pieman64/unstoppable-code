import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { mayChangeCanopyCloudIdentity } from '@/lib/canopyCloudAccountChange';
import { DetailMoreMenu } from '@canopy/ui-shared/components';
import {
  useMarketplaceCopyLinkMenuItem,
  useResourceContext,
} from '@canopy/ui-app/capability';
import {
  marketplaceShareLink,
  marketplaceLinkAccess,
  type SharedByYouFacts,
} from '@canopy/ui-app/sharing';
import { SharedByYou } from './SharedByYou';
import { useCloudOrigin } from '@/lib/cloud-origin';
import { copyTextToClipboard } from '@/lib/clipboard';
import { postShareToast } from '@/lib/share-toast';

/** Read-only detail facts, never a management verdict inferred from canUpdate or a public snapshot. */
export function MarketplaceShareDetails({
  kind,
  itemId,
  facts: suppliedFacts,
  name: suppliedName,
  readFacts,
}: {
  kind: 'pipeline' | 'automation';
  itemId: string;
  facts?: SharedByYouFacts;
  readFacts?: SharedByYouFacts;
  name?: string;
}): JSX.Element {
  const [loaded, setLoaded] = useState<{
    id: string;
    facts: SharedByYouFacts;
    name: string;
  } | null>(null);
  const [deleted, setDeleted] = useState<string | null>(null);
  const [reconciled, setReconciled] = useState<{
    source: SharedByYouFacts | null;
    facts: SharedByYouFacts;
    name: string;
  } | null>(null);
  const [accountInvalidated, setAccountInvalidated] = useState(false);
  const generation = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return (): void => {
      active.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    let current = true;
    const attempt = generation.current;
    if (!suppliedFacts && itemId)
      void (async (): Promise<void> => {
        try {
          if (kind === 'pipeline') {
            const result = await window.pipelines.getShared({
              remoteId: itemId,
            });
            if (
              result.success &&
              result.data &&
              current &&
              attempt === generation.current
            )
              setLoaded({
                id: itemId,
                facts: result.data,
                name: result.data.name,
              });
          } else {
            const detail = await window.api.automations.getShared(itemId);
            if (current && attempt === generation.current)
              setLoaded({
                id: itemId,
                facts: detail,
                name: detail.automation.name,
              });
          }
        } catch {
          /* Unavailable management never blocks the rest of the detail. */
        }
      })();
    return (): void => {
      current = false;
    };
  }, [itemId, kind, suppliedFacts]);
  const origin = useCloudOrigin();
  const { personalOrganizationId } = useResourceContext();
  const baseFacts =
    suppliedFacts ??
    (loaded?.id === itemId ? loaded.facts : (readFacts ?? null));
  const facts = accountInvalidated
    ? null
    : reconciled?.source === baseFacts
      ? reconciled.facts
      : baseFacts;
  const name =
    suppliedName ??
    reconciled?.name ??
    (loaded?.id === itemId ? loaded.name : '');
  const refresh = useCallback(async (): Promise<void> => {
    const attempt = ++generation.current;
    let detail: { facts: SharedByYouFacts; name: string };
    if (kind === 'pipeline') {
      const result = await window.pipelines.getShared({ remoteId: itemId });
      if (!result.success || !result.data)
        throw new Error(result.error ?? 'Couldn’t refresh sharing.');
      detail = { facts: result.data, name: result.data.name };
    } else {
      const result = await window.api.automations.getShared(itemId);
      detail = { facts: result, name: result.automation.name };
    }
    if (!active.current || attempt !== generation.current) return;
    setReconciled({ source: baseFacts, ...detail });
    setAccountInvalidated(false);
  }, [baseFacts, itemId, kind]);
  useEffect(() => {
    const changed = (event: Event): void => {
      if (!mayChangeCanopyCloudIdentity(event)) return;
      generation.current += 1;
      setAccountInvalidated(true);
      void refresh().catch(() => {
        /* A failed read cannot retain management facts from another account. */
      });
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
    return (): void =>
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
  }, [refresh]);
  const link = marketplaceShareLink(origin, kind, itemId);
  const access = facts
    ? marketplaceLinkAccess(facts, personalOrganizationId)
    : null;
  const copy = useMarketplaceCopyLinkMenuItem(
    link && access && deleted !== itemId ? { link, access } : null,
    { write: copyTextToClipboard, notify: postShareToast },
  );
  return (
    <div data-testid={`${kind}-public-share-row`}>
      {copy && (
        <DetailMoreMenu
          name={name}
          items={[copy]}
          triggerTestId="plugins-entry-detail-more"
          menuTestId="plugins-entry-detail-menu"
        />
      )}
      {facts && deleted !== itemId && (
        <SharedByYou
          kind={kind}
          shareId={itemId}
          name={name}
          facts={facts}
          onRefresh={refresh}
          onUnshared={(audience) => {
            if (audience.id === 'account') setDeleted(itemId);
            else
              setReconciled({
                source: baseFacts,
                facts: { ...facts, publicShare: null },
                name,
              });
          }}
        />
      )}
    </div>
  );
}
