import type {
  CustomizeSettingsPort,
  CustomizeSettingsTarget,
} from '@canopy/ui-app/settings/customize';
import {
  marketplaceManagementDestination,
  type InstalledItemSnapshotState,
} from '@canopy/ui-shared/lib';
import { useDesktopInstalledItemStatuses } from '@/hooks/useDesktopInstalledItemStatuses';
import { useNavigationStore } from '@/stores/navigationStore';

function useDesktopSnapshotState(): InstalledItemSnapshotState {
  return useDesktopInstalledItemStatuses().state;
}

function openCustomize(target: CustomizeSettingsTarget): void {
  const navigation = useNavigationStore.getState();
  navigation.closeSettings();
  navigation.openPluginsNavigation({
    kind: 'marketplace-browse',
    ...(target === 'active'
      ? marketplaceManagementDestination('installed', 'active')
      : marketplaceManagementDestination('mcp')),
  });
}

/** Desktop's Customize port: main's snapshot, and closing Settings to leave. */
export const DESKTOP_CUSTOMIZE_SETTINGS_PORT: CustomizeSettingsPort = {
  useInstalledItemSnapshotState: useDesktopSnapshotState,
  openCustomize,
};
