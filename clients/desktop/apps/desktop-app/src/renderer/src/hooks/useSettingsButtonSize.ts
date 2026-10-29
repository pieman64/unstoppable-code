import type { ButtonSize } from '@canopy/ui-shared/components';

/** Settings actions consistently use the shared 28px capsule. */
export function useSettingsButtonSize(): ButtonSize {
  return 'compact';
}
