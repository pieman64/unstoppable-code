/**
 * Server-rendered tests for {@link InvoiceDetailView} — it must render as an
 * RSC, so this suite renders it with no client runtime at all.
 *
 * The load-bearing assertion is the credits one: AI credits are prepaid and
 * credits-denominated, so the credits block must never carry a USD figure and
 * must never move the money totals.
 */
import { renderToString } from 'react-dom/server';
import {
  InvoiceDetailView,
  type InvoiceDetailViewInvoice,
} from '../InvoiceDetailView';

const INVOICE: InvoiceDetailViewInvoice = {
  id: '2026-03-07',
  number: 'INV-20260307',
  issuedAt: '2026-03-07T00:30:00.000Z',
  periodStart: '2026-03-07T00:30:00.000Z',
  periodEnd: '2026-04-07T00:30:00.000Z',
  currency: 'usd',
  status: 'PAID',
  isCurrent: false,
  billTo: { kind: 'user', name: 'Ada Lovelace', email: 'ada@example.com' },
  lineItems: [
    {
      id: 'chg-1',
      kind: 'SUBSCRIPTION_RENEWAL',
      status: 'SUCCEEDED',
      description: 'Business plan',
      quantity: 3,
      unitPriceUsd: 20,
      amountUsd: 60,
      servicePeriodStart: '2026-03-07T00:30:00.000Z',
      servicePeriodEnd: '2026-04-07T00:30:00.000Z',
      chargedAt: '2026-03-07T00:30:00.000Z',
      cardBrand: 'visa',
      cardLast4: '4242',
    },
  ],
  subtotalUsd: 60,
  taxUsd: 0,
  totalUsd: 60,
  amountPaidUsd: 60,
  amountRefundedUsd: 0,
  credits: {
    usageGroups: [],
    totalUsedCredits: 0,
    addedGroups: [],
    totalAddedCredits: 0,
  },
};

const formatDate = (iso: string): string => `LOCAL(${iso})`;

function render(invoice: InvoiceDetailViewInvoice): string {
  return renderToString(
    <InvoiceDetailView invoice={invoice} formatDate={formatDate} />,
  );
}

