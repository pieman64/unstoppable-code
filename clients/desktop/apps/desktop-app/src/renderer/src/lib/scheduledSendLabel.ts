const DAY_MS = 24 * 60 * 60 * 1000;

/** Days within which a schedule is named by its weekday ("Fri 9:00 AM"). */
const WEEKDAY_HORIZON_DAYS = 6;

/** Local midnight of `date`, so day counts follow the calendar, not 24h spans. */
function startOfLocalDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/**
 * When a scheduled send goes out, in as few words as the composer chip
 * needs: `Today 3:30 PM`, `Tomorrow 9:00 AM`, `Fri 9:00 AM` within the week,
 * then `Oct 12, 9:00 AM` (with the year once it is not this year's).
 */
export function formatScheduledSendLabel(
  runAt: Date,
  now: Date = new Date(),
  locale?: string,
): string {
  const time = runAt.toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const days = Math.round(
    (startOfLocalDay(runAt) - startOfLocalDay(now)) / DAY_MS,
  );
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days <= WEEKDAY_HORIZON_DAYS) {
    return `${runAt.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  }
  const day = runAt.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(runAt.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day}, ${time}`;
}

/** The full moment, for the chip's tooltip: `Friday, October 3 at 9:00 AM`. */
export function formatScheduledSendFullLabel(
  runAt: Date,
  locale?: string,
): string {
  return runAt.toLocaleString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The same moment for a narrow composer's chip: the time alone today or
 * tomorrow (`9:00 AM`), else the day (`Sat`, `Oct 12`). The chip's tooltip
 * keeps the full moment.
 */
export function formatScheduledSendCompactLabel(
  runAt: Date,
  now: Date = new Date(),
  locale?: string,
): string {
  const days = Math.round(
    (startOfLocalDay(runAt) - startOfLocalDay(now)) / DAY_MS,
  );
  if (days === 0 || days === 1) {
    return runAt.toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  if (days > 1 && days <= WEEKDAY_HORIZON_DAYS) {
    return runAt.toLocaleDateString(locale, { weekday: 'short' });
  }
  return runAt.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(runAt.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
