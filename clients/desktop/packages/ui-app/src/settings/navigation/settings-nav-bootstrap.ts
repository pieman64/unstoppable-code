import type {
  SettingsBootstrap,
  SettingsNavModel,
} from '@canopy/protocol/settings';

/**
 * The settings rail model for a bootstrap. The organization group appears
 * only when the bootstrap was requested for an organization the viewer is
 * browsing (explicit navigation or selection), never from membership order.
 * Hosts without a server-rendered rail (desktop) build the rail from this.
 */
export function settingsNavModelFromBootstrap(
  bootstrap: SettingsBootstrap,
  browsedOrganizationId: string | null,
): SettingsNavModel {
  const organization =
    browsedOrganizationId !== null &&
    bootstrap.organization !== null &&
    bootstrap.organization.id === browsedOrganizationId
      ? bootstrap.organization
      : null;
  return {
    account: {
      billingEnabled: bootstrap.account.billingEnabled,
      digestsEnabled: bootstrap.account.digestsEnabled,
      integrationsEnabled: bootstrap.account.integrationsEnabled,
      freeAccess: bootstrap.account.freeAccess,
    },
    // Global Admin is a web-only surface; organization roles never imply it.
    adminVisible: false,
    organization:
      organization === null
        ? null
        : {
            id: organization.id,
            name: organization.name,
            visibleTabs: organization.visibleTabs,
            disabledTabs: organization.disabledTabs,
            billingNeedsAttention: organization.billingNeedsAttention,
          },
  };
}
