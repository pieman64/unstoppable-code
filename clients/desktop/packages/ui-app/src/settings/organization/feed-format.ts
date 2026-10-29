import type { FeedActor } from '@canopy/protocol';

/** Compact "Ns/Nm/Nh/Nd ago" relative time, falling back to the raw ISO. */
export function formatRelativeTime(iso: string): string {
  try {
    const ts = new Date(iso).getTime();
    if (Number.isNaN(ts)) {
      return iso;
    }
    const diff = Date.now() - ts;
    const sec = Math.max(0, Math.round(diff / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    return `${day}d ago`;
  } catch {
    return iso;
  }
}

/** Human display name for a feed actor, with a stable fallback. */
export function formatActor(actor: FeedActor): string {
  const name = actor.displayName?.trim();
  return name && name.length > 0 ? name : 'A teammate';
}

/** Format a USD cost, choosing precision so small amounts stay readable. */
export function formatCostUsd(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value === 0) {
    return '$0.00';
  }
  const digits = value < 1 ? 4 : 2;
  return `$${value.toFixed(digits)}`;
}

/** Compact token count, e.g. 1234 → "1.2k". */
export function formatTokens(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 1000) {
    return `${value}`;
  }
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Format a duration in milliseconds, e.g. 65000 → "1m 5s". */
export function formatDurationMs(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const totalSec = Math.round(value / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) {
    return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
}
