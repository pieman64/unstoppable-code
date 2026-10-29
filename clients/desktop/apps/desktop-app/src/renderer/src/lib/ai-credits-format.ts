/**
 * Format a raw AI-credit balance for display. Rounds to a whole, non-negative
 * credit count and pluralizes the unit. Shared by the settings account panel and
 * the Usage page AI Credits tile so the two surfaces stay in sync.
 */
export function formatCredits(credits: number): string {
  // A funded fractional wallet must never be displayed as "0 credits". The
  // balance is spendable down to ledger precision even when the whole-number
  // presentation would round it away.
  if (Number.isFinite(credits) && credits > 0 && Math.round(credits) === 0) {
    return '<1 credit';
  }
  const safe = Number.isFinite(credits) ? Math.max(0, Math.round(credits)) : 0;
  return `${safe.toLocaleString()} ${safe === 1 ? 'credit' : 'credits'}`;
}
