/** Browser-safe definitions for serializable settings navigation props. */
export interface AccountSettingsNavFlags {
  billingEnabled: boolean;
  digestsEnabled: boolean;
  integrationsEnabled: boolean;
  /**
   * The External agents (MCP) page is on for this user. Web only: it is a
   * hosted page, not a shared settings route, so absent hides its item.
   */
  externalAgentsEnabled?: boolean;
  /**
   * Account Labs lists at least one experiment for this user. Web only:
   * desktop keeps Labs in its own Settings, so absent hides the item.
   */
  labsEnabled?: boolean;
  /**
   * Free app access is on (CAN-3926). The Billing item keeps its route and
   * key but is named "AI Credits", for what it still sells. Optional so a
   * caller that never shows Billing need not resolve it.
   */
  freeAccess?: boolean;
}

export const ORGANIZATION_SETTINGS_NAV_TABS = [
  'feed',
  'statistics',
  'digests',
  'members',
  'groups',
  'projects',
  'memory',
  'settings',
] as const;

export type OrganizationSettingsNavTab =
  (typeof ORGANIZATION_SETTINGS_NAV_TABS)[number];

/**
 * Tabs that stay LIVE while the org is lapsed, because they host actions the
 * server deliberately leaves EXEMPT from the capability gate (CAN-2311).
 *
 * Blanking these was a real gap: the exemptions exist so a lapsed org can
 * shrink to a payable seat count before subscribing, demote a compromised
 * admin, fix a mistyped org name the billing screens print back at it, revoke a
 * third party's standing GitHub access, and leave or delete the org at all.
 * Billing lives inside Settings, so a lapsed owner still reaches the one
 * surface that undoes the lapse. `groups` stays live because sub-team
 * membership removal is exempt server-side; existing project definitions and
 * wind-down actions stay available too. Gated sub-sections inside these tabs
 * are suppressed at their own render sites; the server remains the enforcement
 * boundary either way.
 *
 * The single source for the team page's lapsed panel and the settings rail.
 */
export const LAPSED_LIVE_TABS: ReadonlySet<OrganizationSettingsNavTab> =
  new Set<OrganizationSettingsNavTab>([
    'members',
    'settings',
    'groups',
    'projects',
  ]);

export interface OrganizationSettingsNavModel {
  id: string;
  name: string;
  visibleTabs: OrganizationSettingsNavTab[];
  disabledTabs: OrganizationSettingsNavTab[];
  billingNeedsAttention: boolean;
}

export interface SettingsNavModel {
  account: AccountSettingsNavFlags;
  adminVisible: boolean;
  organization: OrganizationSettingsNavModel | null;
}
