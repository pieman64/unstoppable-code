'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { TeamPage } from './team-page';
import { teamPagePropsFromData } from './team-page-props';

/**
 * `/organization/[orgId]/projects`: projects shared with the organization and
 * who can use them.
 */
export function OrganizationProjectsPage({
  page,
}: SettingsPageProps<'organization.projects'>): JSX.Element {
  return (
    <TeamPage
      key={page.data.detail.id}
      {...teamPagePropsFromData(page.data)}
      activeTab="projects"
    />
  );
}
