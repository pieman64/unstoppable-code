'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { TeamPage } from './team-page';
import { teamPagePropsFromData } from './team-page-props';

/**
 * `/organization/[orgId]/feed/[itemId]`: a shareable permalink to one feed
 * item. The feed tab anchors on and highlights the item.
 */
export function OrganizationFeedItemPage({
  page,
}: SettingsPageProps<'organization.feedItem'>): JSX.Element {
  return (
    <TeamPage
      key={page.data.detail.id}
      {...teamPagePropsFromData(page.data)}
      activeTab="feed"
      highlightItemId={page.data.highlightItemId}
    />
  );
}
