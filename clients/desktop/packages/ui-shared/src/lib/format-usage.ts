/**
 * Format a token count in compact form: 103600 -> "103.6k", 1500000 -> "1.5M"
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${value.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    const rounded = value.toFixed(1);
    if (rounded === '1000.0') {
      return `${(tokens / 1_000_000).toFixed(1)}M`;
    }
    return `${rounded}k`;
  }
  return String(tokens);
}

/**
 * Format USD cost: 0.0234 -> "$0.02", 13.5 -> "$13.50"
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * Format milliseconds into human-readable duration: "1m 23s", "45s"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * When a usage limit resets, for a meter row: relative while it is under a
 * day away ("in 2 hr 45 min"), a weekday and clock time after that ("Mon
 * 10:00 AM"), or "soon". Returns `null` for a missing or unparsable time.
 */
export function formatUsageResetWhen(
  resetsAt: string | number | undefined,
  now: number = Date.now(),
): string | null {
  if (resetsAt === undefined || resetsAt === '' || resetsAt === 0) {
    return null;
  }
  const at = new Date(resetsAt).getTime();
  if (!Number.isFinite(at)) return null;
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 0) return 'soon';
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `in ${hours} hr ${rest} min` : `in ${hours} hr`;
  }
  return new Date(at).toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The full sentence: "Resets in 2 hr 45 min", "Resets Mon 10:00 AM". */
export function formatUsageResetLabel(
  resetsAt: string | number | undefined,
  now: number = Date.now(),
): string | null {
  const when = formatUsageResetWhen(resetsAt, now);
  return when === null ? null : `Resets ${when}`;
}
