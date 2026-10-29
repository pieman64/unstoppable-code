/** Canonical anonymous capability-URL prefix for Work Digest artifacts. */
export const DIGEST_SHARE_PATH_PREFIX = '/share/digests';

/**
 * Build the standalone public path for an unguessable digest share slug.
 *
 * The helper owns the percent-encoding so callers cannot disagree about it.
 * Before this, `digest-email.ts` pre-encoded while `digest-read-service.ts` and
 * the share page did not — three call sites, two behaviors, and adding the
 * encoding to the helper without removing the caller's would have
 * double-encoded the email link.
 */
export function digestSharePath(shareSlug: string): string {
  return `${DIGEST_SHARE_PATH_PREFIX}/${encodeURIComponent(shareSlug)}`;
}

/**
 * Per-subject Work Digest cadence toggles.
 *
 * This is the single source of truth for the digest-preferences wire contract,
 * shared by the web service layer, the web route validators, the desktop cloud
 * client, and the desktop E2E mock server. It previously existed as four
 * independent copies (`preferences-service.ts`, `route-support.ts`,
 * `desktop-shared/types.ts`, and `mock-server/routes/cloud.mjs`) with no
 * compiler link between them, so adding a cadence meant four coordinated edits
 * and any missed one failed only at runtime.
 */
export interface DigestPreferences {
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
  /** ISO weekday, Monday = 1 through Sunday = 7. */
  weeklyAnchorDay: number;
  /** UTC calendar day, clamped to the end of shorter months. */
  monthlyAnchorDay: number;
}

/** A missing preference row means weekly-only. */
export const DEFAULT_DIGEST_PREFERENCES: DigestPreferences = {
  daily: false,
  weekly: true,
  monthly: false,
  weeklyAnchorDay: 1,
  monthlyAnchorDay: 1,
};

/**
 * ISO weekday labels in ISO order, Monday first. The array is ZERO-indexed, so
 * an ISO `weeklyAnchorDay` wire value (Monday = 1) maps to `anchorDay - 1` —
 * use {@link digestWeekdayLabel} rather than indexing this directly.
 * Hardcoded English rather than `Intl` because these strings are also used by
 * the desktop renderer, which must produce byte-identical copy to the web
 * surface for the shared cadence descriptions below.
 */
