/** @jest-environment jsdom */
import {
  DESKTOP_SHARED_SIDEBAR_STORAGE_KEY,
  isDesktopSharedSidebarEnabled,
} from '../desktop-shared-sidebar-flag';

describe('desktop shared sidebar switch', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to the shared sidebar (CAN-3053 flag flip)', () => {
    expect(isDesktopSharedSidebarEnabled()).toBe(true);
  });

  it('stays enabled for the explicit opt-in value', () => {
    window.localStorage.setItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY, '1');
    expect(isDesktopSharedSidebarEnabled()).toBe(true);
  });

  it("falls back to the legacy rail only for the '0' escape hatch", () => {
    window.localStorage.setItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY, '0');
    expect(isDesktopSharedSidebarEnabled()).toBe(false);
    window.localStorage.setItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY, 'false');
    expect(isDesktopSharedSidebarEnabled()).toBe(true);
  });
});
