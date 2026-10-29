/**
 * @jest-environment jsdom
 */
import {
  DESKTOP_SIDEBAR_SHADOW_STORAGE_KEY,
  isDesktopSidebarShadowEnabled,
} from '../desktop-sidebar-shadow-flag';

describe('desktop sidebar shadow flag', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, 'devInfo', {
      configurable: true,
      value: { isDev: true, branch: 'test' },
    });
  });

  it('defaults off and enables only the hidden development preference', () => {
    expect(isDesktopSidebarShadowEnabled()).toBe(false);

    window.localStorage.setItem(DESKTOP_SIDEBAR_SHADOW_STORAGE_KEY, '1');

    expect(isDesktopSidebarShadowEnabled()).toBe(true);
  });

  it('ignores the hidden preference outside dev and test builds', () => {
    Object.defineProperty(window, 'devInfo', {
      configurable: true,
      value: { isDev: false, branch: null },
    });
    window.localStorage.setItem(DESKTOP_SIDEBAR_SHADOW_STORAGE_KEY, '1');

    expect(isDesktopSidebarShadowEnabled()).toBe(false);
  });

  it('stays disabled while development metadata is unavailable', () => {
    Reflect.deleteProperty(window, 'devInfo');
    window.localStorage.setItem(DESKTOP_SIDEBAR_SHADOW_STORAGE_KEY, '1');

    expect(isDesktopSidebarShadowEnabled()).toBe(false);
  });
});
