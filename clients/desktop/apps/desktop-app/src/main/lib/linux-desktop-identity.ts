import { BRAND } from '@canopy/brand/current';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { DesktopBrandRuntime } from '@canopy/protocol/brand';
import type { App } from 'electron';
import { getRuntimeAppName } from './app-identity';

export function configureLinuxDesktopIdentity(
  app: Pick<App, 'setName'>,
  brand: Pick<DesktopBrandRuntime, 'displayName' | 'cliName'> = BRAND,
): void {
  if (hostOperatingSystem() !== 'linux') return;
  app.setName(getRuntimeAppName(brand.displayName));
  // Electron 42's desktopName setter is internal. Its Linux host reads this
  // value for WM_CLASS/Wayland app_id and libnotify's desktop-entry hint,
  // which resolves the installed entry's Name and Icon. Match the builder.
  process.env.CHROME_DESKTOP = `${brand.cliName}-desktop.desktop`;
}
