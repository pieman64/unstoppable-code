'use client';

import { Suspense, useRef, useState, type JSX, type ReactNode } from 'react';
import { ExternalLink, Plus, UserPlus } from '@canopy/ui-shared/icons/AppIcons';
import { Button, buttonClassName } from '@canopy/ui-shared/components';
import { PageHeader } from '@canopy/ui-shared/components/PageHeader';
import { useOptionalSettingsStoreApi } from '@canopy/app-state/settings';
import type {
  OrganizationDetail,
  OrganizationSettingsNavModel,
  OrganizationSummary,
  OrgTeamsLapseReason,
} from '@canopy/protocol/settings';
import {
  canEditOrg,
  canManageMembers,
  canManageSubTeams,
} from '@canopy/protocol/settings/organization-permissions';
import {
  LAPSED_LIVE_TABS,
  teamNavItem,
  type TeamTab,
} from '../navigation/organization-nav-items';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';
import { SettingsPageNotice } from '../layout/settings-page-notice';
import {
  SettingsLink,
  useSettingsClient,
  useSettingsHost,
  useSettingsNavigation,
  useSettingsRouter,
  useSettingsWorkspaceContext,
} from '../host';
import { OrgSwitcher, PersonalOverviewHeader } from './organization-header';
import { TeamOverviewSection } from './team-overview-section';
import { TeamFeedSection } from './team-feed-section';
import { TeamMembersSection } from './team-members-section';
import {
  TeamProjectsHeaderActions,
  TeamProjectsSection,
  teamProjectsRepositoriesAvailable,
} from './team-projects-section';
import { TeamSubTeamsSection } from './team-subteams-section';
import { TeamSettingsSection } from './settings/team-settings-section';
import { TeamStatisticsSection } from './statistics/TeamStatisticsSection';
import { TeamLapsedState } from './team-lapsed-state';
import { useInviteSeatCharge } from './invite-seat-charge';
import { useOrganizationSettingsSlots } from './organization-settings-slots';
import { useMembershipChangeFollowUp } from './membership-change';

/**
 * The tab switching to another organization lands on: the current tab when
 * the destination's rail (after its lapse, personal-kind, flag, and role
 * filtering) offers it live, otherwise the destination's Feed. `null` (the
 * destination's rail could not be read) also lands on Feed.
 */
export function organizationSwitchTab(
  currentTab: TeamTab,
  destination: Pick<
    OrganizationSettingsNavModel,
    'visibleTabs' | 'disabledTabs'
  > | null,
): TeamTab {
  if (destination === null) return 'feed';
  return destination.visibleTabs.includes(currentTab) &&
    !destination.disabledTabs.includes(currentTab)
    ? currentTab
    : 'feed';
}

/**
 * Why an org's tabs are blocked, when they are (CAN-2311). `null` is the normal
 * case — a healthy org renders exactly as it always has.
 */
export interface TeamLapsedInfo {
  /** When the org's trial ended, if known. See `OrgEntitlements.trialEndedAt`. */
  trialEndedAt: string | null;
  /**
   * Why the org lost `teams`, so the panel names the right remedy instead of
   * asserting a trial expiry for a past-due or cancelled org. See
   * `OrgTeamsAccess.lapseReason`.
   */
  lapseReason: OrgTeamsLapseReason | null;
  /** Cheapest plan name that restores `teams`, for the CTA copy. */
  requiredPlanName: string | null;
}

