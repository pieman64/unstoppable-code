import type {
  InAppNotificationPlacement,
  InAppNotificationPreferences,
} from '@canopy/desktop-shared/types';
import { useSyncExternalStore } from 'react';
import {
  getInAppNotificationPlacement,
  subscribeToInAppNotificationPrefs,
} from './osNotifications';

/** The shared stack defaults to the top-right corner below the header. */
export function defaultInAppNotificationPlacement(): InAppNotificationPlacement {
  return 'top-right';
}

/**
 * Preferences with a corner the user picked. The flag tells the loader it is
 * a choice, not a default an older build saved.
 */
export function withChosenInAppNotificationPlacement(
  prefs: InAppNotificationPreferences,
  placement: InAppNotificationPlacement,
): InAppNotificationPreferences {
  return { ...prefs, placement, placementChosen: true };
}

/** The corner this window's notifications use: the user's pick, or the default. */
export function useInAppNotificationPlacement(): InAppNotificationPlacement {
  const chosen = useSyncExternalStore(
    subscribeToInAppNotificationPrefs,
    getInAppNotificationPlacement,
    getInAppNotificationPlacement,
  );
  return chosen ?? defaultInAppNotificationPlacement();
}
