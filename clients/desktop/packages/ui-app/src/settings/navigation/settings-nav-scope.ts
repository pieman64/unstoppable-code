import type {
  AccountSettingsNavFlags,
  SettingsNavModel,
  SettingsNavOrganizationScope,
  SettingsOrganizationRole,
} from '@canopy/protocol/settings';
import { canEditOrg } from '@canopy/protocol/settings/organization-permissions';
import { organizationSettingsSubtabHref } from './organization-nav-items';
import { parseSettingsPathname } from './settings-path';

/** What the settings rail is showing: the account, or one organization. */
export type SettingsNavScope =
  | { readonly kind: 'account' }
  | {
      readonly kind: 'organization';
      readonly organizationId: string;
      readonly name: string;
      readonly logoUrl: string | null;
      /** `null` until the host knows the viewer's role. */
      readonly role: SettingsOrganizationRole | null;
      readonly isPersonal: boolean;
    };

/** The rail's current scope: the browsed organization, else the account. */
export function currentSettingsNavScope(
  model: SettingsNavModel,
): SettingsNavScope {
  const organization = model.organization;
  if (organization === null) return { kind: 'account' };
  const membership = model.organizations?.find(
    (candidate) => candidate.id === organization.id,
  );
  return {
    kind: 'organization',
    organizationId: organization.id,
    name: organization.name,
    logoUrl: organization.logoUrl ?? membership?.logoUrl ?? null,
    role: organization.viewerRole ?? membership?.role ?? null,
    isPersonal: organization.isPersonal ?? membership?.isPersonal ?? false,
  };
}

/**
 * The organizations the scope picker offers: every membership except the
 * Personal organization, which the account scope stands for. The browsed
 * organization is listed even before the membership list arrives.
 */
export function settingsNavScopeOrganizations(
  model: SettingsNavModel,
): readonly SettingsNavOrganizationScope[] {
  const listed = (model.organizations ?? []).filter(
    (organization) => !organization.isPersonal,
  );
  const scope = currentSettingsNavScope(model);
  if (
    scope.kind === 'organization' &&
    !scope.isPersonal &&
    scope.role !== null &&
    !listed.some((organization) => organization.id === scope.organizationId)
  ) {
    return [
      ...listed,
      {
        id: scope.organizationId,
        name: scope.name,
        logoUrl: scope.logoUrl,
        role: scope.role,
        isPersonal: false,
      },
    ];
  }
  return listed;
}

/**
 * Where choosing the account in the scope picker lands. Pages both scopes
 * have keep their place (Billing stays on Billing, Integrations on
 * Integrations) when the account shows them; anything else opens Account.
 */
export function accountScopeHref(
  currentPath: string,
  account: AccountSettingsNavFlags,
): string {
  const route = parseSettingsPathname(currentPath);
  if (route?.scope === 'organization' && route.page === 'settings') {
    if (route.subtab === 'billing' && account.billingEnabled)
      return '/account/billing';
    if (route.subtab === 'integrations' && account.integrationsEnabled)
      return '/account/integrations';
  }
  return '/account';
}

/**
 * Where choosing an organization in the scope picker lands. Pages both scopes
 * have keep their place (Billing, Integrations), and moving between
 * organizations keeps Members, Teams, or the same Settings page. Anything
 * else opens the organization's first page: General for those who manage it,
 * Members for everyone else. A Settings page the viewer does not get falls
 * back to their first one on the page itself.
 */
export function organizationScopeHref(
  currentPath: string,
  organization: Pick<SettingsNavOrganizationScope, 'id' | 'role'>,
): string {
  const manages = canEditOrg(organization.role);
  const route = parseSettingsPathname(currentPath);
  if (route?.scope === 'account' && manages) {
    if (route.page === 'billing')
      return organizationSettingsSubtabHref(organization.id, 'billing');
    if (route.page === 'integrations')
      return organizationSettingsSubtabHref(organization.id, 'integrations');
  }
  if (route?.scope === 'organization') {
    if (route.page === 'members' || route.page === 'groups') {
      return route.page === 'members'
        ? `/organization/${organization.id}/members`
        : `/organization/${organization.id}/teams`;
    }
    if (route.page === 'settings' && (manages || route.subtab === 'usage'))
      return organizationSettingsSubtabHref(
        organization.id,
        route.subtab ?? 'general',
      );
  }
  return manages
    ? organizationSettingsSubtabHref(organization.id, 'general')
    : `/organization/${organization.id}/members`;
}
