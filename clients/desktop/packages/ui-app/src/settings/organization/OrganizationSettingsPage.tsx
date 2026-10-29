'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { TeamPage } from './team-page';
import { teamPagePropsFromData } from './team-page-props';

/**
 * `/organization/[orgId]/settings`: organization configuration behind the
 * `?tab=` subtabs.
 */
export function OrganizationSettingsPage({
  page,
}: SettingsPageProps<'organization.settings'>): JSX.Element {
  return (
    <TeamPage
      key={page.data.detail.id}
      {...teamPagePropsFromData(page.data)}
      activeTab="settings"
      externalAgentsEnabled={page.data.externalAgentsEnabled}
    />
  );
}
