'use client';

import type { JSX } from 'react';
import {
  accountBillingPath,
  organizationBillingPath,
} from '@canopy/protocol/billing';
import type { SettingsPageProps } from '../pages/page-props';
import { InvoiceDetailPage } from './invoice-detail-page';

/**
 * `/organization/[orgId]/billing/invoices/[invoiceId]`: the organization
 * invoice document for one billing period, with a contextual return to the
 * organization's Settings → Billing subtab. OWNER/ADMIN only; the host's
 * loader decides access before this renders.
 */
export function OrganizationInvoicePage({
  route,
  page,
}: SettingsPageProps<'organization.invoice'>): JSX.Element {
  return (
    <InvoiceDetailPage
      invoice={page.data.invoice}
      backHref={
        route.scope === 'organization'
          ? organizationBillingPath(route.organizationId)
          : accountBillingPath()
      }
      backLabel="Back to billing"
    />
  );
}
