// Pure display helpers for the shared plan review/comment UI. These back the
// GitHub-review-style thread components used on both the desktop renderer and
// the web plan page, so the two surfaces share one visual language (avatars,
// author identity, relative timestamps).

/** Author kinds carried on the wire for a plan comment. */
export type PlanReviewAuthorKind = 'user' | 'agent' | 'remote';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Format a comment timestamp into a compact relative label ("just now", "5m
 * ago", "3h ago", "2d ago") with an absolute string for the `title` tooltip,
 * falling back to a short date past a week. `nowMs` is injectable for tests.
 */
export function formatPlanCommentTime(
  iso: string,
  nowMs: number = Date.now(),
): { relative: string; absolute: string } {
  const date = new Date(iso);
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    return { relative: '', absolute: iso };
  }
  const absolute = date.toLocaleString();
  const diff = Math.max(0, nowMs - ms);
  if (diff < 45 * SECOND) {
    return { relative: 'just now', absolute };
  }
  if (diff < HOUR) {
    return { relative: `${Math.floor(diff / MINUTE)}m ago`, absolute };
  }
  if (diff < DAY) {
    return { relative: `${Math.floor(diff / HOUR)}h ago`, absolute };
  }
  if (diff < 7 * DAY) {
    return { relative: `${Math.floor(diff / DAY)}d ago`, absolute };
  }
  return {
    relative: date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    }),
    absolute,
  };
}
