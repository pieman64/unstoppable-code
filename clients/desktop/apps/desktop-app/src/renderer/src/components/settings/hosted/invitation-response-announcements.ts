import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type {
  SettingsWriteMap,
  SettingsWriteName,
} from '@canopy/protocol/settings';
import { announceCanopyCloudAccountChanged } from '@/lib/canopyCloudAccountChange';

/**
 * The Settings overlay's client. Answering an invitation in Settings changes
 * the pending invitations the sidebar switcher lists, and the switcher
 * re-reads only on a completed account notification, not on membership
 * broadcasts (CAN-3672). Web's switcher follows its layout's refresh instead.
 *
 * A write resolves only after main confirmed the account is still the one
 * that sent it (an accept also after main attempted an account refresh,
 * whose failure it tolerates), so a successful response announces a
 * same-account refresh, as the switcher's own accept does. A failed response
 * announces nothing: an `uncertain` one may mean the account changed.
 *
 * Other membership writes (create, leave, delete) don't change the pending
 * invitations, and their memberships reach the switcher through main's
 * workspace-context broadcast, so they pass through unannounced.
 */
export function withInvitationResponseAnnouncements(
  client: AccountOrganizationSettingsClient,
): AccountOrganizationSettingsClient {
  return {
    read: (operation, input) => client.read(operation, input),
    async write<K extends SettingsWriteName>(
      operation: K,
      input: SettingsWriteMap[K]['input'],
    ): Promise<SettingsWriteMap[K]['result']> {
      const result = await client.write(operation, input);
      if (operation === 'organization.invitations.respond')
        announceCanopyCloudAccountChanged('same-account-refresh');
      return result;
    },
    subscribe: (scope, listener) => client.subscribe(scope, listener),
  };
}
