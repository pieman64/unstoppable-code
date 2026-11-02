import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { usesNativeWindowFrame } from '@canopy/desktop-shared/platform-capabilities';
import type { BrowserWindowConstructorOptions } from 'electron';

type TitleBarOptions = Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay' | 'frame'
>;

/** Preserve existing macOS/Windows chrome; let Linux draw native controls. */
export function getWindowTitleBarOptions(
  customOptions: TitleBarOptions,
  platform: NodeJS.Platform = hostPlatformOperatingSystem(),
): TitleBarOptions {
  return usesNativeWindowFrame(platform) ? { frame: true } : customOptions;
}
