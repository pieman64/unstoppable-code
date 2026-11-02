/**
 * Display anchor for a shared-container revision's publication time
 * (CAN-4908).
 *
 * The fork dialog and a copy's provenance line both name the source version
 * by when it was published, so they share one formatter: a time alone for
 * today, a date and time earlier this year, and the year as well otherwise.
 * The short label is ambiguous on its own (an old "3:42 PM" says nothing about
 * which day), so `full` carries the date, time and timezone for a tooltip and
 * assistive technology.
 *
 * A time is a human-readable anchor, never an ordering key: revision IDs are
 * the identity. An unparsable value returns `null` so callers render their own
 * explicit fallback instead of `Invalid Date`.
 */

export interface RevisionTimeLabel {
  /** Compact label for running copy. */
  short: string;
  /** Full date, time and timezone for a tooltip or screen reader. */
  full: string;
  /** Normalized ISO value for a `<time dateTime>` attribute. */
  iso: string;
}

export interface RevisionTimeOptions {
  /** Reference point for "today"; defaults to the current time. */
  now?: Date;
  /** Defaults to the runtime locale. */
  locale?: string;
  /** Defaults to the runtime timezone. */
  timeZone?: string;
}

/** Calendar day key in `timeZone`, so "today" follows the viewer's clock. */
function dayKey(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function formatRevisionTime(
  value: string | undefined,
  options: RevisionTimeOptions = {},
): RevisionTimeLabel | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  const { locale, timeZone } = options;
  const now = options.now ?? new Date();

  const today = dayKey(date, timeZone) === dayKey(now, timeZone);
  const sameYear =
    dayKey(date, timeZone).slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  const short = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    ...(today
      ? {}
      : sameYear
        ? { month: 'short', day: 'numeric' }
        : { year: 'numeric', month: 'short', day: 'numeric' }),
  }).format(date);
  const full = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date);
  return { short, full, iso: date.toISOString() };
}
