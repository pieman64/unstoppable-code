'use client';

import type { JSX } from 'react';
import { useSettingsSearchParams } from '../host';
import type { SettingsPageProps } from '../pages/page-props';
import { TeamPage } from './team-page';
import { searchFlagIsSet, teamPagePropsFromData } from './team-page-props';

/**
 * `/organization/[orgId]/members`: the members list, viewable by any member.
 * `?invite=1` (the post-create redirect, the empty feed's "Invite people")
 * opens the invite dialog on arrival; the page checks who may invite.
 */
export function OrganizationMembersPage({
  page,
}: SettingsPageProps<'organization.members'>): JSX.Element {
  const searchParams = useSettingsSearchParams();
  const inviteOnLoad = searchFlagIsSet(searchParams.getAll('invite'), {
    allowRepeated: false,
  });
  return (
    <TeamPage
      key={page.data.detail.id}
      {...teamPagePropsFromData(page.data)}
      activeTab="members"
      inviteOnLoad={inviteOnLoad}
    />
  );
}