export interface TeamPageProps {
  initialDetail: OrganizationDetail;
  /** All orgs the viewer belongs to, for the switcher dropdown. */
  organizations: OrganizationSummary[];
  /** Session email used to identify the viewer's own member row. */
  viewerEmail: string;
  /**
   * Whether the `canopy-billing-enabled` flag is on for this viewer. The Billing
   * settings subtab only appears when this is true and the viewer can edit the
   * org.
   */
  billingEnabled: boolean;
  /** Whether organization memory is rolled out for this org. */
  memoryEnabled: boolean;
  projectsEnabled: boolean;
  /**
   * Whether the org's billing needs an action the viewer can take. Renders an
   * attention dot on the Billing subtab inside Settings; the settings rail
   * carries its own dot so it is noticed from any page.
   */
  billingNeedsAttention: boolean;
  /**
   * Server-resolved free app access (CAN-3926). The Billing settings subtab is
   * then named "AI Credits" and drops the subscription plan.
   */
  freeAccess?: boolean;
  /** Which tab this route renders; the feed is the primary view. */
  activeTab: TeamTab;
  /**
   * Server-derived from the request user agent. Mobile browsers cannot open
   * the desktop app, so the data-sharing hints give text guidance instead.
   */
  mobileBrowser: boolean;
  /** When set (permalink route), the feed anchors on and highlights this item. */
  highlightItemId?: string;
  /**
   * Server-rendered archive content for the `digests` tab. Only the digests
   * route passes it; the archive read is authorization-sensitive and stays on
   * the server rather than being re-implemented as a client fetch here.
   */
  digestContent?: ReactNode;
  /**
   * The `memory` tab's content: the Memory views and the selected view, built
   * by `OrganizationMemoryLayout` from the Memory page's own data.
   */
  memoryContent?: ReactNode;
  /**
   * Set when the org has LOST the `teams` capability (CAN-2311). Tabs outside
   * {@link LAPSED_LIVE_TABS} render the lapsed panel instead of their content
   * and are inert in the settings rail. Settings stays live, so the Billing
   * subtab — the one surface that can undo the lapse — remains reachable.
   */
  lapsed?: TeamLapsedInfo | null;
  /**
   * Set when the viewer arrived here straight from redeeming an invite
   * (`/organization/<id>?joined=1`). Renders a one-line confirmation so the
   * join is stated outright rather than inferred from an org page the viewer
   * has never seen before.
   */
  justJoined?: boolean;
  /**
   * Members route only: open the invite dialog on arrival (`?invite=1`, from
   * the post-create redirect or the empty feed's "Invite people"), for viewers
   * who can invite.
   */
  inviteOnLoad?: boolean;
  /**
   * Settings route only: whether outside agents (the hosted MCP servers) are
   * on for this viewer. Lets an OWNER see the External agents card in
   * Settings → Policies. Other routes omit it.
   */
  externalAgentsEnabled?: boolean;
}

/**
 * Client shell for the team routes. Holds the authoritative
 * {@link OrganizationDetail} (each settings section's mutations return a fresh
 * detail) and renders the org switcher, the organization block, the page
 * header naming the current destination, the notices, and that destination's
 * content. The settings rail navigates between destinations. Feed is the
 * primary view; members and teams are first-class pages so any member can view
 * them, while management actions stay role-gated inside the Members and Teams
 * sections.
 */

