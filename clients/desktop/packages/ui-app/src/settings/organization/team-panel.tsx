'use client';

import { useCallback, useEffect, useState, type JSX } from 'react';
import { Check, Mail, Plus, Users, X } from '@canopy/ui-shared/icons/AppIcons';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  OrgEnforcedConsentList,
  SettingsListSkeleton,
  StatusBadge,
} from '@canopy/ui-shared/components';
import type {
  IncomingTeamInvitation,
  OrganizationSummary,
} from '@canopy/protocol/settings';
import {
  SettingsConfirmDialog,
  useSettingsClient,
  useSettingsPrivacy,
  useSettingsRouter,
  useSettingsWorkspaceContext,
} from '../host';
import { useSettingsErrorCopy } from '../errors';
import {
  listIncomingInvitations,
  listOrganizations,
  respondToInvitation,
} from './team-api';
import { TeamRoleBadge } from './team-role-badge';
import { OrganizationLogo } from './OrganizationLogo';
import { joinClassNames } from './join-class-names';
import { useMembershipChangeFollowUp } from './membership-change';

export type TeamPanelStatus = 'loading' | 'ready' | 'error';

/** What the page needs to decide whether to show its "New organization". */
export interface TeamPanelState {
  readonly status: TeamPanelStatus;
  readonly hasOrgs: boolean;
}

export interface TeamPanelProps {
  /**
   * Memberships a server already read (`organization.list` page data). With
   * {@link initialInvitations} the panel renders them at once instead of
   * reading on mount; either absent means "read through the table".
   */
  readonly initialOrganizations?: OrganizationSummary[];
  readonly initialInvitations?: IncomingTeamInvitation[];
  /**
   * Starts creating an organization from the empty state's call to action.
   * The page owns the create dialog, so the header action and the empty
   * state open the same one.
   */
  readonly onCreate: () => void;
  /**
   * Reports the load status and whether any organization is listed whenever
   * either changes. Pass a stable callback.
   */
  readonly onStateChange?: (state: TeamPanelState) => void;
}

/**
 * The Organizations list body: pending invitations, then the memberships.
 * With no organizations it is a call to action to create one; with one or
 * more it lists each org (name, your role, member + sub-team counts) and
 * links to `/organization/[orgId]` for management. The page owns the header,
 * its "New organization" action and the create dialog.
 */
