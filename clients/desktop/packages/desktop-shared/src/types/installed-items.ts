import type {
  InstalledItemSnapshot,
  InstalledItemMutationResult,
  SetInstalledItemStatusRequest,
  UninstallInstalledItemRequest,
} from '@canopy/protocol/installed-items';

export const INSTALLED_ITEM_CHANNELS = {
  LIST_STATUS: 'installed-items:list-status',
  SET_STATUS: 'installed-items:set-status',
  UNINSTALL: 'installed-items:uninstall',
  CHANGED: 'installed-items:changed',
} as const;

export interface InstalledItemsAPI {
  listStatus(): Promise<InstalledItemSnapshot>;
  setStatus(
    request: SetInstalledItemStatusRequest,
  ): Promise<InstalledItemMutationResult>;
  uninstall(
    request: UninstallInstalledItemRequest,
  ): Promise<InstalledItemMutationResult>;
  onChanged(callback: () => void): () => void;
}
