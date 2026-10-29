// Renderer-local date math for the Automations calendar view.
//
// Native `Date` only — no date library. All arithmetic is local-time so the
// calendar's pixel offsets and day boundaries line up with the shared cron
// enumerator (`enumerateAutomationOccurrences`), which is also local-time. Week
// starts on Sunday to match `Date.getDay()` and the Google Calendar US default.

/** Sunday — matches `Date.getDay()` and the Google Calendar US default. */
export const WEEK_START_DAY = 0;

/** Half-open date window: `start` inclusive, `end` exclusive. */
export interface DateWindow {
  start: Date;
  end: Date;
}

/** Local midnight at the start of `date`'s day. */
export function startOfDay(date: Date): Date {
  const result = new Date(date.getTime());
  result.setHours(0, 0, 0, 0);
  return result;
}

/**
 * `date` shifted by `days` calendar days via `setDate`, which is DST-safe:
 * the wall-clock time is preserved across spring-forward / fall-back days
 * (unlike adding `days * 86_400_000` milliseconds).
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** `date` shifted by `months` calendar months, clamping end-of-month anchors. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const dayOfMonth = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  result.setDate(
    Math.min(dayOfMonth, daysInMonth(result.getFullYear(), result.getMonth())),
  );
  return result;
}

/** Local midnight of the Sunday that starts `date`'s week. */
export function startOfWeek(date: Date): Date {
  const start = startOfDay(date);
  const diff = (start.getDay() - WEEK_START_DAY + 7) % 7;
  return addDays(start, -diff);
}

/** Local midnight on the first day of `date`'s month. */
export function startOfMonth(date: Date): Date {
  const result = startOfDay(date);
  result.setDate(1);
  return result;
}

/** Whether `a` and `b` fall on the same local calendar day. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Whether `date` is the same local calendar day as `reference`. */
export function isToday(date: Date, reference: Date): boolean {
  return isSameDay(date, reference);
}

/** Minutes elapsed since local midnight (0..1439). Drives pixel offsets. */
export function minutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

// ---------------------------------------------------------------------------
// View windows (all half-open, all derived from the anchor date)
// ---------------------------------------------------------------------------

/** `[startOfDay(anchor), +1 day)`. */
export function dayWindow(anchor: Date): DateWindow {
  const start = startOfDay(anchor);
  return { start, end: addDays(start, 1) };
}

/** `[startOfWeek(anchor), +7 days)`. */
export function weekWindow(anchor: Date): DateWindow {
  const start = startOfWeek(anchor);
  return { start, end: addDays(start, 7) };
}

/**
 * `[firstSundayOfTheSixRowGrid, +42 days)` — the six-week (6×7) grid that the
 * month view renders, including the trailing/leading days of adjacent months.
 */
export function monthGridWindow(anchor: Date): DateWindow {
  const start = startOfWeek(startOfMonth(anchor));
  return { start, end: addDays(start, 42) };
}

/**
 * `[startOfDay(anchor), +30 days)` — anchor-based so Schedule prev/next paging
 * yields contiguous 30-day pages; `Today` resets the anchor to now, which
 * produces the "next 30 days".
 */
export function scheduleWindow(anchor: Date): DateWindow {
  const start = startOfDay(anchor);
  return { start, end: addDays(start, 30) };
}

/** The 42 day cells (six rows of seven) for the month grid. */
export function monthGridDays(anchor: Date): Date[] {
  const { start } = monthGridWindow(anchor);
  const days: Date[] = [];
  for (let index = 0; index < 42; index += 1) {
    days.push(addDays(start, index));
  }
  return days;
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const DAY_TITLE_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
};

const MONTH_TITLE_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'long',
  year: 'numeric',
};

const SHORT_MONTH_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short' };

/** "June 25, 2026". */
export function formatDayTitle(anchor: Date): string {
  return startOfDay(anchor).toLocaleDateString(undefined, DAY_TITLE_OPTIONS);
}

/** "June 2026". */
export function formatMonthTitle(anchor: Date): string {
  return startOfMonth(anchor).toLocaleDateString(
    undefined,
    MONTH_TITLE_OPTIONS,
  );
}

/**
 * Format an inclusive `[start, endInclusive]` span, collapsing shared
 * month/year. Handles month and year crossings:
 * - same month:  "Jun 22 – 28, 2026"
 * - same year:   "Jun 25 – Jul 24, 2026"
 * - cross year:  "Dec 28, 2026 – Jan 3, 2027"
 */
function formatRangeTitle(start: Date, endInclusive: Date): string {
  const startMonth = start.toLocaleDateString(undefined, SHORT_MONTH_OPTIONS);
  const endMonth = endInclusive.toLocaleDateString(
    undefined,
    SHORT_MONTH_OPTIONS,
  );
  const sameYear = start.getFullYear() === endInclusive.getFullYear();
  const sameMonth = sameYear && start.getMonth() === endInclusive.getMonth();
  if (sameMonth) {
    return `${startMonth} ${start.getDate()} – ${endInclusive.getDate()}, ${endInclusive.getFullYear()}`;
  }
  if (sameYear) {
    return `${startMonth} ${start.getDate()} – ${endMonth} ${endInclusive.getDate()}, ${endInclusive.getFullYear()}`;
  }
  return `${startMonth} ${start.getDate()}, ${start.getFullYear()} – ${endMonth} ${endInclusive.getDate()}, ${endInclusive.getFullYear()}`;
}

/** "Jun 22 – 28, 2026" (handles month / year crossing). */
export function formatWeekTitle(anchor: Date): string {
  const start = startOfWeek(anchor);
  return formatRangeTitle(start, addDays(start, 6));
}

/** The 30-day Schedule span, e.g. "Jun 25 – Jul 24, 2026". */
export function formatScheduleTitle(anchor: Date): string {
  const start = startOfDay(anchor);
  return formatRangeTitle(start, addDays(start, 29));
}
