'use client';

import { useCallback, useEffect, useState, type JSX } from 'react';
import { settingsRouteToPath } from '@canopy/protocol/settings/route-paths';
import { Button } from '@canopy/ui-shared/components';
import { Plus } from '@canopy/ui-shared/icons/AppIcons';
import {
  useSettingsRouter,
  useSettingsSearchParams,
  useSettingsWorkspaceContext,
} from '../host';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';
import { SettingsPageNotice } from '../layout/settings-page-notice';
import type { SettingsPageProps } from '../pages/page-props';
import { CreateTeamDialog } from './create-team-dialog';
import { useMembershipChangeFollowUp } from './membership-change';
import { OrganizationListHeader } from './organization-list-header';
import { searchFlagIsSet } from './team-page-props';
import { TeamPanel, type TeamPanelState } from './team-panel';

const ORGANIZATIONS_PATH = settingsRouteToPath({ scope: 'organizations' });

/**
 * `/organization`: the Organizations list. Memberships and pending
 * invitations, with organization creation. It never redirects into a
 * current membership, so members can start another organization or act on
 * an invitation from here.
 *
 * "New organization" sits in the header once the list has loaded with at
 * least one organization; with none, the list's empty state is the one call
 * to action. Both open the same create dialog, owned here.
 *
 * `?create=1` (the sidebar switcher's Create an organization, CAN-4554)
 * opens the create dialog on arrival, or when the flag appears while the
 * page is mounted. Closing that dialog replaces the URL with the bare list
 * and creating replaces it with Members, so a reload or Back never reopens
 * it.
 */
export function OrganizationListPage({
  page,
}: SettingsPageProps<'organization.list'>): JSX.Element {
  const router = useSettingsRouter();
  const searchParams = useSettingsSearchParams();
  const followMembershipChange = useMembershipChangeFollowUp();
  // Creating an organization selects it in the app's sidebar too, so leaving
  // settings lands in that organization.
  const { selectOrganization } = useSettingsWorkspaceContext();
  const createOnLoad = searchFlagIsSet(searchParams.getAll('create'), {
    allowRepeated: false,
  });
  const { organizations, invitations } = page.data;
  // A server-prefilled list is ready at once, so its header action shows on
  // first paint; otherwise the list reports once it has read.
  const [showCreateAction, setShowCreateAction] = useState(
    organizations !== undefined &&
      invitations !== undefined &&
      organizations.length > 0,
  );
  const [creating, setCreating] = useState(createOnLoad);
  // Whether the open dialog came from `?create=1`, which it then clears.
  const [openedByFlag, setOpenedByFlag] = useState(createOnLoad);
  // The flag can arrive while the page is already mounted (desktop Settings
  // already on Organizations). Its clearing is ignored: the dialog may still
  // be open then.
  useEffect(() => {
    if (!createOnLoad) return;
    setCreating(true);
    setOpenedByFlag(true);
  }, [createOnLoad]);
  const startCreating = useCallback((): void => setCreating(true), []);
  const handleListState = useCallback(
    ({ status, hasOrgs }: TeamPanelState): void =>
      setShowCreateAction(status === 'ready' && hasOrgs),
    [],
  );

  return (
    <SettingsPageColumn as="main">
      <OrganizationListHeader
        actions={
          showCreateAction ? (
            <Button
              variant="secondary"
              size="compact"
              onClick={startCreating}
              data-testid="team-panel-create"
            >
              <Plus size={14} />
              New organization
            </Button>
          ) : undefined
        }
      />
      <SettingsPageNotice />
      <TeamPanel
        initialOrganizations={organizations}
        initialInvitations={invitations}
        onCreate={startCreating}
        onStateChange={handleListState}
      />
      {creating && (
        <CreateTeamDialog
          onClose={() => {
            setCreating(false);
            if (!openedByFlag) return;
            setOpenedByFlag(false);
            router.replace(ORGANIZATIONS_PATH);
          }}
          onCreated={(detail) => {
            setCreating(false);
            // A flag-opened create replaces `?create=1` with Members in one
            // navigation, so Back never reopens the dialog. A replace and a
            // push in the same tick leave the web router on the old URL.
            const replace = openedByFlag;
            setOpenedByFlag(false);
            // Land a freshly created organization on the Members tab with the
            // invite dialog auto-opened so the owner can invite people right
            // away. Renaming the organization is inline in the header on every
            // tab, and teams can be set up from the Teams tab when needed.
            // The host's organization switcher re-reads to show it, and
            // selects it once listed.
            selectOrganization(detail.id);
            followMembershipChange(
              `/organization/${detail.id}/members?invite=1`,
              { replace },
            );
          }}
        />
      )}
    </SettingsPageColumn>
  );
}
