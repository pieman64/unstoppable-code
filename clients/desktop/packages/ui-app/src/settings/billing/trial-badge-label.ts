/** Whole days remaining until an ISO instant, clamped at zero. */
export function trialDaysLeft(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000));
}

/**
 * The trial-status label the account billing section and the org Billing tab
 * put on the shared warning `Badge`, worded "Trial: N days left" (which reads
 * more urgently than a raw end date). A trial runs out, so it takes the
 * warning tone next to the plan's neutral `Badge`.
 */
export function trialBadgeLabel(endsAt: string): string {
  const daysLeft = trialDaysLeft(endsAt);
  return `Trial: ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`;
}
