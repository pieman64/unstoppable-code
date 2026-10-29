// ---------------------------------------------------------------------------
// Responsive AI-credit-ledger display shared by the personal account panel
// (`billing-section.tsx`) and the org billing tab (`team-billing-section.tsx`).
//
// Presentation-only, mirroring `BillingHistoryTable`: the section heading and
// empty-state stay in each app wrapper. On `sm`+ this renders the familiar
// 3-column table; below `sm` it renders a stacked labeled card per entry. The
// layout swap is pure CSS so it hydrates identically server- and client-side.
//
// Positive credits render `+`-prefixed; debits (negative) render muted — the
// two surfaces are unified onto this single treatment.
//
// CAN-2300 — both wrappers are CUSTOMER-facing. `entry.description` is the
// server-computed SAFE display string (`describeLedgerEntry` in
// `ledger-history-service.ts`); this component renders it verbatim and derives
// no copy of its own from the ledger row. The raw `reason` column is a staff
// audit record that can contain operator free text, and reaches staff only as
// `internalReason` on `AiCreditsAdminLedgerEntry` — never render that field
// here, and never re-humanize a reason client-side.
// ---------------------------------------------------------------------------

import type { JSX } from 'react';
import type { AiCreditsLedgerEntry } from '@canopy/protocol';
import { formatCredits } from '../lib/billing-format';

/**
 * Exactly the customer-safe display fields this component reads, picked from
 * the customer-facing {@link AiCreditsLedgerEntry} so the two cannot drift.
 *
 * Deliberately a `Pick` rather than the whole entry (CAN-2300): the component
 * has no staff mode, and naming the four fields it renders makes "this renders
 * nothing but the safe display string" a property of the TYPE rather than of a
 * comment.
 *
 * Precise about what this does and does not guarantee. The `Pick` drops the
 * `never` guards that `AiCreditsLedgerEntry` carries, so an
 * `AiCreditsAdminLedgerEntry` IS still structurally assignable here — passing
 * `adminPage.entries` compiles. That is intentional and safe: the guarantee at
 * this boundary is that the component can only ever READ these four fields, so
 * a row carrying privileged extras renders nothing privileged (pinned by the
 * "renders only the safe description" test, which passes exactly such a row).
 *
 * The compile-time rejection of the admin shape lives where the leak would
 * actually happen — `AiCreditsLedgerEntry` in `@canopy/protocol`, which stops a
 * customer route from serializing an admin page. Do not read this type as a
 * second enforcement point for that.
 */
export type CreditLedgerRow = Pick<
  AiCreditsLedgerEntry,
  'id' | 'createdAt' | 'credits' | 'description'
>;

export interface CreditLedgerTableProps {
  /** Already-loaded ledger entries (the wrapper owns fetching + pagination). */
  entries: CreditLedgerRow[];
  /** Per-surface date formatter — injected for the same reason as history. */
  formatDate: (iso: string) => string;
}

/** `+123` for credits/top-ups, plain for debits. */
function creditLabel(credits: number): string {
  return credits > 0 ? `+${formatCredits(credits)}` : formatCredits(credits);
}

/**
 * Responsive credit-ledger layout. Renders a `sm`+ table plus a below-`sm`
 * stacked list of the same entries; renders nothing meaningful for an empty
 * `entries` array (the wrapper is responsible for the empty state).
 */
export function CreditLedgerTable({
  entries,
  formatDate,
}: CreditLedgerTableProps): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="hidden w-full text-left text-s sm:table">
        <thead>
          <tr className="text-xs fg-secondary">
            <th className="py-2 pr-4 font-medium">Date</th>
            <th className="py-2 pr-4 font-medium">Description</th>
            <th className="py-2 font-medium">Credits</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {entries.map((entry) => (
            <tr key={entry.id} data-testid={`credit-ledger-row-${entry.id}`}>
              <td className="whitespace-nowrap py-2 pr-4 fg-secondary">
                {formatDate(entry.createdAt)}
              </td>
              <td className="py-2 pr-4 fg-primary">
                {entry.description ?? '—'}
              </td>
              <td
                className={`whitespace-nowrap py-2 ${
                  entry.credits < 0 ? 'fg-secondary' : 'fg-primary'
                }`}
              >
                {creditLabel(entry.credits)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="flex flex-col divide-y sm:hidden">
        {entries.map((entry) => (
          <li
            key={entry.id}
            data-testid={`credit-ledger-card-${entry.id}`}
            className="flex flex-col gap-1 py-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 break-words text-s fg-primary">
                {entry.description ?? '—'}
              </span>
              <span
                className={`whitespace-nowrap text-s font-medium ${
                  entry.credits < 0 ? 'fg-secondary' : 'fg-primary'
                }`}
              >
                {creditLabel(entry.credits)}
              </span>
            </div>
            <div className="text-xs fg-secondary">
              {formatDate(entry.createdAt)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
