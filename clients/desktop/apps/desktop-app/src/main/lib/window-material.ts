import type { BrowserWindowConstructorOptions } from 'electron';
import type { ColorMode } from '@canopy/desktop-shared/types';

export type NativeThemeSource = 'light' | 'dark' | 'system';

/** Electron/native macOS appearance matching the app's persisted color mode. */
export function getNativeThemeSource(colorMode: ColorMode): NativeThemeSource {
  return colorMode;
}

/** Native material used behind the translucent main-window sidebar. */
export function getMainWindowMaterialOptions(
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, 'vibrancy' | 'visualEffectState'> {
  if (platform !== 'darwin') {
    return {};
  }

  return {
    vibrancy: 'under-window',
    visualEffectState: 'active',
  };
}
