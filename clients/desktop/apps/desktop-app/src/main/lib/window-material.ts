import type { BrowserWindowConstructorOptions } from 'electron';
import type { ColorMode, ThemeName } from '@canopy/desktop-shared/types';
import themeRecipes from '@canopy/ui-shared/styles/theme-recipes.json';

export type NativeThemeSource = 'light' | 'dark' | 'system';

/** Electron/native macOS appearance matching the app's persisted color mode. */
export function getNativeThemeSource(colorMode: ColorMode): NativeThemeSource {
  return colorMode;
}

/** Approximate the selected theme until a mapped Linux window paints content. */
export function getMainWindowStartupBackgroundColor(
  theme: ThemeName,
  shouldUseDarkColors: boolean,
): string {
  return (themeRecipes[theme] ?? themeRecipes.default).base[
    shouldUseDarkColors ? 'dark' : 'light'
  ];
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
