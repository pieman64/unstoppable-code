import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, type WakeLockState } from '@canopy/desktop-shared/types';
import { sendToWindow } from '../lib/window-send';
import { getWakeLockService } from '../power/wake-lock-service';
import { registerIpcHandler } from './register';

export function registerWakeLockHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  const service = getWakeLockService();
  service.setBroadcastHandlers({
    stateChanged: (state: WakeLockState): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.wakeLockStateChanged, state);
    },
  });

  registerIpcHandler<[], WakeLockState>(IPC_CHANNELS.wakeLockGetState, () =>
    service.getState(),
  );
}
