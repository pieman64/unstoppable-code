import {
  getMainWindowMaterialOptions,
  getNativeThemeSource,
  getMainWindowStartupBackgroundColor,
} from '../lib/window-material';

describe('getMainWindowMaterialOptions', () => {
  it('uses the translucent under-window material on macOS', () => {
    expect(getMainWindowMaterialOptions('darwin')).toEqual({
      vibrancy: 'under-window',
      visualEffectState: 'active',
    });
  });

  it.each<NodeJS.Platform>(['win32', 'linux'])(
    'keeps the existing opaque window on %s',
    (platform) => {
      expect(getMainWindowMaterialOptions(platform)).toEqual({});
    },
  );
});

describe('getMainWindowStartupBackgroundColor', () => {
  it.each([
    ['default', false, '#F2F2ED'],
    ['default', true, '#0B0B0F'],
    ['dusk', false, '#F5F5F0'],
    ['dusk', true, '#131419'],
  ] as const)(
    'uses the %s recipe with effective dark mode %s',
    (theme, dark, color) => {
      expect(getMainWindowStartupBackgroundColor(theme, dark)).toBe(color);
    },
  );
});

describe('getNativeThemeSource', () => {
  it.each(['light', 'dark', 'system'] as const)(
    'maps the app %s appearance to the same native theme source',
    (colorMode) => {
      expect(getNativeThemeSource(colorMode)).toBe(colorMode);
    },
  );
});
