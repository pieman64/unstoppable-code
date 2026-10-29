import { useMemo, type JSX } from 'react';
import { DialogModal } from '@/components/shared/DialogModal';
import { useStoreQrCodes } from '@/hooks/useStoreQrCodes';
import { brandText } from '@/lib/brand';
import {
  MobileAppQrPromo,
  type MobileAppQrLink,
} from '@canopy/ui-shared/components/MobileAppQrPromo';
import type {
  MobileAppStore,
  MobileAppStoreLink,
} from '@canopy/ui-shared/components/StoreBadgeLink';

interface OnboardingMobileAppDialogProps {
  links: readonly MobileAppStoreLink[];
  onClose: () => void;
}

/** Reuse the standalone mobile CTA's QR/store experience from either checklist host. */
export function OnboardingMobileAppDialog({
  links,
  onClose,
}: OnboardingMobileAppDialogProps): JSX.Element {
  const qrCodes = useStoreQrCodes(links, true);
  const qrLinks = useMemo<readonly MobileAppQrLink[]>(
    () => links.map((link) => ({ ...link, qrSrc: qrCodes[link.store] })),
    [links, qrCodes],
  );
  const openStore = (_store: MobileAppStore, url: string): void => {
    void window.api.browser.openExternal({ url });
  };
  return (
    <DialogModal title="Get the mobile app" onClose={onClose} maxWidth="sm">
      <div className="flex justify-center">
        <MobileAppQrPromo
          brandDisplayName={brandText.appName}
          links={qrLinks}
          activation={{ kind: 'callback', onActivate: openStore }}
          heading={`Scan to get ${brandText.appName}`}
          description="Keep your agents going on the go"
        />
      </div>
    </DialogModal>
  );
}
