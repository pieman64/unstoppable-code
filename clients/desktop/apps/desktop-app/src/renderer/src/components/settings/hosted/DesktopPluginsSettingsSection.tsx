import type { JSX } from 'react';
import {
  CustomizeSettingsPortProvider,
  PluginsSettingsSection,
} from '@canopy/ui-app/settings/customize';
import { DESKTOP_CUSTOMIZE_SETTINGS_PORT } from './desktop-customize-settings-port';

/** Desktop's host for the shared Plugins section in Settings → Plugins. */
export function DesktopPluginsSettingsSection(): JSX.Element {
  return (
    <CustomizeSettingsPortProvider value={DESKTOP_CUSTOMIZE_SETTINGS_PORT}>
      <PluginsSettingsSection />
    </CustomizeSettingsPortProvider>
  );
}
