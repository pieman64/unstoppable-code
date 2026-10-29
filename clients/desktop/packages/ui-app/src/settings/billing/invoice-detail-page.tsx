'use client';

// ---------------------------------------------------------------------------
// Shared by both invoice detail routes on every host, so the personal and org
// invoice pages produce identical markup by construction rather than by two
// hand-kept copies. A client component: the back link is the host's link and
// the bill-to details follow the host's replay privacy.
//
// `InvoiceDetailView` is imported from its own subpath rather than the
// `@canopy/ui-shared/components` barrel so the page chunk stays small.
// ---------------------------------------------------------------------------

import type { JSX } from 'react';
import { InvoiceDetailView } from '@canopy/ui-shared/components/InvoiceDetailView';
import type { InvoiceDetail } from '@canopy/protocol/settings/billing';
import { SettingsLink, useSettingsPrivacy } from '../host';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';

/**
 * Local wall-clock formatter for line-item `chargedAt` only — invoice-level
 * dates format in UTC inside `InvoiceDetailView`.
 */
function formatChargedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export interface InvoiceDetailPageProps {
  invoice: InvoiceDetail;
  backHref: string;
  backLabel: string;
  /**
   * Heading level for the invoice number. The account route nests inside
   * `account/layout.tsx`, which already renders an `h1` (the page header), so
   * it passes `h2`; the org route has no competing page heading and keeps `h1`.
   */
  headingLevel?: 'h1' | 'h2';
}

export function InvoiceDetailPage({
  invoice,
  backHref,
  backLabel,
  headingLevel,
}: InvoiceDetailPageProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  return (
    // The shared settings column (inside the account frame it adds no second
    // inset); the invoice keeps its document width.
    <SettingsPageColumn>
      <div className="w-full max-w-3xl">
        <InvoiceDetailView
          invoice={invoice}
          formatDate={formatChargedAt}
          headingLevel={headingLevel}
          blockBillToFromReplay={blockClassName !== ''}
          backLink={
            <SettingsLink
              href={backHref}
              data-testid="invoice-detail-back"
              className="focus-ring rounded text-s fg-secondary transition-colors hover:fg-primary"
            >
              {`← ${backLabel}`}
            </SettingsLink>
          }
        />
      </div>
    </SettingsPageColumn>
  );
}
