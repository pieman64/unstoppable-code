import type { JSX } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { MobileAppPromo } from '@canopy/ui-shared/components/MobileAppPromo';
import type { MobileAppStore } from '@canopy/ui-shared/components/StoreBadgeLink';
import { brandText } from '@/lib/brand';
import { useMobileAppPromo } from '@/hooks/useMobileAppPromo';

/**
 * Home/overview nudge to install the companion mobile app.
 *
 * Renders `null` unless the brand declares store listings, the user is a
 * signed-in non-guest, the account has not already activated mobile, and the
 * shared snooze has lapsed.
 *
 * **Known gap, accepted:** `OverviewPage` early-returns to
 * `OverviewEmptyState` when `isFirstRun`, so this card never renders for a
 * user with zero code workspaces. Nudging someone with no workspaces to
 * install a companion app is premature, so the card is not duplicated into
 * that branch.
 *
 * Also note the brand is baked at build time and `brands/canopy/brand.json`
 * declares no `mobileApps`, so under the default brand this correctly renders
 * nothing in local dev.
 */
export function MobileAppPromoCard(): JSX.Element | null {
  const { links, showPromotional, snooze } = useMobileAppPromo();

  if (!showPromotional) {
    return null;
  }

  // The renderer must route every outbound URL through the main process and
  // never render `<a target="_blank">`.
  const openStore = (_store: MobileAppStore, url: string): void => {
    void window.api.browser.openExternal({ url });
  };

  return (
    <div className="rounded-lg border border-line-accent/40 bg-card p-4">
      <MobileAppPromo
        data-testid="mobile-app-promo-card"
        brandDisplayName={brandText.appName}
        links={links}
        activation={{ kind: 'callback', onActivate: openStore }}
        variant="inline"
        heading={`Take ${brandText.appName} with you`}
        description={`Check on your agents, approve work, and keep things moving from your phone with ${REMOTE_CONTROL_LABEL}.`}
        onDismiss={snooze}
      />
    </div>
  );
}
