import type { JSX } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { MobileAppPromo } from '@canopy/ui-shared/components/MobileAppPromo';
import type { MobileAppStore } from '@canopy/ui-shared/components/StoreBadgeLink';
import { brandText } from '@/lib/brand';
import { useMobileAppPromo } from '@/hooks/useMobileAppPromo';

/**
 * Mobile app install story inside the Remote Control modal.
 *
 * This is a **deliberate download surface**: the user opened the modal looking
 * for exactly this, so it is never suppressed by activation or the snooze. It
 * is suppressed when the brand declares no listings, and for signed-out and
 * guest accounts — the two states where the modal is already asking the user to
 * sign in or start a trial, and a second CTA under that ask only splits it. See
 * `showPermanent` in `lib/mobile-app-promo.ts`; the modal subtitle names the
 * mobile app in those states instead.
 *
 * Appended once, unconditionally, as the last child of the modal body. Every
 * block above it is state-conditional, so one placement covers the connected
 * states without duplicating into branches, and the body's `space-y-4` gives
 * separation for free. Placing it first would put a promo above the primary
 * connect flow.
 */
export function RemoteControlMobileAppsCta(): JSX.Element | null {
  const { links, showPermanent } = useMobileAppPromo();

  if (!showPermanent) {
    return null;
  }

  const openStore = (_store: MobileAppStore, url: string): void => {
    void window.api.browser.openExternal({ url });
  };

  return (
    <div
      data-testid="remote-control-mobile-apps-cta"
      className="border-t border-line-accent/40 pt-4"
    >
      <MobileAppPromo
        brandDisplayName={brandText.appName}
        links={links}
        activation={{ kind: 'callback', onActivate: openStore }}
        variant="inline"
        heading={`Use ${REMOTE_CONTROL_LABEL} from your phone`}
        description={`Install the ${brandText.appName} mobile app to watch and steer these agents while you are away from this machine.`}
      />
    </div>
  );
}
