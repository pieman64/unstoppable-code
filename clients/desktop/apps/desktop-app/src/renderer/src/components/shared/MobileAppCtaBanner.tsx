import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import { Smartphone } from 'lucide-react';
import {
  CtaBanner,
  type CtaBannerAlign,
} from '@canopy/ui-shared/components/CtaBanner';
import {
  MobileAppQrPromo,
  type MobileAppQrLink,
} from '@canopy/ui-shared/components/MobileAppQrPromo';
import type { MobileAppStore } from '@canopy/ui-shared/components/StoreBadgeLink';
import { brandText } from '@/lib/brand';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useMobileAppPromo } from '@/hooks/useMobileAppPromo';
import { useStoreQrCodes } from '@/hooks/useStoreQrCodes';
import { useInAppNotificationPlacement } from '@/lib/useInAppNotificationPlacement';

/**
 * Desktop adapter wiring the generic {@link CtaBanner} to the mobile-app promo.
 *
 * Mounts inside the in-app notification stack (beside `GuestUpgradeNudge` and
 * the toasts) rather than portalling into the bottom status host — a
 * promotional CTA is not a status indicator, and the stack already follows the
 * user's corner placement preference.
 *
 * Gates on the shared `useMobileAppPromo` state, so it is mutually exclusive
 * with `GuestUpgradeNudge` (which gates on guest) by construction, and it
 * unmounts cleanly — taking any open popover with it — the moment activation is
 * detected or the Overview card is dismissed.
 *
 * Dismissal reuses the existing 24h snooze shared with the Overview card, so
 * one "not now" quiets both surfaces.
 */
export function MobileAppCtaBanner(): JSX.Element | null {
  const { links, showPromotional, snooze } = useMobileAppPromo();
  // The pill hugs its copy rather than filling the notification column, so it
  // no longer inherits that column's edge for free. Subscribed, not read once:
  // `NotificationsTab` changes placement live, without a reload.
  const placement = useInAppNotificationPlacement();
  const align: CtaBannerAlign =
    placement === 'top-right' || placement === 'bottom-right' ? 'end' : 'start';
  // Latched: QR generation starts on the first popover open and the codes stay
  // cached for later opens, so re-expanding never flashes an empty tile.
  const [qrRequested, setQrRequested] = useState(false);
  const qrCodes = useStoreQrCodes(links, qrRequested);

  const qrLinks = useMemo<readonly MobileAppQrLink[]>(
    () => links.map((link) => ({ ...link, qrSrc: qrCodes[link.store] })),
    [links, qrCodes],
  );

  const [popoverOpen, setPopoverOpen] = useState(false);
  const handlePopoverOpenChange = useCallback((open: boolean): void => {
    setPopoverOpen(open);
    if (open) {
      setQrRequested(true);
    }
  }, []);

  const show = showPromotional && links.length > 0;
  // This adapter is rendered unconditionally by `App.tsx`, so it stays mounted
  // (returning null) when `show` flips false, while the `CtaBanner` that owns
  // the real open state unmounts without reporting the close. Without this
  // reset, eligibility returning in the same session — snooze cleared, account
  // switched back — would describe an open popover that is not on screen.
  useEffect((): void => {
    if (!show) {
      setPopoverOpen(false);
    }
  }, [show]);

  useCurrentUiStateReporter(
    'mobileAppCtaBanner.pill',
    show ? { open: true, popoverOpen } : null,
  );

  if (!show) {
    return null;
  }

  const openStore = (_store: MobileAppStore, url: string): void => {
    void window.api.browser.openExternal({ url });
  };

  return (
    <CtaBanner
      data-testid="mobile-app-cta-banner"
      icon={<Smartphone size={16} aria-hidden="true" />}
      message={`Get ${brandText.appName} on your phone`}
      actionLabel="Get the app"
      align={align}
      onDismiss={snooze}
      dismissAriaLabel={`Dismiss the ${brandText.appName} mobile app reminder`}
      popoverAriaLabel={`${brandText.appName} mobile apps`}
      onPopoverOpenChange={handlePopoverOpenChange}
    >
      <MobileAppQrPromo
        brandDisplayName={brandText.appName}
        links={qrLinks}
        activation={{ kind: 'callback', onActivate: openStore }}
        heading={`Scan to get ${brandText.appName}`}
      />
    </CtaBanner>
  );
}
