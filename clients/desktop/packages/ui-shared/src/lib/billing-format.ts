// Pure display helpers for billing/credits surfaces, shared between the desktop
// renderer and the web app. Standard DOM/Intl APIs only — no Node, Electron, or
// Next dependencies.

/** Render a credit amount (number or decimal string) as a compact integer-ish label. */
export function formatCredits(value: number | string): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Short "Aug 1"-style month/day label, falling back to the raw value.
 *
 * Pass `{ timeZone: 'UTC' }` when the input is a UTC calendar boundary (e.g. a
 * month-reset timestamp at UTC midnight) so it does not render as the previous
 * day for viewers in negative-UTC timezones. Omit it for wall-clock timestamps
 * that should display in the viewer's local timezone.
 */
export function formatMonthDay(
  iso: string,
  opts?: { timeZone?: string },
): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: opts?.timeZone,
  });
}