describe('InvoiceDetailView', () => {
  it('renders the header, UTC period range, and bill-to block', () => {
    const html = render(INVOICE);
    expect(html).toContain('INV-20260307');
    expect(html).toContain('Mar 7');
    expect(html).toContain('Apr 7');
    expect(html).not.toContain('Mar 6');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@example.com');
  });

  it('renders line items with quantity × unit price and the LOCAL chargedAt', () => {
    const html = render(INVOICE);
    expect(html).toContain('Business plan');
    expect(html).toContain('$60.00');
    expect(html).toContain('3 × $20.00');
    // `chargedAt` is the ONE date the caller formats locally.
    expect(html).toContain('LOCAL(2026-03-07T00:30:00.000Z)');
  });

  it('omits the quantity line when the amount does not divide evenly', () => {
    const html = render({
      ...INVOICE,
      lineItems: [{ ...INVOICE.lineItems[0], quantity: 3, unitPriceUsd: null }],
    });
    expect(html).not.toContain('3 ×');
  });

  it('renders the totals block including the $0.00 tax row', () => {
    const html = render(INVOICE);
    expect(html).toContain('Subtotal');
    expect(html).toContain('Tax');
    expect(html).toContain('$0.00');
    expect(html).toContain('Total');
    expect(html).toContain('Paid');
  });

  it('shows the refunded row only when something was refunded', () => {
    expect(render(INVOICE)).not.toContain('Refunded');
    expect(
      render({
        ...INVOICE,
        status: 'PARTIALLY_REFUNDED',
        amountRefundedUsd: 20,
      }),
    ).toContain('Refunded');
  });

  it('renders credit groups in CREDITS with no USD equivalent, and leaves the money totals alone', () => {
    const html = render({
      ...INVOICE,
      credits: {
        usageGroups: [
          {
            key: 'llm_proxy_usage|claude-sonnet-4',
            label: 'LLM usage · Claude Sonnet 4',
            reason: 'llm_proxy_usage',
            modelVersion: 'claude-sonnet-4',
            entryCount: 412,
            creditsUsed: 2561.69,
          },
          {
            // The future model-less shape (compute time, deployments).
            key: 'compute_time|',
            label: 'Compute time',
            reason: 'compute_time',
            modelVersion: null,
            entryCount: 1,
            creditsUsed: 5,
          },
        ],
        totalUsedCredits: 2566.69,
        addedGroups: [
          {
            transactionType: 'PURCHASE',
            label: 'Credit purchases',
            entryCount: 2,
            creditsAdded: 500,
          },
        ],
        totalAddedCredits: 500,
      },
    });

    expect(html).toContain('2,561.69 credits');
    expect(html).toContain('Compute time');
    // A model-less group must not carry a dangling separator.
    expect(html).not.toContain('Compute time ·');
    expect(html).toContain('Credit purchases');
    // Explicit copy that credits are not in the invoice total, AND why: this
    // fixture renders `Credit purchases` in credits while the line items bill
    // the same payments in dollars, which is exactly the pairing that reads as
    // a second unbilled charge without the reconciling sentence.
    expect(html).toContain('adds to the invoice total');
    expect(html).toContain('Credits you bought are already billed above');
    // The rendered money total is still the USD sum only — no credit figure
    // ever appears with a dollar sign.
    expect(html).not.toContain('$2,561.69');
    expect(html).not.toContain('$2,566.69');
    expect(html).not.toContain('$500.00');
    expect(html).toContain('$60.00');
  });

  it('renders explicit empty copy when the period had no credit activity', () => {
    expect(render(INVOICE)).toContain('No AI credit activity in this period.');
  });

  it('badges the in-progress period and states that totals are to date', () => {
    const html = render({ ...INVOICE, isCurrent: true });
    expect(html).toContain('Current');
    expect(html).toContain('still in progress');
  });

  it('keeps the Current badge and says payment is due for an unpaid open renewal', () => {
    const html = render({
      ...INVOICE,
      isCurrent: true,
      status: 'DUE',
      lineItems: [],
      subtotalUsd: 0,
      totalUsd: 0,
      amountPaidUsd: 0,
    });
    expect(html).toContain('Current');
    expect(html).toContain('Payment due');
    expect(html).toContain('data-testid="invoice-detail-due-status"');
    expect(html).toContain('data-testid="invoice-detail-due-note"');
  });

  it('labels a closed trial window as Free trial', () => {
    const html = render({ ...INVOICE, status: 'FREE_TRIAL', lineItems: [] });
    expect(html).toContain('Free trial');
  });

  // -----------------------------------------------------------------------
  // Per-line refund disclosure. The document-level "Refunded" total says money
  // came back but not WHICH line it came back from, which is the one question
  // a partially refunded invoice raises.
  // -----------------------------------------------------------------------

  it('discloses a partial reversal on the line it came from', () => {
    const html = render({
      ...INVOICE,
      status: 'PARTIALLY_REFUNDED',
      lineItems: [{ ...INVOICE.lineItems[0], amountRefundedUsd: 20 }],
      amountPaidUsd: 40,
      amountRefundedUsd: 20,
    });
    expect(html).toContain('Refunded $20.00');
    expect(html).toContain('data-testid="invoice-line-item-refunded-chg-1"');
    // The line amount stays GROSS so the line items still sum to the subtotal;
    // the reversal is settled in the totals, not by shrinking the line.
    expect(html).toContain('$60.00');
  });

  it('says "Fully refunded" rather than restating the whole line amount', () => {
    const html = render({
      ...INVOICE,
      status: 'REFUNDED',
      lineItems: [{ ...INVOICE.lineItems[0], amountRefundedUsd: 60 }],
      amountPaidUsd: 0,
      amountRefundedUsd: 60,
    });
    expect(html).toContain('Fully refunded');
    expect(html).not.toContain('Refunded $60.00');
  });

  it('adds no line-item note when nothing was reversed', () => {
    // Absent and 0 must behave identically — the field is optional so callers
    // predating the refund webhook keep rendering unchanged.
    for (const amountRefundedUsd of [undefined, 0]) {
      const html = render({
        ...INVOICE,
        lineItems: [{ ...INVOICE.lineItems[0], amountRefundedUsd }],
      });
      expect(html).not.toContain('invoice-line-item-refunded-');
      expect(html).not.toContain('Fully refunded');
    }
  });

  it('renders an injected back link', () => {
    const html = renderToString(
      <InvoiceDetailView
        invoice={INVOICE}
        formatDate={formatDate}
        backLink={<a href="/account/billing">Back to billing</a>}
      />,
    );
    expect(html).toContain('href="/account/billing"');
  });
});
