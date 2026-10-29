import { ipcRenderer } from '../ipc-router';
import {
  INSTALLED_ITEM_CHANNELS,
  type InstalledItemsAPI,
} from '@canopy/desktop-shared/types/installed-items';
declare global {
  interface Window {
    installedItems: InstalledItemsAPI;
  }
}

export function createInstalledItemsAPI(): InstalledItemsAPI {
  return {
    listStatus: () => ipcRenderer.invoke(INSTALLED_ITEM_CHANNELS.LIST_STATUS),
    setStatus: (request) =>
      ipcRenderer.invoke(INSTALLED_ITEM_CHANNELS.SET_STATUS, request),
    uninstall: (request) =>
      ipcRenderer.invoke(INSTALLED_ITEM_CHANNELS.UNINSTALL, request),
    onChanged(callback) {
      const listener = (): void => callback();
      ipcRenderer.on(INSTALLED_ITEM_CHANNELS.CHANGED, listener);
      return () =>
        ipcRenderer.removeListener(INSTALLED_ITEM_CHANNELS.CHANGED, listener);
    },
  };
}
