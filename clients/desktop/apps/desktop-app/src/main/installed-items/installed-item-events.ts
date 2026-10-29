import { bumpGlobalPluginDefaultsRevision } from '../plugins/plugin-defaults-revision';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { broadcastPreferencesChanged } from '../lib/preferences-broadcast';
import { sendToAllWindows } from '../lib/window-send';

export const INSTALLED_ITEMS_CHANGED_CHANNEL = 'installed-items:changed';
export function notifyInstalledItemsChanged(): void {
  bumpGlobalPluginDefaultsRevision();
  refreshInvocableInventoryAfterMutation('installed-items');
  broadcastPreferencesChanged();
  notifyPortalStructureChanged();
  sendToAllWindows(INSTALLED_ITEMS_CHANGED_CHANNEL);
}