export function TeamPanel({
  initialOrganizations,
  initialInvitations,
  onCreate,
  onStateChange,
}: TeamPanelProps): JSX.Element {
  const router = useSettingsRouter();
  const client = useSettingsClient();
  const { blockClassName } = useSettingsPrivacy();
  const errorCopy = useSettingsErrorCopy('settings.organizations');
  const followMembershipChange = useMembershipChangeFollowUp();
  // Opening or joining an organization selects it in the app's sidebar too,
  // so leaving settings lands in that organization.
  const { selectOrganization } = useSettingsWorkspaceContext();
  // Fixed at mount: a server-prefilled panel never reads on mount, and later
  // changes (accept, decline) refresh through the table.
  const [prefilled] = useState(
    initialOrganizations !== undefined && initialInvitations !== undefined,
  );
  const [status, setStatus] = useState<TeamPanelStatus>(
    prefilled ? 'ready' : 'loading',
  );
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>(
    initialOrganizations ?? [],
  );
  const [invitations, setInvitations] = useState<IncomingTeamInvitation[]>(
    initialInvitations ?? [],
  );
  // A failed list load offers Retry; a failed accept or decline does not.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  // Declining is irreversible, so it confirms via the shared ConfirmDialog.
  const [pendingDecline, setPendingDecline] =
    useState<IncomingTeamInvitation | null>(null);

  /** Re-reads the lists; resolves the memberships, or `null` on failure. */
  const refresh = useCallback(async (): Promise<
    OrganizationSummary[] | null
  > => {
    try {
      // A refresh after a loaded list keeps the list on screen; only a panel
      // with nothing to show yet goes back to its skeleton.
      setStatus((current) => (current === 'ready' ? current : 'loading'));
      setLoadError(null);
      // Invitations are supplementary; a load failure there should not block
      // the org list, so it resolves to an empty list instead of throwing.
      const loadInvitations = async (): Promise<IncomingTeamInvitation[]> => {
        try {
          return await listIncomingInvitations(client);
        } catch {
          return [];
        }
      };
      const [orgs, incoming] = await Promise.all([
        listOrganizations(client),
        loadInvitations(),
      ]);
      setOrganizations(orgs);
      setInvitations(incoming);
      setStatus('ready');
      return orgs;
    } catch (err) {
      setLoadError(errorCopy.loadCopy(err));
      setStatus('error');
      return null;
    }
  }, [client, errorCopy]);

  const handleRespond = useCallback(
    async (
      invite: IncomingTeamInvitation,
      action: 'accept' | 'decline',
    ): Promise<void> => {
      try {
        setRespondingId(invite.id);
        setActionError(null);
        await respondToInvitation(client, invite.id, action);
        // Accepting adds a membership, so the host's organization switcher
        // re-reads too; declining changes only this list.
        if (action === 'accept') followMembershipChange();
        // Refresh so the team appears (accept) or the card clears (decline).
        const listed = await refresh();
        // The invitation names its organization but not its id, so the
        // joined organization is the membership the refresh added.
        const joined =
          action === 'accept' && listed !== null
            ? listed.filter(
                (org) => !organizations.some((known) => known.id === org.id),
              )
            : [];
        const [only] = joined;
        const match =
          joined.length === 1
            ? only
            : joined.find((org) => org.name === invite.organizationName);
        if (match !== undefined) selectOrganization(match.id);
      } catch (err) {
        setActionError(
          errorCopy.actionCopy(err, {
            action:
              action === 'accept'
                ? 'accept the invitation'
                : 'decline the invitation',
          }),
        );
      } finally {
        setRespondingId(null);
        setPendingDecline(null);
      }
    },
    [
      client,
      errorCopy,
      followMembershipChange,
      organizations,
      refresh,
      selectOrganization,
    ],
  );

  useEffect(() => {
    if (prefilled) return undefined;
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [prefilled, refresh]);

  const hasOrgs = organizations.length > 0;

  useEffect(() => {
    onStateChange?.({ status, hasOrgs });
  }, [onStateChange, status, hasOrgs]);

  // No card of its own: the page header sits directly above, and the rows
  // keep their own borders.
  return (
    <section className="flex flex-col gap-6" data-testid="team-panel">
      <ErrorBanner
        className=""
        error={loadError}
        onRetry={() => void refresh()}
      />
      <ErrorBanner className="" error={actionError} />

      {status === 'ready' && invitations.length > 0 && (
        <div data-testid="team-invitations">
          <h2 className="text-s font-medium fg-primary">Pending invitations</h2>
          <p className="mt-1 text-xs fg-secondary">
            You&apos;ve been invited to these organizations. Accept to join, or
            decline to remove the invitation.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {invitations.map((invite) => {
              const busy = respondingId === invite.id;
              return (
                <li
                  key={invite.id}
                  data-testid="team-invitation-row"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary fg-secondary">
                      <Mail size={14} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-s font-medium fg-primary">
                        {invite.organizationName}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <StatusBadge variant="warning" label="Invited" />
                        <TeamRoleBadge role={invite.role} />
                        {invite.organizationTeamName && (
                          <span className="rounded-full bg-secondary px-2 py-0.5 text-3xs font-medium fg-secondary">
                            {invite.organizationTeamName}
                          </span>
                        )}
                        <span
                          className={joinClassNames(
                            'text-xs fg-secondary',
                            blockClassName,
                          )}
                        >
                          from {invite.invitedByName}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleRespond(invite, 'accept')}
                      disabled={busy}
                      data-testid="team-invitation-accept"
                      className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Check size={13} />
                      {busy ? 'Joining…' : 'Accept'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDecline(invite)}
                      disabled={busy}
                      data-testid="team-invitation-decline"
                      className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <X size={13} />
                      Decline
                    </button>
                  </div>
                  <OrgEnforcedConsentList
                    className="mt-2 w-full basis-full"
                    settings={invite.enforcedSettings}
                    heading="Required organization settings:"
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {status === 'loading' && (
        <DelayedLoadingPlaceholder>
          <SettingsListSkeleton avatarShape="square" />
        </DelayedLoadingPlaceholder>
      )}

      {status === 'ready' && !hasOrgs && (
        <div className="flex flex-col items-start gap-4 rounded-md border border-dashed bg-secondary/40 p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-subtle fg-accent">
              <Users size={18} />
            </span>
            <div>
              <p className="text-s font-medium fg-primary">
                You&apos;re not part of an organization yet.
              </p>
              <p className="text-s fg-secondary">
                Create one to invite collaborators and organize teams.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCreate}
            data-testid="team-panel-create-empty"
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-s font-medium fg-emphasis transition-opacity hover:opacity-90"
          >
            <Plus size={14} />
            Create an organization
          </button>
        </div>
      )}

      {status === 'ready' && hasOrgs && (
        <ul className="flex flex-col gap-3">
          {organizations.map((org) => (
            <li key={org.id}>
              <button
                type="button"
                onClick={() => {
                  selectOrganization(org.id);
                  router.push(`/organization/${org.id}`);
                }}
                data-testid="team-panel-org"
                className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition-colors hover:bg-secondary"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <OrganizationLogo
                    name={org.name}
                    logoUrl={org.logoUrl}
                    size={36}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-s font-medium fg-primary">
                        {org.name}
                      </span>
                      <TeamRoleBadge role={org.role} />
                    </div>
                    <p className="mt-1 text-xs fg-secondary">
                      {org.memberCount}{' '}
                      {org.memberCount === 1 ? 'member' : 'members'} ·{' '}
                      {org.subTeamCount}{' '}
                      {org.subTeamCount === 1 ? 'team' : 'teams'}
                    </p>
                  </div>
                </div>
                <span className="text-s font-medium fg-accent">Open</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {pendingDecline && (
        <SettingsConfirmDialog
          title="Decline invitation?"
          message={
            <>
              Decline the invitation to join{' '}
              <span className="font-medium fg-primary">
                {pendingDecline.organizationName}
              </span>
              ? An owner will have to invite you again to rejoin.
            </>
          }
          confirmLabel="Decline invitation"
          busyLabel="Declining…"
          busy={respondingId === pendingDecline.id}
          destructive
          dataTestId="confirm-decline-invitation"
          onConfirm={() => void handleRespond(pendingDecline, 'decline')}
          onCancel={() => setPendingDecline(null)}
        />
      )}
    </section>
  );
}
