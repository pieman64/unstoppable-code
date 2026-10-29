import { ipcRenderer } from '../ipc-router';
import { BUNDLES_CHANNELS } from '@canopy/desktop-shared/constants/bundle-channels';
import type { BundlesAPI } from '@canopy/desktop-shared/types/bundles';

export type { BundlesAPI };

export function createBundlesAPI(): BundlesAPI {
  return {
    loadIndex: () => ipcRenderer.invoke(BUNDLES_CHANNELS.LOAD_INDEX),
    loadBundle: (id: string) =>
      ipcRenderer.invoke(BUNDLES_CHANNELS.LOAD_BUNDLE, id),
    saveBundle: (bundle) =>
      ipcRenderer.invoke(BUNDLES_CHANNELS.SAVE_BUNDLE, bundle),
    deleteBundle: (id: string) =>
      ipcRenderer.invoke(BUNDLES_CHANNELS.DELETE_BUNDLE, id),
  };
}
