import type { JSX } from 'react';
import {
  CustomizeSettingsPortProvider,
  McpSettingsSection,
} from '@canopy/ui-app/settings/customize';
import { DESKTOP_CUSTOMIZE_SETTINGS_PORT } from './desktop-customize-settings-port';

/** Desktop's host for the shared MCP servers section in Settings → MCP. */
export function DesktopMcpSettingsSection(): JSX.Element {
  return (
    <CustomizeSettingsPortProvider value={DESKTOP_CUSTOMIZE_SETTINGS_PORT}>
      <McpSettingsSection />
    </CustomizeSettingsPortProvider>
  );
}
