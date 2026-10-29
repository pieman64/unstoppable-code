import {
  getMainWindowMaterialOptions,
  getNativeThemeSource,
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

describe('getNativeThemeSource', () => {
  it.each(['light', 'dark', 'system'] as const)(
    'maps the app %s appearance to the same native theme source',
    (colorMode) => {
      expect(getNativeThemeSource(colorMode)).toBe(colorMode);
    },
  );
});
