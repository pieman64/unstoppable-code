import { INVOCABLE_INVENTORY_CHANNELS } from '@canopy/desktop-shared/constants/invocable-inventory-channels';
import type {
  ListInvocableInventoryRequest,
  ResolveInvocableSelectionRequest,
} from '@canopy/desktop-shared/types';
import {
  listInvocableInventory,
  refreshInvocableInventory,
  resolveInvocableSelection,
} from '../plugins/invocable-inventory-service';
import { registerIpcHandler } from './register';

export function registerInvocableInventoryHandlers(): void {
  registerIpcHandler(
    INVOCABLE_INVENTORY_CHANNELS.LOAD,
    (_event, request: ListInvocableInventoryRequest) =>
      listInvocableInventory(request),
  );
  registerIpcHandler(INVOCABLE_INVENTORY_CHANNELS.REFRESH, () =>
    refreshInvocableInventory('ipc-refresh'),
  );
  registerIpcHandler(
    INVOCABLE_INVENTORY_CHANNELS.RESOLVE,
    (_event, request: ResolveInvocableSelectionRequest) =>
      resolveInvocableSelection(request),
  );
}
