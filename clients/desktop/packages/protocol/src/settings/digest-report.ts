// ---------------------------------------------------------------------------
// Browser-safe constants the digest report renderer shares with the server
// code that assembles digest bodies and leaderboards. They moved here from
// `apps/web/src/lib/digests/model-text.ts` and
// `apps/web/src/lib/telemetry/impact-score.ts`, which re-export them, so the
// shared settings UI reads the same values without importing web modules.
// ---------------------------------------------------------------------------

/**
 * The only link destination shape a digest may render as an anchor.
 *
 * Shared with `digest-report.tsx`, which applies it again at render time on
 * the authenticated surface. Two layers on purpose: `model-text.ts` decides
 * what may be written into the stored body, the report decides what may
 * become navigable.
 */
export const GITHUB_PR_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/;

/** Sentinel user key/label for PR/turn/plan rows with no resolvable actor. */
export const UNKNOWN_USER_KEY = '__unknown__';
export const UNKNOWN_USER_LABEL = 'Unknown';
