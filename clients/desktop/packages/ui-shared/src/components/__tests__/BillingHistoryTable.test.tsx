/**
 * Server-rendered tests for {@link BillingHistoryTable}. Validates that the
 * `sm`+ table and the below-`sm` stacked list both render the same row data
 * (with the injected `formatDate` and the shared money/card formatters), and
 * that an empty `charges` array renders no rows — the empty state is the app
 * wrapper's responsibility, not this presentation-only component's.
 */
import { renderToString } from 'react-dom/server';
import {
  BillingHistoryTable,
  type BillingHistoryCharge,
} from '../BillingHistoryTable';

const CHARGE: BillingHistoryCharge = {
  id: 'chg-1',
  kind: 'SUBSCRIPTION_RENEWAL',
  status: 'SUCCEEDED',
  amountUsd: 20,
  description: 'Pro plan',
  cardBrand: 'visa',
  cardLast4: '4242',
  createdAt: '2026-07-16T00:00:00.000Z',
};

const formatDate = (iso: string): string => `DATE(${iso})`;

describe('BillingHistoryTable', () => {
  it('renders both the sm+ table and the stacked mobile list', () => {
    const html = renderToString(
      <BillingHistoryTable charges={[CHARGE]} formatDate={formatDate} />,
    );
    // sm+ table layout.
    expect(html).toContain('sm:block');
    // below-sm stacked list.
    expect(html).toContain('sm:hidden');
    // Table header labels.
    expect(html).toContain('Date');
    expect(html).toContain('Description');
    expect(html).toContain('Amount');
    expect(html).toContain('Status');
    expect(html).toContain('Card');
  });

  it('renders the row data through the injected + shared formatters', () => {
    const html = renderToString(
      <BillingHistoryTable charges={[CHARGE]} formatDate={formatDate} />,
    );
    expect(html).toContain('DATE(2026-07-16T00:00:00.000Z)');
    expect(html).toContain('Pro plan');
    // formatUsd(20).
    expect(html).toContain('$20.00');
    // Status renders humanized, never the raw enum token.
    expect(html).toContain('Succeeded');
    expect(html).not.toContain('SUCCEEDED');
    // formatCardLabel('visa', '4242').
    expect(html).toContain('Visa');
    expect(html).toContain('4242');
    // Both layouts carry the row, so the id-scoped hooks are present.
    expect(html).toContain('data-testid="billing-history-row-chg-1"');
    expect(html).toContain('data-testid="billing-history-card-chg-1"');
  });

  it('falls back to the humanized charge kind when there is no description', () => {
    const html = renderToString(
      <BillingHistoryTable
        charges={[{ ...CHARGE, kind: 'CREDIT_TOP_UP', description: null }]}
        formatDate={formatDate}
      />,
    );
    // Never the raw enum token; the curated label instead.
    expect(html).toContain('Credit purchase');
    expect(html).not.toContain('CREDIT_TOP_UP');
  });

  it('humanizes an unknown/future kind or status instead of leaking the enum', () => {
    const html = renderToString(
      <BillingHistoryTable
        charges={[
          {
            ...CHARGE,
            kind: 'SOME_FUTURE_KIND',
            status: 'PARTIALLY_REFUNDED',
            description: null,
          },
        ]}
        formatDate={formatDate}
      />,
    );
    expect(html).toContain('Some future kind');
    expect(html).toContain('Partially refunded');
    expect(html).not.toContain('SOME_FUTURE_KIND');
    expect(html).not.toContain('PARTIALLY_REFUNDED');
  });

  it('omits the card cell content when brand/last4 are missing', () => {
    const html = renderToString(
      <BillingHistoryTable
        charges={[{ ...CHARGE, cardBrand: null, cardLast4: null }]}
        formatDate={formatDate}
      />,
    );
    expect(html).not.toContain('4242');
  });

  it('still shows the last4 when only the brand is missing', () => {
    // Older/partial charge records can carry last4 without a brand; the last4
    // must still render (brand-less `····4242`) rather than a blank cell.
    const html = renderToString(
      <BillingHistoryTable
        charges={[{ ...CHARGE, cardBrand: null }]}
        formatDate={formatDate}
      />,
    );
    expect(html).toContain('4242');
    expect(html).not.toContain('Visa');
  });

  it('puts the amount last and right-aligned so it shares the invoice list edge', () => {
    // The two lists render stacked in the same card, so the money column has to
    // terminate on the same edge in both. A column reorder that moves `Amount`
    // back off the end breaks that alignment without failing anything else.
    const html = renderToString(
      <BillingHistoryTable charges={[CHARGE]} formatDate={formatDate} />,
    );
    const headers = ['Date', 'Description', 'Card', 'Status', 'Amount'];
    const positions = headers.map((header) => html.indexOf(`>${header}<`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((position) => position >= 0)).toBe(true);
    // Right-aligned, and tabular so decimal points line up down the column.
    expect(html).toContain('text-right tabular-nums');
  });

  it('renders status as a pill, neutral for the succeeded majority', () => {
    const html = renderToString(
      <BillingHistoryTable charges={[CHARGE]} formatDate={formatDate} />,
    );
    expect(html).toContain('rounded-full');
    // Color is reserved for the exceptions; the expected outcome stays quiet.
    expect(html).toContain('bg-muted fg-secondary');
    expect(html).not.toContain('bg-destructive-subtle');
  });

  it('tones a failed charge as destructive so it is findable in a long list', () => {
    const html = renderToString(
      <BillingHistoryTable
        charges={[{ ...CHARGE, status: 'FAILED' }]}
        formatDate={formatDate}
      />,
    );
    expect(html).toContain('bg-destructive-subtle fg-destructive');
    expect(html).toContain('Failed');
  });

  // ---------------------------------------------------------------------
  // Refund disclosure. A charge only flips to REFUNDED once reversals cover
  // the full amount, so `status` alone cannot describe a partial refund.
  // ---------------------------------------------------------------------

  it('reports a partially refunded charge as such, not as plain Succeeded', () => {
    const html = renderToString(
      <BillingHistoryTable
        charges={[{ ...CHARGE, amountRefundedUsd: 5 }]}
        formatDate={formatDate}
      />,
    );
    expect(html).toContain('Partially refunded');
    expect(html).not.toContain('>Succeeded<');
    // The headline stays the GROSS charge (what hit the card); the reversal is
    // disclosed underneath rather than silently shrinking the number.
    expect(html).toContain('$20.00');
    expect(html).toContain('$5.00 refunded');
    expect(html).toContain('data-testid="billing-history-refunded-chg-1"');
    expect(html).toContain('data-testid="billing-history-card-refunded-chg-1"');
  });

  it('reports a fully reversed charge as Refunded even while status lags', () => {
    // Convergent aggregates: the reversed total and the status flip are two
    // separate writes, so the UI must not depend on having observed both.
    const html = renderToString(
      <BillingHistoryTable
        charges={[{ ...CHARGE, amountRefundedUsd: 20 }]}
        formatDate={formatDate}
      />,
    );
    expect(html).toContain('Refunded');
    expect(html).not.toContain('Partially refunded');
    expect(html).not.toContain('>Succeeded<');
  });

  it('clamps an over-refund instead of claiming more came back than went out', () => {
    const html = renderToString(
      <BillingHistoryTable
        charges={[{ ...CHARGE, amountRefundedUsd: 999 }]}
        formatDate={formatDate}
      />,
    );
    expect(html).toContain('$20.00 refunded');
    expect(html).not.toContain('$999.00');
  });

  it('leaves an untouched charge alone whether the field is 0 or absent', () => {
    for (const charge of [CHARGE, { ...CHARGE, amountRefundedUsd: 0 }]) {
      const html = renderToString(
        <BillingHistoryTable charges={[charge]} formatDate={formatDate} />,
      );
      expect(html).toContain('Succeeded');
      expect(html).not.toContain('refunded');
      expect(html).not.toContain('billing-history-refunded-');
    }
  });

  it('never re-labels a FAILED charge, which collected nothing to reverse', () => {
    // A refunded amount on a non-collected charge is a server-side anomaly; the
    // UI must surface it as still-Failed rather than paper over it.
    const html = renderToString(
      <BillingHistoryTable
        charges={[{ ...CHARGE, status: 'FAILED', amountRefundedUsd: 20 }]}
        formatDate={formatDate}
      />,
    );
    expect(html).toContain('Failed');
    expect(html).not.toContain('Refunded');
  });

  it('renders no rows for an empty charge list', () => {
    const html = renderToString(
      <BillingHistoryTable charges={[]} formatDate={formatDate} />,
    );
    expect(html).not.toContain('billing-history-row-');
    expect(html).not.toContain('billing-history-card-');
  });
});
