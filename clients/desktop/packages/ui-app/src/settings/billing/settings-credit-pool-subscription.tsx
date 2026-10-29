'use client';

import { useSettingsCreditPoolSubscription } from '@canopy/app-state/settings';
import { useSettingsClient } from '../host';
import type { CreditPoolSubscriptionSlotProps } from './billing-settings-slots';

/**
 * A wallet's live `credit.pool` signals through the host's settings client,
 * for hosts that mount no inline billing UI. A signal only asks the section
 * to read the wallet again; it never carries a balance. Renders nothing.
 */
export function SettingsCreditPoolSubscription({
  organizationId,
  onSignal,
  onReconnect,
}: CreditPoolSubscriptionSlotProps): null {
  const client = useSettingsClient();
  useSettingsCreditPoolSubscription({
    client,
    ...(organizationId === undefined ? {} : { organizationId }),
    onSignal,
    onReconnect,
  });
  return null;
}
