export const DESKTOP_SIDEBAR_SHADOW_STORAGE_KEY =
  'canopy.dev.desktopSidebarShadow';

export function isDesktopSidebarShadowEnabled(): boolean {
  if (!window.devInfo?.isDev && !__CANOPY_E2E__) return false;
  if (__CANOPY_DESKTOP_SIDEBAR_SHADOW__) return true;
  try {
    return (
      window.localStorage.getItem(DESKTOP_SIDEBAR_SHADOW_STORAGE_KEY) === '1'
    );
  } catch {
    return false;
  }
}
