import {
  normalizePersonalOrganizationId,
  type WorkspaceContext,
  type WorkspaceContextOrganization,
} from '@canopy/protocol/workspace-context';
import { resolveCreditsBillingTarget } from '@canopy/protocol/billing';
import { settingsRouteToPath } from '@canopy/protocol/settings/route-paths';
import {
  invitableOrganization,
  organizationCreatePath,
  organizationSettingsPath,
} from './AccountMenuActivityItem';

/**
 * Whether a host shows the top context switcher (CAN-4053, CAN-4057): the
 * org-projects flag is on and the account is signed in and not a guest. An
 * account with no organizations still gets it, on Personal with Personal's
 * actions, so every signed-in user can find the Feed, Statistics, Create a
 * team and Create an organization. Hosts decide this before mounting, so a
 * hidden switcher leaves no wrapper.
 */
export function sidebarContextSwitcherAvailable({
  orgProjectsEnabled,
  authenticated,
}: {
  readonly orgProjectsEnabled: boolean;
  /** Signed in with a known account; a guest's device token is not. */
  readonly authenticated: boolean;
}): boolean {
  return orgProjectsEnabled && authenticated;
}

/**
 * The organization actions the context switcher offers for the selected
 * context (CAN-4057). Each field is `null` when that row is hidden.
 */
export interface SidebarContextActions {
  /** Feed: the selected context's activity feed. */
  readonly feedPath: string | null;
  /** Statistics: the selected context's usage statistics. */
  readonly statisticsPath: string | null;
  /**
   * Invite your team: Personal promotes itself into a team (`create-team`);
   * an organization the viewer owns or administers takes invitations.
   */
  readonly invite:
    | { readonly kind: 'create-team'; readonly personalOrganizationId: string }
    | {
        readonly kind: 'invite';
        readonly organization: WorkspaceContextOrganization;
      }
    | null;
  /**
   * The selected organization whose AI Credits pool the row opens: only an
   * OWNER can fund it, and only under free app access.
   */
  readonly creditsOrganizationId: string | null;
  /**
   * Organization settings: the selected organization's settings page. Never
   * for Personal, whose settings page is a team-only destination.
   */
  readonly settingsPath: string | null;
  /**
   * Create an organization: every authenticated context, no role gate
   * (CAN-4554). Opens the organization index with its create dialog.
   */
  readonly createOrganizationPath: string | null;
}

const NO_ACTIONS: SidebarContextActions = {
  feedPath: null,
  statisticsPath: null,
  invite: null,
  creditsOrganizationId: null,
  settingsPath: null,
  createOrganizationPath: null,
};

/**
 * The switcher's role policy in one place, so both hosts gate the same rows
 * the same way and no host grants a row by merely passing a callback. Row
 * visibility is never an edit grant: each destination authorizes itself.
 *
 * Personal uses the personal organization only while it is selected
 * explicitly; an organization that is not (or no longer) a membership hides
 * every action while the context provider reconciles it, instead of quietly
 * targeting Personal or another organization. Create an organization is
 * the exception: it targets no existing organization, so every signed-in
 * context offers it, including those two.
 */
export function resolveSidebarContextActions({
  context,
  organizations,
  personalOrganizationId,
  freeAccess,
  authenticated = true,
}: {
  readonly context: WorkspaceContext;
  readonly organizations: readonly WorkspaceContextOrganization[];
  readonly personalOrganizationId: string | null;
  readonly freeAccess: boolean;
  /** A host with independently loaded account state must fence stale memberships. */
  readonly authenticated?: boolean;
}): SidebarContextActions {
  if (!authenticated) return NO_ACTIONS;
  const createOrganizationPath = organizationCreatePath();
  if (context.kind === 'personal') {
    const id = normalizePersonalOrganizationId(personalOrganizationId);
    if (id === null) return { ...NO_ACTIONS, createOrganizationPath };
    // The person owns their personal organization, so both pages load.
    return {
      feedPath: organizationPagePath(id, 'feed'),
      statisticsPath: organizationPagePath(id, 'statistics'),
      invite: { kind: 'create-team', personalOrganizationId: id },
      creditsOrganizationId: null,
      // A Personal organization's settings page answers 404 by design (it is
      // a team-only destination), so Personal links to none.
      settingsPath: null,
      createOrganizationPath,
    };
  }
  const organization = organizations.find(
    (entry) => entry.id === context.organizationId,
  );
  if (!organization) return { ...NO_ACTIONS, createOrganizationPath };
  const invitable = invitableOrganization(context, organizations);
  const creditsTarget = freeAccess
    ? resolveCreditsBillingTarget(context, organizations)
    : null;
  // Statistics follows the server's default `usageStatsMinRole` (ADMIN), so a
  // member never gets a row that cannot load. An organization may change that
  // minimum; this row deliberately keeps the default. Lowered to MEMBER, the
  // Feed page's own rail still offers Statistics to members. Raised to OWNER,
  // an admin's row lands on a page their role cannot view (desktop Settings
  // redirects the hidden tab to Feed).
  const managesStatistics =
    organization.role === 'OWNER' || organization.role === 'ADMIN';
  return {
    feedPath: organizationPagePath(organization.id, 'feed'),
    statisticsPath: managesStatistics
      ? organizationPagePath(organization.id, 'statistics')
      : null,
    invite: invitable ? { kind: 'invite', organization: invitable } : null,
    creditsOrganizationId:
      creditsTarget?.kind === 'organization'
        ? creditsTarget.organizationId
        : null,
    settingsPath: organizationSettingsPath(organization.id),
    createOrganizationPath,
  };
}

function organizationPagePath(
  organizationId: string,
  page: 'feed' | 'statistics',
): string {
  return settingsRouteToPath({ scope: 'organization', organizationId, page });
}
