import {
  CURRENT_INVOICE_LABEL,
  formatInvoiceId,
  formatInvoiceNumber,
  formatUtcDate,
  formatUtcDateRange,
  humanizeInvoiceStatus,
  INVOICE_STATUS_LABELS,
  isUnpaidCurrentInvoice,
} from '../invoice-display';

describe('status labels', () => {
  it('labels every money status', () => {
    expect(INVOICE_STATUS_LABELS).toEqual({
      PAID: 'Paid',
      REFUNDED: 'Refunded',
      PARTIALLY_REFUNDED: 'Partially refunded',
      NO_CHARGES: 'No charges',
      DUE: 'Payment due',
      FREE_TRIAL: 'Free trial',
    });
    expect(humanizeInvoiceStatus('PAID')).toBe('Paid');
    expect(humanizeInvoiceStatus('PARTIALLY_REFUNDED')).toBe(
      'Partially refunded',
    );
    // A closed period with no charges must not borrow "Paid".
    expect(humanizeInvoiceStatus('NO_CHARGES')).toBe('No charges');
    expect(humanizeInvoiceStatus('DUE')).toBe('Payment due');
    expect(humanizeInvoiceStatus('FREE_TRIAL')).toBe('Free trial');
  });

  it('prettifies an unknown status rather than leaking the raw code', () => {
    expect(humanizeInvoiceStatus('SOME_NEW_STATE')).toBe('Some new state');
    expect(humanizeInvoiceStatus('')).toBe('Unknown');
  });

  it('labels the in-progress period Current, not Upcoming or Estimated', () => {
    // Canopy bills in advance: the money is collected and the totals are
    // actuals, so neither "upcoming" nor "estimated" would be true.
    expect(CURRENT_INVOICE_LABEL).toBe('Current');
  });
});

describe('UTC formatting', () => {
  // A boundary that is NOT UTC midnight — a local formatter would render the
  // previous day for a negative-UTC viewer and disagree with the URL.
  const OFF_MIDNIGHT = '2026-03-07T00:30:00.000Z';

  it('derives the id in UTC', () => {
    expect(formatInvoiceId(OFF_MIDNIGHT)).toBe('2026-03-07');
    expect(formatInvoiceId('2026-01-05T23:59:59.999Z')).toBe('2026-01-05');
  });

  it('derives the INV- number in UTC', () => {
    expect(formatInvoiceNumber(OFF_MIDNIGHT)).toBe('INV-20260307');
    expect(formatInvoiceNumber('2026-01-05T23:59:59.999Z')).toBe(
      'INV-20260105',
    );
  });

  it('renders the issue date on the UTC calendar day', () => {
    expect(formatUtcDate(OFF_MIDNIGHT)).toContain('7');
    expect(formatUtcDate(OFF_MIDNIGHT)).toContain('2026');
    // Never rolls back to Mar 6 the way a local formatter would.
    expect(formatUtcDate(OFF_MIDNIGHT)).not.toContain('6,');
  });

  it('renders a period range in UTC', () => {
    const range = formatUtcDateRange(
      '2026-07-07T00:30:00.000Z',
      '2026-08-07T00:30:00.000Z',
    );
    expect(range).toBe('Jul 7 – Aug 7');
  });

  it('falls back to the raw value for an unparseable instant', () => {
    expect(formatInvoiceId('not-a-date')).toBe('not-a-date');
    expect(formatInvoiceNumber('not-a-date')).toBe('INV-not-a-date');
    expect(formatUtcDate('not-a-date')).toBe('not-a-date');
  });

  it('pairs Current with the status only for an unpaid open renewal', () => {
    expect(isUnpaidCurrentInvoice({ isCurrent: true, status: 'DUE' })).toBe(
      true,
    );
    expect(isUnpaidCurrentInvoice({ isCurrent: true, status: 'PAID' })).toBe(
      false,
    );
    expect(isUnpaidCurrentInvoice({ isCurrent: false, status: 'DUE' })).toBe(
      false,
    );
  });
});
