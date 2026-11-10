import { ipcRenderer } from '../ipc-router';
import { INVOCABLE_INVENTORY_CHANNELS } from '@canopy/desktop-shared/constants/invocable-inventory-channels';
import type {
  InvocableInventoryAPI,
  ListInvocableInventoryRequest,
  ResolveInvocableSelectionRequest,
} from '@canopy/execution-engine/types/invocable-inventory';

export type { InvocableInventoryAPI };

export function createInvocableInventoryAPI(): InvocableInventoryAPI {
  return {
    list: (request: ListInvocableInventoryRequest) =>
      ipcRenderer.invoke(INVOCABLE_INVENTORY_CHANNELS.LOAD, request),
    refresh: () => ipcRenderer.invoke(INVOCABLE_INVENTORY_CHANNELS.REFRESH),
    resolveSelection: (request: ResolveInvocableSelectionRequest) =>
      ipcRenderer.invoke(INVOCABLE_INVENTORY_CHANNELS.RESOLVE, request),
    onChanged: (callback: () => void): (() => void) => {
      const listener = (): void => {
        callback();
      };
      ipcRenderer.on(INVOCABLE_INVENTORY_CHANNELS.CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(
          INVOCABLE_INVENTORY_CHANNELS.CHANGED,
          listener,
        );
      };
    },
  };
}
