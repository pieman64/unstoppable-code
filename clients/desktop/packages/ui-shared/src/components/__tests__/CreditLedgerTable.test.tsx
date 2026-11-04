/**
 * Server-rendered tests for {@link CreditLedgerTable}. Validates that the `sm`+
 * table and the below-`sm` stacked list both render the same ledger data (with
 * the injected `formatDate` and the shared `formatCredits`), positive entries
 * render `+`-prefixed, and an empty `entries` array renders no rows.
 */
import { renderToString } from 'react-dom/server';
import type {
  AiCreditsAdminLedgerEntry,
  AiCreditsLedgerEntry,
} from '@canopy/protocol';
import { CreditLedgerTable } from '../CreditLedgerTable';

const CREDIT: AiCreditsLedgerEntry = {
  id: 'led-credit',
  createdAt: '2026-07-16T00:00:00.000Z',
  credits: 500,
  description: 'Top-up',
};

const DEBIT: AiCreditsLedgerEntry = {
  id: 'led-debit',
  createdAt: '2026-07-15T00:00:00.000Z',
  credits: -120,
  description: 'Usage',
};

const formatDate = (iso: string): string => `DATE(${iso})`;

describe('CreditLedgerTable', () => {
  it('renders both the sm+ table and the stacked mobile list', () => {
    const html = renderToString(
      <CreditLedgerTable entries={[CREDIT]} formatDate={formatDate} />,
    );
    expect(html).toContain('sm:block');
    expect(html).toContain('sm:hidden');
    expect(html).toContain('Date');
    expect(html).toContain('Description');
    expect(html).toContain('Credits');
  });

  it('renders entry data through the injected + shared formatters', () => {
    const html = renderToString(
      <CreditLedgerTable entries={[CREDIT]} formatDate={formatDate} />,
    );
    expect(html).toContain('DATE(2026-07-16T00:00:00.000Z)');
    expect(html).toContain('Top-up');
    expect(html).toContain('+500');
    expect(html).toContain('data-testid="credit-ledger-row-led-credit"');
    expect(html).toContain('data-testid="credit-ledger-card-led-credit"');
  });

  it('renders debits without a plus prefix and with muted styling', () => {
    const html = renderToString(
      <CreditLedgerTable entries={[DEBIT]} formatDate={formatDate} />,
    );
    expect(html).toContain('-120');
    expect(html).not.toContain('+-120');
    expect(html).toContain('fg-secondary');
  });

  it('falls back to an em dash when there is no description', () => {
    const html = renderToString(
      <CreditLedgerTable
        entries={[{ ...CREDIT, description: undefined }]}
        formatDate={formatDate}
      />,
    );
    expect(html).toContain('—');
  });

  // CAN-2300 — the wallet is customer-facing, so the only string it may show is
  // the server-computed safe `description`. This pins that the component does
  // not read (or fall back to) any other field on the row: an entry carrying the
  // privileged audit fields renders the neutral label and nothing else.
  it('renders only the safe description, never the raw audit reason', () => {
    const adminAdjustment: AiCreditsAdminLedgerEntry = {
      id: 'led-admin',
      createdAt: '2026-07-17T00:00:00.000Z',
      credits: 250,
      description: 'Credits added',
      internalReason: 'Admin Panel - jane@ud.com - refund for bad chat',
      transactionType: 'GRANT',
      grantedByAdminId: 0,
    };

    const html = renderToString(
      <CreditLedgerTable entries={[adminAdjustment]} formatDate={formatDate} />,
    );

    expect(html).toContain('Credits added');
    expect(html).not.toContain('Admin Panel');
    expect(html).not.toContain('jane@ud.com');
    expect(html).not.toContain('refund for bad chat');
    expect(html).not.toContain('GRANT');
  });

  it('renders no rows for an empty ledger', () => {
    const html = renderToString(
      <CreditLedgerTable entries={[]} formatDate={formatDate} />,
    );
    expect(html).not.toContain('credit-ledger-row-');
    expect(html).not.toContain('credit-ledger-card-');
  });
});
