'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { TeamPage } from './team-page';
import { teamPagePropsFromData } from './team-page-props';

/**
 * `/organization/[orgId]/statistics`: the organization usage and cost
 * dashboard. The tab gates its own content on the viewer's
 * `canViewUsageStats`.
 */
export function OrganizationStatisticsPage({
  page,
}: SettingsPageProps<'organization.statistics'>): JSX.Element {
  return (
    <TeamPage
      key={page.data.detail.id}
      {...teamPagePropsFromData(page.data)}
      activeTab="statistics"
    />
  );
}
