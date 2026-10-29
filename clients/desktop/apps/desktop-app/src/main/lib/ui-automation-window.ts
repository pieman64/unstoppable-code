import { app } from 'electron';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { isE2eBuild } from './e2e-gate';

export function isHeadlessUiAutomationLaunch(
  e2eBuild: boolean,
  packaged: boolean,
  env: NodeJS.ProcessEnv,
): boolean {
  const releaseLikeAutomation =
    !packaged && env.CANOPY_E2E_ISOLATED_LOGGING === '1';
  return (
    (e2eBuild || releaseLikeAutomation) && env.CANOPY_E2E_SHOW_WINDOW !== '1'
  );
}

export function shouldShowUiAutomationWindow(): boolean {
  return !isHeadlessUiAutomationLaunch(
    isE2eBuild(),
    app.isPackaged,
    process.env,
  );
}

/** Hidden X11 native windows can stop supplying compositor frames. */
export function getUiAutomationWindowWebPreferences(
  platform: NodeJS.Platform | null = hostOperatingSystem(),
  e2eBuild: boolean = isE2eBuild(),
  packaged: boolean = app.isPackaged,
  env: NodeJS.ProcessEnv = process.env,
): Pick<Electron.WebPreferences, 'offscreen'> {
  return platform === 'linux' &&
    isHeadlessUiAutomationLaunch(e2eBuild, packaged, env)
    ? { offscreen: true }
    : {};
}
