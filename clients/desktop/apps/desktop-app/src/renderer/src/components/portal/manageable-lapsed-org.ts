import { isOrgTeamsLapsed } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import type { CanopyOrgBillingState } from '@canopy/protocol/canopy-server';
import type { WorkspaceContextOrganization } from '@canopy/protocol/workspace-context';

/** An org the user can manage billing for, by org externalId. */
interface BillingManageableOrg {
  id: string;
  name: string;
}

/**
 * Every org this user can manage billing for (OWNER/ADMIN), without picking
 * one (CAN-3465).
 *
 * The membership list from `workspaceContextStore` is the account fact and is
 * used whenever it names a managed org. `serverManageableOrg` is
 * `entitlements.billingManageableOrg`, which the server sets only when the user
 * manages exactly one org; it is the fallback while memberships are not loaded
 * or organization contexts are off. It is OPTIONAL on the wire, so a missing
 * value yields no org: a server that cannot say "you are an admin" must not
 * produce a button that assumes it.
 */
export function resolveBillingManageableOrgs(
  organizations: readonly WorkspaceContextOrganization[],
  serverManageableOrg: BillingManageableOrg | null | undefined,
): BillingManageableOrg[] {
  const managed = organizations
    .filter(
      (organization) =>
        organization.role === 'OWNER' || organization.role === 'ADMIN',
    )
    .map((organization) => ({ id: organization.id, name: organization.name }));
  if (managed.length > 0) return managed;
  return serverManageableOrg
    ? [{ id: serverManageableOrg.id, name: serverManageableOrg.name }]
    : [];
}

/**
 * The lapsed org this user can manage billing for, or null (CAN-2590).
 *
 * Decides the paywall's COPY and DEEP-LINK TARGET, not whether it renders a
 * button: an owner/admin of the named lapsed org is pointed at that org's own
 * billing page, while everyone else is told to ask an admin and keeps their own
 * upgrade route. An earlier revision used this to suppress the button entirely;
 * see `RemoteControlUpgradeCta`'s header for why that was wrong.
 *
 * `manageableOrgs` is every org the user manages, from
 * {@link resolveBillingManageableOrgs}. All of them are checked, so an owner of
 * one healthy and one lapsed org reaches the lapsed one without any tiebreak.
 * When several managed orgs have lapsed, the org is the one selected in the
 * navigation context (`selectedOrganizationId`), and null when the selection
 * names none of them: nothing says which org the reader means, so none is
 * guessed (CAN-3465) and the reader takes the everyone-else branch.
 *
 * The lapsed side is {@link isOrgTeamsLapsed}, which fails open: an org with no
 * billing-state entry is not lapsed. A user who administers one lapsed org
 * while merely belonging to another still takes the owner/admin branch, since
 * one of the orgs the copy names is theirs to fix.
 *
 * Lives beside the modal rather than inside it so the match is unit-testable
 * without standing up the whole pairing surface and its preload bridges.
 */
export function resolveManageableLapsedOrg(
  states: readonly CanopyOrgBillingState[] | undefined,
  manageableOrgs: readonly BillingManageableOrg[],
  selectedOrganizationId: string | null,
): BillingManageableOrg | null {
  const lapsed = manageableOrgs.filter((org) =>
    isOrgTeamsLapsed(states, org.id),
  );
  // A sole lapsed org is the answer, not a pick: there is nothing else it
  // could be.
  const [sole] = lapsed;
  if (lapsed.length === 1 && sole) return sole;
  if (selectedOrganizationId === null) return null;
  const selectedId = selectedOrganizationId.toLowerCase();
  return lapsed.find((org) => org.id.toLowerCase() === selectedId) ?? null;
}
