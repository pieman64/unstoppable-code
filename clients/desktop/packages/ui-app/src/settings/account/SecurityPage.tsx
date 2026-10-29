'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { SecurityPanel } from './SecurityPanel';

/**
 * `/account/security`: sign-in methods (with set/change password),
 * two-factor setup, and API keys.
 */
export function SecurityPage({
  page,
}: SettingsPageProps<'account.security'>): JSX.Element {
  return (
    <SecurityPanel
      brandDisplayName={page.data.brandDisplayName}
      emailPasswordAuthEnabled={page.data.emailPasswordAuthEnabled}
    />
  );
}
