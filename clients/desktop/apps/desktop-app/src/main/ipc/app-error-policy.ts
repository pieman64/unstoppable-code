import { is } from '@electron-toolkit/utils';
import { showsRawErrorDetail } from '@canopy/protocol/app-errors';

/** Build facts are evaluated per call; absent or broken policy fails closed. */
export function ipcShowsRawErrorDetail(): boolean {
  try {
    if (
      __CANOPY_E2E__ &&
      process.env.CANOPY_E2E_FORCE_STABLE_APP_ERRORS === '1'
    )
      return false;
    return showsRawErrorDetail({
      releaseFlavor:
        typeof __CANOPY_RELEASE_FLAVOR__ === 'undefined'
          ? undefined
          : __CANOPY_RELEASE_FLAVOR__,
      isDevelopment: is.dev,
    });
  } catch {
    return false;
  }
}