export const DIGEST_WEEKDAY_LABELS: readonly string[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** Weekday name for an ISO weekday anchor, clamped to the valid 1-7 range. */
export function digestWeekdayLabel(anchorDay: number): string {
  const index = Math.min(Math.max(Math.trunc(anchorDay), 1), 7) - 1;
  return DIGEST_WEEKDAY_LABELS[index] ?? DIGEST_WEEKDAY_LABELS[0];
}

/**
 * Ordinal form of a calendar day ("1st", "12th", "31st").
 *
 * Lives here rather than in `apps/web` because the desktop settings surface
 * needs the identical string and cannot import from the web app — the reason
 * `CloudDigestSettings.tsx` previously carried hand-copied cadence copy.
 */
export function digestOrdinalDay(day: number): string {
  const value = Math.min(Math.max(Math.trunc(day), 1), 31);
  const remainderHundred = value % 100;
  if (remainderHundred >= 11 && remainderHundred <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

/** Description for the daily cadence. Constant; daily has no anchor. */
export const DIGEST_DAILY_DESCRIPTION =
  'Every morning, covering the previous day.';

/** Description for the weekly cadence at a given ISO weekday anchor. */
export function digestWeeklyDescription(anchorDay: number): string {
  return `Every ${digestWeekdayLabel(anchorDay)}, covering the previous week.`;
}

/**
 * Description for the monthly cadence at a given calendar-day anchor. Anchors
 * past the end of a short month are clamped server-side (Jan 31 -> Feb 28),
 * which the copy calls out for anchors that cannot occur every month.
 */
export function digestMonthlyDescription(anchorDay: number): string {
  const base = `On the ${digestOrdinalDay(anchorDay)}, covering the previous calendar month.`;
  return anchorDay > 28 ? `${base} Shorter months use their last day.` : base;
}

/**
 * A decoded preferences body with the anchors left ABSENT when the client did
 * not send them.
 *
 * This is deliberately a distinct type from {@link DigestPreferences}, because
 * reading and writing want opposite things from a missing anchor:
 *
 *  - A READ wants a concrete value, so every consumer can render copy without
 *    re-deriving the default. That is {@link parseDigestPreferences}.
 *  - A WRITE wants "leave it alone". Already-shipped desktop builds PATCH only
 *    `{daily, weekly, monthly}`; if the write path substituted the default here
 *    it would silently reset a user's chosen Friday/28th anchor back to
 *    Monday/1st the next time they toggled a cadence from an older client.
 *
 * Collapsing the two is what caused that regression, so the write path uses
 * {@link parseDigestPreferencesPatch} and omits absent anchors from the update.
 */
export interface DigestPreferencesPatch {
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
  /** Absent when the client omitted it — preserve the stored value. */
  weeklyAnchorDay?: number;
  /** Absent when the client omitted it — preserve the stored value. */
  monthlyAnchorDay?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow an unknown decoded JSON body to {@link DigestPreferencesPatch}.
 *
 * All three booleans are required: a partial body is rejected rather than
 * merged over the defaults, so a client that omits a cadence can never silently
 * re-enable it. The anchors are optional and are returned as `undefined` when
 * absent, never as a default — see {@link DigestPreferencesPatch}. A supplied
 * anchor is still fully range-validated.
 */
export function parseDigestPreferencesPatch(
  value: unknown,
): DigestPreferencesPatch | null {
  if (!isRecord(value)) return null;
  const { daily, weekly, monthly } = value;
  if (
    typeof daily !== 'boolean' ||
    typeof weekly !== 'boolean' ||
    typeof monthly !== 'boolean'
  ) {
    return null;
  }
  const weeklyAnchorDay = value.weeklyAnchorDay;
  const monthlyAnchorDay = value.monthlyAnchorDay;
  if (
    weeklyAnchorDay !== undefined &&
    (typeof weeklyAnchorDay !== 'number' ||
      !Number.isInteger(weeklyAnchorDay) ||
      weeklyAnchorDay < 1 ||
      weeklyAnchorDay > 7)
  ) {
    return null;
  }
  if (
    monthlyAnchorDay !== undefined &&
    (typeof monthlyAnchorDay !== 'number' ||
      !Number.isInteger(monthlyAnchorDay) ||
      monthlyAnchorDay < 1 ||
      monthlyAnchorDay > 31)
  ) {
    return null;
  }
  return {
    daily,
    weekly,
    monthly,
    ...(weeklyAnchorDay === undefined ? {} : { weeklyAnchorDay }),
    ...(monthlyAnchorDay === undefined ? {} : { monthlyAnchorDay }),
  };
}

/**
 * Narrow an unknown decoded JSON body to a fully-populated
 * {@link DigestPreferences}, substituting {@link DEFAULT_DIGEST_PREFERENCES}
 * for anchors the client omitted.
 *
 * READ path only. Do NOT use this to build a database update — see
 * {@link DigestPreferencesPatch} for why the defaults are destructive there.
 */
export function parseDigestPreferences(
  value: unknown,
): DigestPreferences | null {
  const patch = parseDigestPreferencesPatch(value);
  if (patch === null) return null;
  return {
    daily: patch.daily,
    weekly: patch.weekly,
    monthly: patch.monthly,
    weeklyAnchorDay:
      patch.weeklyAnchorDay ?? DEFAULT_DIGEST_PREFERENCES.weeklyAnchorDay,
    monthlyAnchorDay:
      patch.monthlyAnchorDay ?? DEFAULT_DIGEST_PREFERENCES.monthlyAnchorDay,
  };
}
