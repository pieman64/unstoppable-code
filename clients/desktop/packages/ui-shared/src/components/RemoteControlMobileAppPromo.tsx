import type { JSX } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { MobileAppPromo } from './MobileAppPromo';
import type {
  MobileAppStoreLink,
  StoreBadgeActivation,
} from './StoreBadgeLink';

export interface RemoteControlMobileAppPromoProps {
  brandDisplayName: string;
  links: readonly MobileAppStoreLink[];
  activation: StoreBadgeActivation;
  visible: boolean;
  className?: string;
  'data-testid'?: string;
}

/** Deliberate download offer shared by both Remote Control hosts. */
export function RemoteControlMobileAppPromo({
  brandDisplayName,
  links,
  activation,
  visible,
  className,
  'data-testid': dataTestId,
}: RemoteControlMobileAppPromoProps): JSX.Element | null {
  if (!visible || links.length === 0) return null;
  return (
    <div
      data-testid={dataTestId}
      className={`border-t border-line-accent/40 pt-4 ${className ?? ''}`}
    >
      <MobileAppPromo
        brandDisplayName={brandDisplayName}
        links={links}
        activation={activation}
        variant="inline"
        heading={`Use ${REMOTE_CONTROL_LABEL} from your phone`}
        description={`Install the ${brandDisplayName} mobile app to monitor your agents and manage your projects from your phone.`}
      />
    </div>
  );
}
