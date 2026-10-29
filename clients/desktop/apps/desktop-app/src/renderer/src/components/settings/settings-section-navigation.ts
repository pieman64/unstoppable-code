import { createContext, useContext } from 'react';
import type { SettingsSection } from '@canopy/desktop-shared/types';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * Switches the section the open Settings overlay shows. `SettingsOverlay`
 * provides it; a page that links to another section uses
 * {@link useOpenSettingsSection}. `openSettings` alone cannot do this: the
 * overlay follows the requested section only when it changes, so asking for
 * the section that opened Settings again would do nothing.
 */
export const SettingsSectionNavigationContext = createContext<
  ((section: SettingsSection) => void) | null
>(null);

/** Opens a Settings section, from inside Settings or anywhere else. */
export function useOpenSettingsSection(): (section: SettingsSection) => void {
  const navigate = useContext(SettingsSectionNavigationContext);
  const openSettings = useNavigationStore((state) => state.openSettings);
  return navigate ?? openSettings;
}
