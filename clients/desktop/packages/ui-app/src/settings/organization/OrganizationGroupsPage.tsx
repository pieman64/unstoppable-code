'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { TeamPage } from './team-page';
import { teamPagePropsFromData } from './team-page-props';

/**
 * `/organization/[orgId]/teams`: the organization's teams, viewable by any
 * member; management stays role-gated.
 */
export function OrganizationGroupsPage({
  page,
}: SettingsPageProps<'organization.groups'>): JSX.Element {
  return (
    <TeamPage
      key={page.data.detail.id}
      {...teamPagePropsFromData(page.data)}
      activeTab="groups"
    />
  );
}
