'use client';

import type { JSX } from 'react';
import { accountBillingPath } from '@canopy/protocol/billing';
import type { SettingsPageProps } from '../pages/page-props';
import { InvoiceDetailPage } from './invoice-detail-page';

/**
 * `/account/billing/invoices/[invoiceId]`: the personal invoice document for
 * one billing period, with a contextual return to Billing. The account frame
 * already renders the page `h1`, so the invoice number is an `h2`.
 */
export function AccountInvoicePage({
  page,
}: SettingsPageProps<'account.invoice'>): JSX.Element {
  return (
    <InvoiceDetailPage
      invoice={page.data.invoice}
      backHref={accountBillingPath()}
      backLabel="Back to billing"
      headingLevel="h2"
    />
  );
}
