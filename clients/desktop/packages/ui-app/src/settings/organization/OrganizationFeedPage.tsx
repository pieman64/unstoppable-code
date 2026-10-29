'use client';

import type { JSX } from 'react';
import { useSettingsSearchParams } from '../host';
import type { SettingsPageProps } from '../pages/page-props';
import { TeamPage } from './team-page';
import { searchFlagIsSet, teamPagePropsFromData } from './team-page-props';

/**
 * `/organization/[orgId]`: the organization's activity feed, the primary
 * view. `?joined=1` (set by the invite accept route after a redemption)
 * confirms the join instead of leaving the viewer to infer it.
 */
export function OrganizationFeedPage({
  page,
}: SettingsPageProps<'organization.feed'>): JSX.Element {
  const searchParams = useSettingsSearchParams();
  const justJoined = searchFlagIsSet(searchParams.getAll('joined'), {
    allowRepeated: true,
  });
  return (
    <TeamPage
      key={page.data.detail.id}
      {...teamPagePropsFromData(page.data)}
      activeTab="feed"
      justJoined={justJoined}
    />
  );
}
