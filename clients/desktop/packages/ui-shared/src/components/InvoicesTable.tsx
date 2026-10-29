// ---------------------------------------------------------------------------
// Billing-period invoice list shared by the personal account panel
// (`billing-section.tsx`) and the org billing tab (`team-billing-section.tsx`).
//
// Presentation-only: the "Invoices" subheader, "Load more", error line, and the
// href construction stay in each app wrapper — this component takes
// already-loaded rows and renders them.
//
// DELIBERATELY NOT A `<table>`. Every row navigates to a shareable detail URL,
// and a clickable table row is either invalid HTML (`<a>` wrapping `<tr>`) or an
// a11y compromise (`onClick` on a `<tr>`). Instead each row is a `<li>`
// containing one full-width `<a>` laid out on a grid that collapses below `sm`:
// a real href that is middle-clickable and keyboard-focusable, one link
// injection point, and a responsive collapse that is pure CSS so hydration
// matches server and client.
//
// Dates here are invoice-LEVEL dates and format in UTC via `invoice-display`
// (see the timezone rule documented in that file) — there is deliberately no
// `formatDate` prop.
// ---------------------------------------------------------------------------

import type { JSX, ReactNode } from 'react';
import { formatUsd } from '../lib/money-format';
import { formatCardLabel } from '../lib/card-display';
import {
  CURRENT_INVOICE_LABEL,
  formatUtcDate,
  formatUtcDateRange,
  humanizeInvoiceStatus,
  invoiceStatusTone,
  isUnpaidCurrentInvoice,
} from '../lib/invoice-display';
import { BillingStatusPill } from './BillingStatusPill';

/**
 * Browser-safe invoice row shape. Mirrors the fields this component renders
 * from the web `InvoiceListItem` wire contract (`billing-api-contracts.ts`)
 * with the status discriminant widened to `string`, so both the contract shape
 * and the `invoice-service` shape satisfy it.
 */
export interface InvoicesTableInvoice {
  id: string;
  number: string;
  issuedAt: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  /**
   * The in-progress period — renders the `Current` badge instead of status,
   * except an unpaid (`DUE`) renewal, which shows both.
   */
  isCurrent: boolean;
  totalUsd: number;
  cardBrand: string | null;
  cardLast4: string | null;
}

/** Props the wrapper's link element must accept. Keeps `next/link` out of here. */
export interface InvoicesTableLinkProps {
  href: string;
  className: string;
  children: ReactNode;
  'data-testid': string;
}

export interface InvoicesTableProps {
  /** Already-loaded invoice rows (the wrapper owns fetching + pagination). */
  invoices: InvoicesTableInvoice[];
  /** Detail-page href for a row — personal and org URLs differ. */
  hrefFor: (invoice: InvoicesTableInvoice) => string;
  /**
   * Renders the row link. Web passes `(p) => <Link {...p} />` so this package
   * never imports `next/link`.
   */
  renderLink: (props: InvoicesTableLinkProps) => ReactNode;
}

/**
 * `Visa ····4242`-style label, falling back to a brand-less `····4242` when
 * only `cardLast4` is present. Empty when the period had no card charge at all
 * (a credit-only or zero-charge current period).
 */
function cardLabelFor(invoice: InvoicesTableInvoice): string {
  if (invoice.cardBrand && invoice.cardLast4) {
    return formatCardLabel(invoice.cardBrand, invoice.cardLast4);
  }
  if (invoice.cardLast4) {
    return `····${invoice.cardLast4}`;
  }
  return '';
}

/**
 * Row grid tracks: `number/date | period | status | amount`.
 *
 * Each row is its OWN grid (one `<a>` per `<li>`; see the file header for why
 * this is not a `<table>`), so a content-sized (`auto`) track is measured
 * per-row and any width difference — a `Current` pill vs a `Paid` pill — pushes
 * that row's neighbours out of line with every other row. The two trailing
 * tracks are therefore FIXED, which is what makes the status pills and the
 * right-aligned totals line up down the list.
 *
 * The widths are sized to the widest content each column can hold, so they must
 * be revisited if that content grows:
 *   - status `8.5rem` fits the `Partially refunded` pill (the longest label in
 *     `INVOICE_STATUS_LABELS`) at `text-xs` + `px-2`.
 *   - amount `9rem` fits a 7-figure total on the first line and the widest card
 *     label (`Mastercard ····4242`) on the second.
 * Overflow degrades by spilling into the `gap-4` gutter rather than resizing
 * the track, so an unexpectedly long value cannot reintroduce the misalignment.
 */
const ROW_GRID_COLUMNS =
  'sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_8.5rem_9rem]';

/**
 * Status cell. For the in-progress period the `Current` badge renders IN PLACE
 * OF the money status, so a zero-charge open period never reads "Paid $0.00".
 * An unpaid open renewal keeps `Current` and adds `Payment due`; the pair wraps
 * inside the fixed status track rather than widening it.
 */
function StatusCell({
  invoice,
}: {
  invoice: InvoicesTableInvoice;
}): JSX.Element {
  if (isUnpaidCurrentInvoice(invoice)) {
    return (
      <span className="flex flex-wrap gap-1">
        <BillingStatusPill label={CURRENT_INVOICE_LABEL} tone="accent" />
        <BillingStatusPill
          label={humanizeInvoiceStatus(invoice.status)}
          tone={invoiceStatusTone(invoice.status)}
          data-testid={`invoice-status-due-${invoice.id}`}
        />
      </span>
    );
  }
  if (invoice.isCurrent) {
    return <BillingStatusPill label={CURRENT_INVOICE_LABEL} tone="accent" />;
  }
  return (
    <BillingStatusPill
      label={humanizeInvoiceStatus(invoice.status)}
      tone={invoiceStatusTone(invoice.status)}
    />
  );
}

/**
 * Invoice list. Renders nothing meaningful for an empty `invoices` array — the
 * wrapper owns the empty state (and in practice renders no section at all).
 */
export function InvoicesTable({
  invoices,
  hrefFor,
  renderLink,
}: InvoicesTableProps): JSX.Element {
  return (
    <ul className="flex flex-col divide-y" data-testid="invoices-list">
      {invoices.map((invoice) => {
        const card = cardLabelFor(invoice);
        return (
          <li key={invoice.id}>
            {renderLink({
              href: hrefFor(invoice),
              className: `focus-ring grid grid-cols-1 gap-1 rounded-md px-2 py-3 transition-colors hover:bg-subtle sm:items-center sm:gap-4 ${ROW_GRID_COLUMNS}`,
              'data-testid': `invoice-row-${invoice.id}`,
              children: (
                <>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-s font-medium fg-primary">
                      {invoice.number}
                    </span>
                    <span className="text-xs fg-tertiary">
                      {formatUtcDate(invoice.issuedAt)}
                    </span>
                  </span>

                  <span className="min-w-0 text-xs fg-secondary sm:text-s">
                    {formatUtcDateRange(invoice.periodStart, invoice.periodEnd)}
                  </span>

                  <span className="flex sm:justify-start">
                    <StatusCell invoice={invoice} />
                  </span>

                  <span className="flex items-baseline gap-2 sm:flex-col sm:items-end sm:gap-0.5">
                    <span className="whitespace-nowrap text-s font-medium tabular-nums fg-primary">
                      {formatUsd(invoice.totalUsd)}
                    </span>
                    {card ? (
                      <span className="whitespace-nowrap text-xs fg-tertiary">
                        {card}
                      </span>
                    ) : null}
                  </span>
                </>
              ),
            })}
          </li>
        );
      })}
    </ul>
  );
}
