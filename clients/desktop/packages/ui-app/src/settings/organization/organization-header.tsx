'use client';

import { useMemo, type JSX, type ReactNode } from 'react';
import { Pencil } from '@canopy/ui-shared/icons/AppIcons';
import {
  InlineTextSkeleton,
  SettingsControlSelect,
} from '@canopy/ui-shared/components';
import { PageHeader } from '@canopy/ui-shared/components/PageHeader';
import {
  selectSettingsBootstrap,
  useOptionalSettingsStore,
} from '@canopy/app-state/settings';
import {
  organizationPageDataKindForRoute,
  type OrganizationDetail,
  type OrganizationRole,
  type OrganizationSettingsRoute,
  type OrganizationSummary,
  type SettingsOrganizationMembership,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import { canEditOrg } from '@canopy/protocol/settings/organization-permissions';
import { OrganizationInviteButton } from '../../sharing/OrganizationInviteButton';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';
import { SettingsPageNotice } from '../layout/settings-page-notice';
import { settingsPageSkeleton } from '../pages/loading-skeletons';
import {
  teamNavItem,
  type TeamTab,
} from '../navigation/organization-nav-items';
import { SettingsLink } from '../host';
import { OrganizationLogo } from './OrganizationLogo';
import { OrganizationLogoEditor } from './OrganizationLogoEditor';
import { TeamRoleBadge } from './team-role-badge';

/**
 * The organization header every organization tab draws above its page
 * header: the switcher, then the organization's identity (or the Personal
 * header). `TeamPage` renders it live; {@link OrganizationSettingsPlaceholder}
 * renders the same markup read-only while a tab loads, so the header keeps
 * its place when the viewer moves between tabs.
 */

/** What the header shows for an organization, from the best source known. */
export interface OrganizationHeaderModel {
  readonly id: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly viewerRole: OrganizationRole;
  readonly isPersonal: boolean;
  /** `null` until the organization's detail is known. */
  readonly memberCount: number | null;
  /** `null` until the organization's detail is known. */
  readonly teamCount: number | null;
}

/**
 * The header for an organization: from its detail when known (a tab loaded
 * it, or a change updated it), otherwise from the bootstrap membership (no
 * counts), otherwise `null`, which renders placeholders.
 */
export function organizationHeaderModel(
  organizationId: string,
  detail: OrganizationDetail | null,
  memberships: readonly SettingsOrganizationMembership[],
): OrganizationHeaderModel | null {
  if (detail !== null && detail.id === organizationId)
    return {
      id: detail.id,
      name: detail.name,
      logoUrl: detail.logoUrl,
      viewerRole: detail.viewerRole,
      isPersonal: detail.isPersonal === true,
      memberCount: detail.members.length,
      teamCount: detail.subTeams.length,
    };
  const membership = memberships.find(
    (candidate) => candidate.id === organizationId,
  );
  if (membership === undefined) return null;
  return {
    id: membership.id,
    name: membership.name,
    logoUrl: membership.logoUrl ?? null,
    viewerRole: membership.role,
    isPersonal: membership.isPersonal,
    memberCount: null,
    teamCount: null,
  };
}

/**
 * The organization tab a route draws under the organization header, or
 * `null` for routes without it: account pages, the Organizations list, and
 * drill-downs with their own back-link header (a member's profile or digest,
 * a digest, an invoice).
 */
export function organizationTabForRoute(route: SettingsRoute): TeamTab | null {
  if (route.scope !== 'organization') return null;
  switch (route.page) {
    case 'members':
      return route.userId === undefined ? 'members' : null;
    case 'digests':
      return route.digestId === undefined ? 'digests' : null;
    case 'settings':
      return route.invoiceId === undefined ? 'settings' : null;
    case 'feed':
    case 'statistics':
    case 'groups':
    case 'projects':
    case 'memory':
      return route.page;
  }
}

const NO_MEMBERSHIPS: readonly SettingsOrganizationMembership[] = [];

function useOrganizationMemberships(
  organizationId: string,
): readonly SettingsOrganizationMembership[] {
  const own = useOptionalSettingsStore(
    (state) => selectSettingsBootstrap(state, organizationId).data,
  );
  const account = useOptionalSettingsStore(
    (state) => selectSettingsBootstrap(state, null).data,
  );
  return (own ?? account)?.organizations ?? NO_MEMBERSHIPS;
}

/**
 * The header model from the settings store's caches: the last detail any tab
 * loaded, else the bootstrap membership. Without a store (web), `null`.
 */
export function useOrganizationHeaderModel(
  organizationId: string,
): OrganizationHeaderModel | null {
  const detail = useOptionalSettingsStore(
    (state) => state.organizationDetails[organizationId],
  );
  const memberships = useOrganizationMemberships(organizationId);
  return useMemo(
    () => organizationHeaderModel(organizationId, detail ?? null, memberships),
    [organizationId, detail, memberships],
  );
}

/**
 * Header for the viewer's personal organization. It names the space rather than
 * an organization, so there is no logo, role, rename, or member count.
 */
export function PersonalOverviewHeader({
  onInvite,
}: {
  readonly onInvite: () => void;
}): JSX.Element {
  return (
    <header data-testid="team-personal-header">
      <h1 className="truncate text-2xl font-semibold fg-primary">Personal</h1>
      <p className="mt-1.5 text-s fg-secondary">
        Your activity and usage across your personal work.
      </p>
      <div className="mt-3">
        <OrganizationInviteButton
          testId="team-personal-invite"
          onClick={onInvite}
        />
      </div>
    </header>
  );
}

export interface OrgSwitcherProps {
  readonly organizations: readonly Pick<OrganizationSummary, 'id' | 'name'>[];
  readonly currentOrgId: string;
  /** A switch is resolving the destination's tabs. */
  readonly switching: boolean;
  readonly onSelect: (orgId: string) => void;
}

export function OrgSwitcher({
  organizations,
  currentOrgId,
  switching,
  onSelect,
}: OrgSwitcherProps): JSX.Element {
  const current = organizations.find((org) => org.id === currentOrgId);
  return (
    // Fixed height: a 20px label line, a 4px gap and a 36px field row, so the
    // organization block below never moves while the switcher settles.
    <label className="flex h-15 shrink-0 flex-col gap-1 text-s fg-secondary">
      <span className="h-5 font-medium leading-5 fg-primary">Organization</span>
      <div className="relative inline-flex h-9 max-w-xs items-center">
        <SettingsControlSelect
          value={currentOrgId}
          disabled={switching}
          onChange={(e) => {
            if (e.target.value !== currentOrgId) {
              onSelect(e.target.value);
            }
          }}
          data-testid="team-org-switcher"
          fill
        >
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </SettingsControlSelect>
        <span className="sr-only">
          {current?.name ?? 'Select an organization'}
        </span>
      </div>
    </label>
  );
}

/** The rename control beside the organization name, for editors. */
export function OrganizationRenameButton({
  onClick,
}: {
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Edit organization name"
      data-testid="team-name-edit"
      className="rounded-md p-1.5 fg-secondary transition-colors hover:bg-secondary hover:fg-primary"
    >
      <Pencil size={15} />
    </button>
  );
}

const COUNT_LINK_CLASS =
  'rounded-sm transition-colors hover:fg-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-focus';

export interface OrganizationIdentityProps {
  readonly organizationId: string;
  /** `null` while unknown: a placeholder bar holds the name's line. */
  readonly name: string | null;
  readonly viewerRole: OrganizationRole | null;
  readonly memberCount: number | null;
  readonly teamCount: number | null;
  /** The 64px logo, or the logo editor for editors. */
  readonly logo: ReactNode;
  /** Shown in place of the name line, for the inline rename form. */
  readonly nameEditor?: ReactNode;
  /** After the name, for the rename control. */
  readonly nameAction?: ReactNode;
}

/**
 * The organization's identity: logo, name, the viewer's role, and member and
 * team counts that link to their tabs. Presentational; the organization tabs
 * and the loading placeholder both draw it, so it sits in the same place.
 */
export function OrganizationIdentity({
  organizationId,
  name,
  viewerRole,
  memberCount,
  teamCount,
  logo,
  nameEditor,
  nameAction,
}: OrganizationIdentityProps): JSX.Element {
  return (
    <header data-testid="team-overview-section">
      <div className="flex items-start gap-4">
        {logo}

        <div className="min-w-0 flex-1">
          {nameEditor ?? (
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold fg-primary">
                {name ?? <InlineTextSkeleton className="w-48" />}
              </h1>
              {nameAction}
            </div>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-s fg-secondary">
            <span className="inline-flex items-center gap-1.5">
              Your role
              {viewerRole === null ? (
                <InlineTextSkeleton className="w-14" />
              ) : (
                <TeamRoleBadge role={viewerRole} />
              )}
            </span>
            <span aria-hidden="true">·</span>
            {memberCount === null ? (
              <InlineTextSkeleton className="w-20" />
            ) : (
              <SettingsLink
                href={`/organization/${organizationId}/members`}
                data-testid="team-overview-member-count"
                className={COUNT_LINK_CLASS}
              >
                {memberCount} {memberCount === 1 ? 'member' : 'members'}
              </SettingsLink>
            )}
            <span aria-hidden="true">·</span>
            {teamCount === null ? (
              <InlineTextSkeleton className="w-16" />
            ) : (
              <SettingsLink
                href={`/organization/${organizationId}/teams`}
                data-testid="team-overview-group-count"
                className={COUNT_LINK_CLASS}
              >
                {teamCount} {teamCount === 1 ? 'team' : 'teams'}
              </SettingsLink>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

/** Size of the organization logo in the header. */
export const ORGANIZATION_HEADER_LOGO_SIZE = 64;

const noop = (): void => undefined;

/**
 * The read-only header a loading tab draws: the same switcher and identity
 * markup as the live page, with the editor controls the viewer's role gets,
 * so nothing moves or changes shape when the page replaces it.
 */
function OrganizationHeaderPreview({
  organizationId,
}: {
  readonly organizationId: string;
}): JSX.Element {
  const model = useOrganizationHeaderModel(organizationId);
  const memberships = useOrganizationMemberships(organizationId);
  if (model?.isPersonal === true)
    return <PersonalOverviewHeader onInvite={noop} />;
  const editable = model !== null && canEditOrg(model.viewerRole);
  const logo =
    model === null ? (
      <span
        aria-hidden="true"
        className="size-16 shrink-0 rounded-lg bg-muted"
      />
    ) : editable ? (
      <OrganizationLogoEditor
        name={model.name}
        logoUrl={model.logoUrl}
        size={ORGANIZATION_HEADER_LOGO_SIZE}
        busy={false}
        error={null}
        onPick={noop}
      />
    ) : (
      <OrganizationLogo
        name={model.name}
        logoUrl={model.logoUrl}
        size={ORGANIZATION_HEADER_LOGO_SIZE}
      />
    );
  return (
    <>
      {memberships.length > 1 && (
        <OrgSwitcher
          organizations={memberships}
          currentOrgId={organizationId}
          switching={false}
          onSelect={noop}
        />
      )}
      <OrganizationIdentity
        organizationId={organizationId}
        name={model?.name ?? null}
        viewerRole={model?.viewerRole ?? null}
        memberCount={model?.memberCount ?? null}
        teamCount={model?.teamCount ?? null}
        logo={logo}
        nameAction={
          editable ? <OrganizationRenameButton onClick={noop} /> : undefined
        }
      />
    </>
  );
}

export interface OrganizationSettingsPlaceholderProps {
  readonly route: OrganizationSettingsRoute;
  /**
   * The body under the page header: an error state, or by default the tab's
   * loading skeleton, shown once loading takes noticeably long.
   */
  readonly body?: ReactNode;
  /** Delay before the default skeleton shows; `0` shows it at once. */
  readonly skeletonDelayMs?: number;
}

/**
 * An organization tab that is not ready yet: the organization header and the
 * tab's page header exactly where the loaded page draws them, with only the
 * body standing in. The header is inert, so nothing in it acts on a page that
 * has not loaded.
 */
export function OrganizationSettingsPlaceholder({
  route,
  body,
  skeletonDelayMs,
}: OrganizationSettingsPlaceholderProps): JSX.Element {
  const item = teamNavItem(organizationTabForRoute(route) ?? route.page);
  return (
    // `contents` keeps the column a direct child of the host's frame.
    <div className="contents" data-testid="organization-settings-loading">
      <SettingsPageColumn className="relative">
        <div className="contents" inert>
          <OrganizationHeaderPreview organizationId={route.organizationId} />
        </div>
        <PageHeader
          headingLevel="h2"
          reserveActions
          title={item.label}
          description={item.description}
        />
        <SettingsPageNotice />
        {body ??
          settingsPageSkeleton(
            organizationPageDataKindForRoute(route),
            undefined,
            skeletonDelayMs,
          )}
      </SettingsPageColumn>
    </div>
  );
}
