/**
 * Chat completion-stamp formatter (CAN-2301), following the common chat-UI
 * convention: relative time only while it is useful for spotting a stalled
 * agent, then absolute clock time.
 *
 *   < 1 minute            → "just now"
 *   < 11 minutes          → "5m ago"
 *   same calendar day     → "10:11 AM"
 *   past 6 calendar days  → "Monday, 9:15 AM"
 *   earlier this year     → "Apr 10, 9:15 AM"
 *   a previous year       → "Apr 10, 2025, 9:15 AM"
 *
 * Invalid or future timestamps render as "just now", mirroring
 * `formatRelativeTime`. Formatters are locale-aware and cached at module load
 * (see `formatDate` in the desktop renderer for why per-call
 * `toLocaleString` is too hot for transcript surfaces).
 */

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
});

const monthDayFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

const monthDayYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function formatCompletionTimestamp(
  timestamp: number,
  nowMs: number = Date.now(),
): string {
  const diffMs = nowMs - timestamp;
  if (!Number.isFinite(timestamp) || diffMs < 0) {
    return 'just now';
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 11) return `${minutes}m ago`;

  const then = new Date(timestamp);
  const now = new Date(nowMs);
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);

  if (dayDiff === 0) {
    return timeFormatter.format(timestamp);
  }

  // Within the past six calendar days the weekday name is unambiguous
  // (seven back would collide with today's name).
  if (dayDiff <= 6) {
    return `${weekdayFormatter.format(timestamp)}, ${timeFormatter.format(timestamp)}`;
  }

  const dateFormatter =
    then.getFullYear() === now.getFullYear()
      ? monthDayFormatter
      : monthDayYearFormatter;
  return `${dateFormatter.format(timestamp)}, ${timeFormatter.format(timestamp)}`;
}

const fullFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * The hover text for a completion stamp: only what the stamp itself doesn't
 * show. A relative or time-only stamp ("5m ago", "10:11 AM", "Monday,
 * 9:15 AM") gains the full date and time; a stamp that already shows its
 * date ("Apr 10, 9:15 AM") gains nothing, since a tooltip never repeats its
 * label. The model that answered, which the stamp never shows, stays.
 */
export function completionStampTooltip(
  timestamp: number,
  modelLabel?: string,
  nowMs: number = Date.now(),
): string | undefined {
  const label = formatCompletionTimestamp(timestamp, nowMs);
  const showsDate = label.includes(monthDayFormatter.format(timestamp));
  const parts = [
    ...(showsDate ? [] : [fullFormatter.format(timestamp)]),
    ...(modelLabel === undefined ? [] : [modelLabel]),
  ];
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
