import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type AppAdvisorWindowOpenRequest,
  type AppAdvisorWindowState,
  type CancelCanopyPortalPairingCodeResponse,
  type RegenerateCanopyPortalPairingCodeResponse,
  type StartCanopyPortalResponse,
  type StopCanopyPortalResponse,
  type CanopyPortalState,
} from '@canopy/desktop-shared/types';
import { sendToWindow } from '../lib/window-send';
import {
  setCanopyPortalChatDispatcher,
  getCanopyPortalState,
  cancelCanopyPortalPairingCode,
  onCanopyPortalStateChanged,
  regenerateCanopyPortalPairingCode,
  setCanopyPortalWindowAccessor,
  startCanopyPortal,
  stopCanopyPortal,
} from '../portal/portal-session-manager';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { setPortalAppAdvisorSurfaces } from '../portal/app-advisor-portal-surfaces';
import { registerIpcHandler } from './register';

/**
 * Window accessors the portal layer needs at registration time: the main
 * window for command routing, plus the App Advisor window surfaces the
 * `portal.app_advisor.*` adapter dispatches through (CAN-2565).
 */
export interface CanopyPortalWindowAccessors {
  getMainWindow: () => BrowserWindow | null;
  getAppAdvisorWindow: () => BrowserWindow | null;
  openAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
  ensureAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
}

export function registerCanopyPortalHandlers(
  accessors: CanopyPortalWindowAccessors,
  dispatcher: DesktopCanopyDispatcher,
): void {
  setCanopyPortalWindowAccessor(accessors.getMainWindow);
  setCanopyPortalChatDispatcher(dispatcher);
  setPortalAppAdvisorSurfaces({
    getMainWindow: accessors.getMainWindow,
    getAppAdvisorWindow: accessors.getAppAdvisorWindow,
    openAppAdvisorWindow: accessors.openAppAdvisorWindow,
    ensureAppAdvisorWindow: accessors.ensureAppAdvisorWindow,
  });

  onCanopyPortalStateChanged((state) => {
    sendToWindow(
      accessors.getMainWindow(),
      IPC_CHANNELS.canopyPortalStateChanged,
      state,
    );
  });

  registerIpcHandler(
    IPC_CHANNELS.canopyPortalGetState,
    (): CanopyPortalState => getCanopyPortalState(),
  );

  registerIpcHandler(
    IPC_CHANNELS.canopyPortalStart,
    async (): Promise<StartCanopyPortalResponse> => startCanopyPortal(),
  );

  registerIpcHandler(
    IPC_CHANNELS.canopyPortalStop,
    async (): Promise<StopCanopyPortalResponse> => stopCanopyPortal(),
  );

  registerIpcHandler(
    IPC_CHANNELS.canopyPortalRegeneratePairingCode,
    (): RegenerateCanopyPortalPairingCodeResponse =>
      regenerateCanopyPortalPairingCode(),
  );

  registerIpcHandler(
    IPC_CHANNELS.canopyPortalCancelPairingCode,
    (): CancelCanopyPortalPairingCodeResponse =>
      cancelCanopyPortalPairingCode(),
  );
}
