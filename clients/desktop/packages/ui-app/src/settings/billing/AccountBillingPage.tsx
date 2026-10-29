'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { BillingSection } from './account-billing-section';

/**
 * `/account/billing`: the personal plan, AI credits wallet, payment method
 * summary and billing history (renamed AI Credits with free access). Web
 * mounts its inline financial UI around this page through the billing slots;
 * hosts without inline checkout get the payment handoff CTAs instead.
 */
export function AccountBillingPage({
  page,
}: SettingsPageProps<'account.billing'>): JSX.Element {
  return (
    <BillingSection
      orgs={page.data.orgs}
      orgCovered={page.data.orgCovered}
      chrome={page.data.chrome}
      freeAccess={page.data.freeAccess}
    />
  );
}
