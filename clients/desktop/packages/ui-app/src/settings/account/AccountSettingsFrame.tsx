'use client';

import type { JSX, ReactNode } from 'react';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';
import { SettingsPageNotice } from '../layout/settings-page-notice';
import { AccountPageHeader } from './account-page-header';

/**
 * The account pages' chrome on every host: the shared settings column and the
 * header naming the current page, with the page body at a reading width
 * beneath it. Web passes its settings rail as `before`; desktop's settings
 * overlay supplies its own navigation and passes none. Desktop passes its
 * per-device sections as `after`, below the page content; web passes none.
 *
 * Hosts render this one frame for every state of an account page (loading,
 * ready, failed), so the header never moves while the body changes. A host
 * notice about the page renders below the header.
 */
export function AccountSettingsFrame({
  freeAccess,
  children,
  before,
  after,
}: {
  freeAccess: boolean;
  children: ReactNode;
  before?: ReactNode;
  after?: ReactNode;
}): JSX.Element {
  return (
    <SettingsPageColumn as="main">
      {before}
      <AccountPageHeader freeAccess={freeAccess} />
      <div
        className="flex w-full max-w-3xl flex-1 flex-col gap-6"
        data-testid="account-settings-body"
      >
        <SettingsPageNotice />
        {children}
        {after}
      </div>
    </SettingsPageColumn>
  );
}
