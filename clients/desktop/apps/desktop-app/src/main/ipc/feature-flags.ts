import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { getFeatureFlagService } from '../feature-flags';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';

export function registerFeatureFlagHandlers(
  getMainWindow: () => BrowserWindow | null,
): void {
  void getMainWindow;

  getFeatureFlagService().onSnapshotChanged((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.featureFlagsSnapshotChanged,
          snapshot,
        );
      }
    }
  });

  registerIpcHandler(IPC_CHANNELS.featureFlagsGetSnapshot, () =>
    getFeatureFlagService().getSnapshot(),
  );

  registerIpcHandler(IPC_CHANNELS.featureFlagsRefreshContext, () =>
    getFeatureFlagService().refreshContext(),
  );
}
