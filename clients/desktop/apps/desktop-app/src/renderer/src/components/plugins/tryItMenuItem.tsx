import {
  DETAIL_PRIMARY_CTA_TRY_BUSY_LABEL,
  DETAIL_PRIMARY_CTA_TRY_LABEL,
  type DetailMoreMenuItem,
} from '@canopy/ui-shared/components';
import { ChatIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { TryItLaunchController } from './TryItPrimaryCta';

/**
 * Try it as a detail's ⋯ menu item, for when another action takes the
 * primary slot (CAN-5306). Same launch, label and availability as the CTA.
 */
export function tryItMenuItem(
  launch: TryItLaunchController,
): DetailMoreMenuItem {
  return {
    id: 'try-it',
    label: launch.launching
      ? DETAIL_PRIMARY_CTA_TRY_BUSY_LABEL
      : DETAIL_PRIMARY_CTA_TRY_LABEL,
    icon: <ChatIcon />,
    testId: 'skill-read-detail-try-it',
    onSelect: launch.onTry,
    disabled: launch.launching || launch.state !== 'try',
  };
}
