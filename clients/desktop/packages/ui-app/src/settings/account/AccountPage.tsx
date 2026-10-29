'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { AccountPanel } from './AccountPanel';

/**
 * `/account`: the owner's private identity (display name / avatar / role)
 * plus the sign-in email, from the session the host resolved.
 */
export function AccountPage({
  page,
}: SettingsPageProps<'account.account'>): JSX.Element {
  return (
    <AccountPanel
      initialName={page.data.initialName}
      initialImage={page.data.initialImage}
      role={page.data.role}
      email={page.data.email}
    />
  );
}