export function TeamPage({
  initialDetail,
  organizations,
  viewerEmail,
  billingEnabled,
  memoryEnabled,
  projectsEnabled,
  billingNeedsAttention,
  freeAccess = false,
  activeTab,
  mobileBrowser,
  highlightItemId,
  digestContent,
  memoryContent,
  lapsed = null,
  justJoined = false,
  inviteOnLoad = false,
  externalAgentsEnabled = false,
}: TeamPageProps): JSX.Element {
  const router = useSettingsRouter();
  const client = useSettingsClient();
  const navigation = useSettingsNavigation();
  const webOrigin = useSettingsHost().webOrigin();
  // Browsing settings never changes the workspace context; explicitly
  // switching to another organization below selects it.
  const { accountKey, selectOrganization } = useSettingsWorkspaceContext();
  const { PromotionDialog } = useOrganizationSettingsSlots();
  // Desktop's settings store keeps the latest detail per organization, so a
  // tab that is still loading draws this header with current values. Web has
  // no store and nothing to keep.
  const settingsStore = useOptionalSettingsStoreApi();
  const [detail, setDetailState] = useState<OrganizationDetail>(initialDetail);
  const [personalInviteId, setPersonalInviteId] = useState<string | null>(null);
  // Promotion keeps this organization id, so router refresh preserves the
  // shell. Adopt its committed team detail while retaining the open dialog.
  if (
    detail.id === initialDetail.id &&
    detail.isPersonal === true &&
    initialDetail.isPersonal !== true
  ) {
    setDetailState(initialDetail);
  }
  // The settings rail is published by the persistent organization layout from
  // server data, so it does not see this client-held detail. When a mutation
  // changes what the rail shows (the name, or the role that gates Statistics,
  // Memory, and the billing deep link), refresh the server tree so the rail
  // catches up. Authorization stays server-side throughout.
  const setDetail = (next: OrganizationDetail): void => {
    // Any membership change may change what an invite costs; the next
    // Members visit reads billing again rather than reusing the cached check.
    inviteSeatCharge.invalidate();
    const railChanged =
      next.name !== detail.name ||
      next.viewerRole !== detail.viewerRole ||
      next.canViewUsageStats !== detail.canViewUsageStats;
    setDetailState(next);
    settingsStore?.getState().rememberOrganizationDetail(next.id, next);
    if (railChanged) router.refresh();
  };

  // A personal organization shows only its owner's Feed and Statistics: no
  // switcher, branding, member counts, or team-management tabs. Its invite
  // action promotes Personal through the shared Create a team flow.
  // The server refuses the other routes independently of this shell.
  const personal = detail.isPersonal === true;
  const canEdit = canEditOrg(detail.viewerRole);
  // Not a tab gate: billing is a Settings subtab now, and this only decides
  // whether the lapsed notice may point the viewer at the restore flow. Named
  // for what it actually answers so the next reader does not hunt for a
  // top-level Billing tab that no longer exists.
  const canRestoreViaBilling = billingEnabled && canEdit;
  const pageNavItem = teamNavItem(activeTab);

  // Carrying the info (rather than a boolean) keeps the panel's fields narrowed
  // at the render site without a second `lapsed !== null` check.
  const lapsedPanelInfo: TeamLapsedInfo | null =
    lapsed !== null && !LAPSED_LIVE_TABS.has(activeTab) ? lapsed : null;

  // A live tab on a lapsed org still needs to SAY the org is on hold — its
  // content renders normally, but most of what it offers will be refused, and
  // silently letting the user discover that through 403s would be worse than
  // the blanked panel this replaced. This is deliberately tab-level and not
  // subtab-aware: on Settings → Billing it sits above `TeamBillingSection`,
  // which states the lapse again with the payment UI attached. The repetition
  // is accepted over teaching the page shell to read `?tab=`.
  const showLapsedNotice = lapsed !== null && LAPSED_LIVE_TABS.has(activeTab);

  // Role-conditioned: the notice used to promise every viewer they could
  // "update these settings, manage members, and leave or delete the
  // organization", of which only leaving is true for a plain MEMBER (who can
  // still reach Settings). It also promised member MANAGEMENT generally, but
  // adding one is gated while lapsed -- only removal and role changes survive.
  const lapsedNoticeAbilities = canEdit
    ? 'You can still update the organization name and logo, remove members or change their roles, and leave or delete the organization'
    : 'You can still leave the organization';

  // Leaving or deleting removes the membership, so the host's organization
  // switcher re-reads after landing on the index.
  const followMembershipChange = useMembershipChangeFollowUp();
  const afterMembershipRemoved = (): void =>
    followMembershipChange('/organization');
  const refreshPage = (): void => router.refresh();
  // A billing change (a saved card, a plan change) can change whether an
  // invite charges a seat.
  const onBillingChanged = (): void => {
    inviteSeatCharge.invalidate();
    refreshPage();
  };

  // Switching organizations keeps the current tab only when the destination
  // offers it; its rail is read for the destination explicitly, never
  // inferred from this organization's.
  const switchRequest = useRef(0);
  const [switching, setSwitching] = useState(false);
  const switchOrganization = async (orgId: string): Promise<void> => {
    const request = ++switchRequest.current;
    if (activeTab === 'feed') {
      router.push(teamNavItem('feed').href(orgId));
      return;
    }
    setSwitching(true);
    let destination: OrganizationSettingsNavModel | null = null;
    try {
      const bootstrap = await client.read('settings.bootstrap', {
        organizationId: orgId,
      });
      destination =
        bootstrap.organization?.id === orgId ? bootstrap.organization : null;
    } catch {
      destination = null;
    }
    if (request !== switchRequest.current) return;
    setSwitching(false);
    router.push(
      teamNavItem(organizationSwitchTab(activeTab, destination)).href(orgId),
    );
  };

  // The Personal header's invite promotes Personal to a team. The host's
  // promotion controller owns that flow; a host without one continues on
  // this organization's web page, which offers the same invite.
  const openPersonalInvite = (): void => {
    if (PromotionDialog !== undefined) {
      setPersonalInviteId(detail.id);
      return;
    }
    navigation.openExternal(
      `${webOrigin}${teamNavItem('feed').href(detail.id)}`,
    );
  };

  // Each page's sole action sits in the page header, so its panel holds only
  // rows. The shell owns the open state; the sections render the dialog and
  // the inline form. Adding members and restructuring teams are refused while
  // lapsed, so their actions are hidden rather than left to 403.
  const canInvite = canManageMembers(detail.viewerRole) && lapsed === null;
  const canCreateTeam = canManageSubTeams(detail.viewerRole) && lapsed === null;
  const [addingMember, setAddingMember] = useState(inviteOnLoad && canInvite);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectRepositoriesOpen, setProjectRepositoriesOpen] = useState(false);
  const [projectAddAvailable, setProjectAddAvailable] = useState(false);
  const projectRepositoriesAvailable = teamProjectsRepositoriesAvailable(
    detail,
    projectsEnabled,
    lapsed !== null,
  );
  // Inviting into a paid per-seat organization can charge a prorated seat.
  // Hosts that cannot confirm that charge inline hand the invite to the web.
  const inviteSeatCharge = useInviteSeatCharge({
    organizationId: detail.id,
    enabled: canInvite && activeTab === 'members',
    billingEnabled,
    freeAccess,
  });
  const membersInviteHref = `${webOrigin}${teamNavItem('members').href(
    detail.id,
  )}?invite=1`;
  // The invite dialog opens (including from `?invite=1`) only once inviting
  // is known to run inline. An open dialog stays open if a pre-send recheck
  // finds a charge, so its error explains the handoff the header now offers.
  const [inviteDialogShown, setInviteDialogShown] = useState(false);
  const showInviteDialog =
    addingMember && (inviteSeatCharge.mode === 'inline' || inviteDialogShown);
  if (showInviteDialog !== inviteDialogShown) {
    setInviteDialogShown(showInviteDialog);
  }

  const headerActions = ((): ReactNode => {
    if (lapsedPanelInfo !== null) return undefined;
    switch (activeTab) {
      case 'members':
        if (!canInvite) return undefined;
        if (inviteSeatCharge.mode === 'handoff') {
          // Only the button sits in the header row; the reason is a line
          // below the header, so the header keeps one height.
          return (
            <Button
              size="compact"
              variant="secondary"
              onClick={() => navigation.openExternal(membersInviteHref)}
              data-testid="team-invite-on-web"
            >
              <ExternalLink size={14} />
              Invite on the web
            </Button>
          );
        }
        return (
          <Button
            size="compact"
            variant="primary"
            onClick={() => setAddingMember(true)}
            // Disabled until this host knows whether inviting can charge.
            disabled={inviteSeatCharge.mode === 'checking'}
            data-testid="team-add-member"
          >
            <UserPlus size={14} />
            Add member
          </Button>
        );
      case 'groups':
        return canCreateTeam && !creatingTeam ? (
          <Button
            size="compact"
            variant="primary"
            onClick={() => setCreatingTeam(true)}
            data-testid="team-create-subteam"
          >
            <Plus size={14} />
            New team
          </Button>
        ) : undefined;
      case 'projects':
        return projectRepositoriesAvailable || projectAddAvailable ? (
          <TeamProjectsHeaderActions
            repositoriesAvailable={projectRepositoriesAvailable}
            addAvailable={projectAddAvailable}
            onAdd={() => setCreatingProject(true)}
            onRepositories={() => setProjectRepositoriesOpen(true)}
          />
        ) : undefined;
      case 'digests':
        // Forward link to the cadence settings. The left nav is what moves
        // around the org, so this never reads as a back link.
        return canEdit ? (
          <SettingsLink
            href={`/organization/${detail.id}/settings`}
            className={buttonClassName({ variant: 'secondary' })}
            data-testid="org-digest-settings-link"
          >
            Digest settings
          </SettingsLink>
        ) : undefined;
      default:
        return undefined;
    }
  })();

  const showInviteHandoffNote =
    lapsedPanelInfo === null &&
    activeTab === 'members' &&
    canInvite &&
    inviteSeatCharge.mode === 'handoff';

  const tabContent = ((): ReactNode => {
    if (lapsedPanelInfo !== null) {
      return (
        <TeamLapsedState
          orgId={detail.id}
          orgName={detail.name}
          trialEndedAt={lapsedPanelInfo.trialEndedAt}
          lapseReason={lapsedPanelInfo.lapseReason}
          requiredPlanName={lapsedPanelInfo.requiredPlanName}
          canEdit={canEdit}
        />
      );
    }
    switch (activeTab) {
      case 'feed':
        return (
          <TeamFeedSection
            key={`${detail.id}:${highlightItemId ?? ''}`}
            orgId={detail.id}
            organizationName={detail.name}
            viewerIdentity={viewerEmail}
            mobileBrowser={mobileBrowser}
            canManageMembers={canManageMembers(detail.viewerRole)}
            members={detail.members}
            highlightItemId={highlightItemId}
            personal={personal}
          />
        );
      case 'digests':
        return digestContent ?? null;
      case 'statistics':
        return detail.canViewUsageStats ? (
          <TeamStatisticsSection
            orgId={detail.id}
            organizationName={detail.name}
            viewerIdentity={viewerEmail}
            mobileBrowser={mobileBrowser}
            subTeams={detail.subTeams}
            members={detail.members}
            personal={personal}
          />
        ) : (
          <p
            className="rounded-xl border border-dashed px-4 py-12 text-center text-s fg-secondary"
            data-testid="team-statistics-forbidden"
          >
            You don&apos;t have permission to view usage statistics for this
            organization.
          </p>
        );
      case 'members':
        return (
          <TeamMembersSection
            detail={detail}
            viewerEmail={viewerEmail}
            onDetailChange={setDetail}
            onLeft={afterMembershipRemoved}
            onBillingChanged={onBillingChanged}
            onInvited={inviteSeatCharge.invalidate}
            lapsed={lapsed !== null}
            adding={showInviteDialog}
            onAddingChange={setAddingMember}
            recheckInviteSeatCharge={inviteSeatCharge.recheck}
          />
        );
      case 'groups':
        return (
          <TeamSubTeamsSection
            detail={detail}
            onDetailChange={setDetail}
            orgLapsed={lapsed !== null}
            creating={creatingTeam}
            onCreatingChange={setCreatingTeam}
          />
        );
      case 'projects':
        return (
          <TeamProjectsSection
            detail={detail}
            onDetailChange={setDetail}
            orgLapsed={lapsed !== null}
            projectsEnabled={projectsEnabled}
            creating={creatingProject}
            onCreatingChange={setCreatingProject}
            repositoriesOpen={projectRepositoriesOpen}
            onRepositoriesOpenChange={setProjectRepositoriesOpen}
            onAddAvailableChange={setProjectAddAvailable}
          />
        );
      case 'memory':
        return memoryContent ?? null;
      case 'settings':
        // The settings cards live behind subtabs (`?tab=`), which
        // `TeamSettingsSection` reads via `useSearchParams`, so it needs a
        // Suspense boundary. This boundary also covers the Billing subtab's
        // own `?plan=` read.
        return (
          <Suspense fallback={null}>
            <TeamSettingsSection
              detail={detail}
              onDetailChange={setDetail}
              onBillingChanged={onBillingChanged}
              memoryEnabled={memoryEnabled}
              billingEnabled={billingEnabled}
              billingNeedsAttention={billingNeedsAttention}
              freeAccess={freeAccess}
              lapsed={lapsed}
              onDeleted={afterMembershipRemoved}
              externalAgentsEnabled={externalAgentsEnabled}
            />
          </Suspense>
        );
    }
    const exhaustive: never = activeTab;
    return exhaustive;
  })();

  return (
    <SettingsPageColumn className="relative">
      {!personal && organizations.length > 1 && (
        <OrgSwitcher
          organizations={organizations}
          currentOrgId={detail.id}
          switching={switching}
          onSelect={(orgId) => {
            selectOrganization(orgId);
            void switchOrganization(orgId);
          }}
        />
      )}

      {personal ? (
        <PersonalOverviewHeader onInvite={openPersonalInvite} />
      ) : (
        <TeamOverviewSection detail={detail} onDetailChange={setDetail} />
      )}

      {personalInviteId && accountKey !== null && PromotionDialog && (
        <PromotionDialog
          accountKey={accountKey}
          personalOrganizationId={personalInviteId}
          inviteRequired
          onClose={() => setPersonalInviteId(null)}
        />
      )}

      <PageHeader
        headingLevel="h2"
        reserveActions
        title={pageNavItem.label}
        description={pageNavItem.description}
        actions={headerActions}
      />

      <SettingsPageNotice />

      {showInviteHandoffNote && (
        <p
          className="text-s fg-secondary"
          data-testid="team-invite-web-handoff"
        >
          Inviting can add a paid seat. Continue in your browser.
        </p>
      )}

      {justJoined && (
        <p
          role="status"
          data-testid="team-joined-notice"
          // `ring-1` rather than `border` on purpose (CAN-2734): an unlayered
          // `* { border-color: var(--line-base) }` outranks Tailwind's layered
          // `border-*` utilities, so a border color here would silently paint
          // `--line-base`. The sibling lapsed notice below still has that bug.
          className="rounded-lg bg-success-subtle px-3 py-2 text-s fg-success ring-1 ring-line-positive/40"
        >
          {`You've joined ${detail.name}.`}
        </p>
      )}

      {showLapsedNotice && (
        <p
          role="status"
          data-testid="team-lapsed-notice"
          className="rounded-lg border border-line-attention/40 bg-warning-subtle px-3 py-2 text-s fg-warning"
        >
          {/*
            Location-INDEPENDENT wording on purpose. This notice renders on
            every tab in LAPSED_LIVE_TABS, which now includes Settings — so a
            directional "from Settings → Billing" told a lapsed owner sitting on
            Settings → Billing to navigate to where they already were. The
            repetition of the lapse message is accepted (TeamBillingSection
            restates it with the payment UI attached); a self-referential
            instruction is a separate defect, and this phrasing stays true from
            every tab including Billing itself.
          */}
          {`${detail.name} is on hold. ${lapsedNoticeAbilities}${
            canRestoreViaBilling
              ? ', or restore it from the Billing settings'
              : ''
          }. Other organization features stay paused until it is restored.`}
        </p>
      )}

      {tabContent}
    </SettingsPageColumn>
  );
}
