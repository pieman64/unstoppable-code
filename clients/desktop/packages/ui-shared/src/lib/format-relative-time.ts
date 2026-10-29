/**
 * Compact relative-time label ("42s ago" / "3m ago" / "5h ago" / "2d ago").
 * Invalid, missing, or future timestamps render as "just now". Shared by the
 * desktop renderer (`@/lib/format` re-export) and shared activity bodies so
 * both surfaces format identically. `now` defaults to the current time; a
 * surface that ticks its own clock passes it.
 */
export function formatRelativeTime(
  timestamp: string | number | undefined,
  now: number = Date.now(),
): string {
  if (timestamp === undefined) {
    return 'just now';
  }
  const then =
    typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const diffMs = now - then;

  if (!Number.isFinite(then) || diffMs < 0) {
    return 'just now';
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Shortest age label for a list row's last activity: minutes (`5m`), hours
 * (`3h`), days (`2d`), weeks from seven days (`3w`), months from thirty days
 * (`2mo`), and years (`1y`). The first minute reads `1m`, never `now`, so
 * every row carries the same number-and-unit label. Invalid or future times
 * read `1m` too. `now` is passed in so a list renders every row against one
 * clock tick.
 */
export function formatCompactAge(
  timestamp: string | number,
  now: number,
): string {
  const then =
    typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const diffMs = now - then;
  if (!Number.isFinite(then) || diffMs < 60_000) return '1m';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
