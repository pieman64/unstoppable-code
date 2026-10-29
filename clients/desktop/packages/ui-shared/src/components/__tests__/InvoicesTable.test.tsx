/**
 * Server-rendered tests for {@link InvoicesTable}. The three things that must
 * hold no matter what: every row is a real `<a href>` built from the injected
 * `hrefFor`, invoice-level dates format in UTC regardless of the runner's TZ,
 * and the in-progress period shows `Current` INSTEAD of a money status.
 */
import { renderToString } from 'react-dom/server';
import { InvoicesTable, type InvoicesTableInvoice } from '../InvoicesTable';

const INVOICE: InvoicesTableInvoice = {
  id: '2026-03-07',
  number: 'INV-20260307',
  // 00:30Z is the whole point: a local formatter renders this as "Mar 6" for a
  // UTC-8 viewer while the shareable URL says `2026-03-07`.
  issuedAt: '2026-03-07T00:30:00.000Z',
  periodStart: '2026-03-07T00:30:00.000Z',
  periodEnd: '2026-04-07T00:30:00.000Z',
  status: 'PAID',
  isCurrent: false,
  totalUsd: 25.73,
  cardBrand: 'visa',
  cardLast4: '4242',
};

const hrefFor = (invoice: InvoicesTableInvoice): string =>
  `/account/billing/invoices/${invoice.id}`;

function render(invoices: InvoicesTableInvoice[]): string {
  return renderToString(
    <InvoicesTable
      invoices={invoices}
      hrefFor={hrefFor}
      renderLink={(props) => <a {...props} />}
    />,
  );
}

describe('InvoicesTable', () => {
  it('renders one real href per invoice, built from the injected hrefFor', () => {
    const html = render([INVOICE, { ...INVOICE, id: '2026-02-07' }]);
    expect(html).toContain('href="/account/billing/invoices/2026-03-07"');
    expect(html).toContain('href="/account/billing/invoices/2026-02-07"');
    expect(html).toContain('data-testid="invoice-row-2026-03-07"');
  });

  it('formats invoice-level dates in UTC regardless of the runner timezone', () => {
    const html = render([INVOICE]);
    // Issue date and both period bounds sit at 00:30Z — every one of them must
    // read as the 7th, never the 6th.
    expect(html).toContain('Mar 7');
    expect(html).toContain('Apr 7');
    expect(html).not.toContain('Mar 6');
    expect(html).not.toContain('Apr 6');
  });

  it('renders the invoice number, total, and card label', () => {
    const html = render([INVOICE]);
    expect(html).toContain('INV-20260307');
    expect(html).toContain('$25.73');
    expect(html).toContain('4242');
  });

  it('labels closed money statuses', () => {
    expect(render([{ ...INVOICE, status: 'REFUNDED' }])).toContain('Refunded');
    expect(render([{ ...INVOICE, status: 'PARTIALLY_REFUNDED' }])).toContain(
      'Partially refunded',
    );
  });

  it('shows the Current badge INSTEAD of the money status for the open period, even at $0.00', () => {
    const html = render([
      { ...INVOICE, isCurrent: true, totalUsd: 0, status: 'PAID' },
    ]);
    expect(html).toContain('Current');
    // A zero-charge open period must never read "Paid $0.00".
    expect(html).not.toContain('Paid');
  });

  it('keeps the Current badge and adds Payment due when the open renewal is unpaid', () => {
    // ECW-9231: an overdue personal renewal must not read "Current · $0.00" as
    // if nothing were owed.
    const html = render([
      { ...INVOICE, isCurrent: true, totalUsd: 0, status: 'DUE' },
    ]);
    expect(html).toContain('Current');
    expect(html).toContain('Payment due');
    expect(html).toContain('data-testid="invoice-status-due-2026-03-07"');
  });

  it('labels a closed no-charge trial window as Free trial', () => {
    const html = render([{ ...INVOICE, totalUsd: 0, status: 'FREE_TRIAL' }]);
    expect(html).toContain('Free trial');
    expect(html).not.toContain('No charges');
  });

  it('omits the card label entirely when the period had no card charge', () => {
    const html = render([{ ...INVOICE, cardBrand: null, cardLast4: null }]);
    // No em-dash / placeholder cell — the detail is simply absent.
    expect(html).not.toContain('····');
  });

  it('renders no rows for an empty array', () => {
    const html = render([]);
    expect(html).not.toContain('invoice-row-');
  });
});
