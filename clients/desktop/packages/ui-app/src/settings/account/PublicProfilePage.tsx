'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { PersonalCatalogCard } from './personal-catalog-card';
import { ProfileRoutingBacktestSection } from './profile-routing-backtest-section';
import { PublicProfileSection } from './public-profile-section';

/**
 * `/account/profile`: the opt-in public page manager (handle + visibility,
 * bio & links, per-metric visibility, and the published-work manager), plus
 * the card that removes the desktop-synced Personal project list from the
 * web. The card is a page-level sibling because the profile section returns
 * early while no handle is claimed, and the list is visible either way.
 */
export function PublicProfilePage({
  page,
}: SettingsPageProps<'account.profile'>): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <PublicProfileSection
        initialSettings={page.data.initialSettings}
        displayName={page.data.displayName}
        avatarUrl={page.data.avatarUrl}
      />
      <PersonalCatalogCard />
      <ProfileRoutingBacktestSection />
    </div>
  );
}
