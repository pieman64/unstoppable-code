/**
 * `Digest.metrics` is a Prisma `Json` column, so it arrives at the view layer
 * as `unknown`. These readers pull out the same headline numbers the email strip
 * carries (`digest-email.ts`) without asserting a shape the DB does not
 * guarantee — an older row written before a rollup field existed must degrade
 * gracefully rather than crash the report page. For the headline strip that
 * now means the slot is substituted or dropped; the dash it used to render is
 * what `readHeadlineMetrics` exists to eliminate.
 */

import {
  UNKNOWN_USER_KEY,
  UNKNOWN_USER_LABEL,
} from '@canopy/protocol/settings/digest-report';
import { memberProfileHref } from '../organization/profile-links';

export interface DigestHeadlineMetric {
  key: string;
  label: string;
  value: number | null;
  /**
   * Same metric over the immediately preceding period, from
   * `metrics.previousPeriod`. Null when the digest row predates prior-period
   * rollups, when the comparison could not be computed, or — for `cost` — when
   * the viewer is not cleared to see spend, since `projectMetrics` omits
   * `previousPeriod.totalCostUsd` entirely rather than nulling it.
   */
  previousValue: number | null;
}

export interface DigestContributorMetric {
  key: string;
  name: string;
  turns: number;
  costUsd: number;
  /** Impact score from `computeUserLeaderboard`; null on pre-Impact rows. */
  impactScore: number | null;
  /** Member profile path, or null when there is nothing safe to link to. */
  href: string | null;
}

export interface DigestContributorList {
  /** The top `TEAM_LIST_LIMIT` contributors by Impact score. */
  rows: DigestContributorMetric[];
  /**
   * Contributors present in the stored metrics but not rendered — the tail past
   * the limit, plus the unresolved-actor bucket. Surfaced as a count so the
   * list never truncates silently.
   */
  remainderCount: number;
}

/**
 * Ten keeps a 22-person org's report readable and a 200-person org's possible
 * at all. Applied at render, never in the stored rollup, so `metrics.contributors`
 * stays complete and this cutoff can change without a backfill.
 */
export const TEAM_LIST_LIMIT = 10;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...value }
    : null;
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

/**
 * Every metric the headline strip can draw from. `contributors` is only ever a
 * candidate on an org digest; on a user digest it is always one and carries no
 * information.
 */
type HeadlineMetricKey =
  | 'merged'
  | 'worktrees'
  | 'plans'
  | 'cost'
  | 'turns'
  | 'contributors';

/**
 * The ordered four cards a user digest renders, outcome first and cost last.
 *
 * `PRs merged` leads because it is the only card representing shipped, merged
 * reality. `Worktrees` is breadth: the distinct threads of work run in the
 * period. `Plans` is deliberate designed work, a real artifact rather than
 * activity. `Spend` closes the row, cost reported after the output it bought.
 */
const USER_PRIMARY_KEYS: readonly HeadlineMetricKey[] = [
  'merged',
  'worktrees',
  'plans',
  'cost',
];

/**
 * The org set holds `PRs merged` and `Worktrees` in the same first two slots so
 * the strip reads the same way whichever view you land on, then swaps
 * `Contributors` into slot 3: it is the denominator that makes every other
 * number interpretable, and the adoption signal an admin actually checks.
 * `Plans` loses that slot and becomes the first fallback.
 */
const ORGANIZATION_PRIMARY_KEYS: readonly HeadlineMetricKey[] = [
  'merged',
  'worktrees',
  'contributors',
  'cost',
];

/**
 * Substituted into a primary card's slot when that primary has no value, so
 * both the order and the four-card count hold.
 *
 * `Spend` is the primary that actually goes missing: `projectMetrics` sets
 * `includeCosts: false` for the anonymous share page, the org member-digest
 * page, the featured-profile read, and any org viewer below
 * `usageStatsMinRole`, which is most reads. Without a chain those views render
 * a permanently dead `—` card.
 *
 * `Turns` is cut from both primary sets and survives only here: it is an
 * effort proxy redundant with `Spend`, and under the report's more-is-better
 * `flex` trend scheme a drop in turns paints red, so getting the same work
 * done more efficiently would read as a regression.
 *
 * The digest email declares its own sets in
 * `apps/email-worker/src/email/templates/work-digest.tsx` and reimplements
 * this same resolver, because no shared package exists that a Node email
 * worker may import. The two are deliberately allowed to diverge on ranking
 * (see that file's doc blocks for the org `Turns`/`Plans` and `Contributors`
 * differences and why each is accepted), but the substitution contract —
 * in place, each fallback consumed at most once, drop only on exhaustion —
 * must stay identical. Change one, check the other; `docs/digests.md` holds
 * the per-surface table.
 */
const USER_FALLBACK_KEYS: readonly HeadlineMetricKey[] = ['turns'];
const ORGANIZATION_FALLBACK_KEYS: readonly HeadlineMetricKey[] = [
  'plans',
  'turns',
];

/**
 * Build every candidate card. A candidate with a null `value` has no number for
 * this digest and cannot occupy a slot; it is either substituted away or, for a
 * fallback, skipped.
 */
function buildHeadlineCandidates(
  metrics: unknown,
): Record<HeadlineMetricKey, DigestHeadlineMetric> {
  const root = asRecord(metrics);
  const turnTotals = asRecord(root?.turnTotals);
  const previous = asRecord(root?.previousPeriod);

  return {
    merged: {
      key: 'merged',
      label: 'PRs merged',
      // Prefer the exact count on new rows. The array-length fallback keeps
      // pre-count digests renderable without a backfill.
      value:
        readCount(root?.mergedPullRequestCount) ??
        readLength(root?.mergedPullRequests),
      previousValue: readCount(previous?.mergedPullRequestCount),
    },
    worktrees: {
      key: 'worktrees',
      label: 'Worktrees',
      value: readCount(root?.worktreeCount),
      previousValue: readCount(previous?.worktreeCount),
    },
    plans: {
      key: 'plans',
      label: 'Plans',
      value: readCount(root?.planCount),
      previousValue: readCount(previous?.planCount),
    },
    cost: {
      key: 'cost',
      label: 'Spend',
      value: readCount(turnTotals?.totalCostUsd),
      previousValue: readCount(previous?.totalCostUsd),
    },
    turns: {
      key: 'turns',
      label: 'Turns',
      value: readCount(turnTotals?.turnCount),
      previousValue: readCount(previous?.turnCount),
    },
    contributors: {
      key: 'contributors',
      label: 'Contributors',
      value: readLength(root?.contributors),
      previousValue: readCount(previous?.contributorCount),
    },
  };
}

/**
 * Headline strip for a digest report: normally exactly four cards, ordered
 * outcome first and cost last, populated whenever the fallback chain can cover
 * the gap.
 *
 * Walk the subject type's primaries, replacing any valueless primary in place
 * with the next fallback that has a value.
 *
 * The count that survives is exactly
 * `4 - max(0, valuelessPrimaries - valuedFallbacks)`. Only how many fallbacks
 * carry a *value* matters; chain depth does not, because the loop below shifts
 * a valueless fallback off and discards it rather than skipping past it, so it
 * is spent without filling anything. A short row still renders clean rather
 * than wrapping ragged.
 *
 * Unlike the email resolver, the drop is genuinely reachable here: this reads
 * a lenient projection rather than a schema-validated payload, so a legacy row
 * predating a metric yields `null`. Both sets can reach it — the difference is
 * how many metrics have to be missing, which is a consequence of the rule
 * above rather than a separate guarantee:
 *
 * - User set (chain `[turns]`): one missing metric is enough. `Spend` withheld
 *   on a share or featured-profile read, plus no `turnCount`, gives one
 *   valueless primary against zero valued fallbacks — three cards.
 * - Org set (chain `[plans, turns]`): needs two. `Spend` withheld plus a
 *   missing `planCount` still renders four, because `turns` fills the slot;
 *   drop `turnCount` as well and it falls to three.
 *
 * `projectMetrics` does guarantee `merged` (it falls back to the array length)
 * and always assigns `contributors` an array, so those two never go valueless —
 * but that bounds how many primaries can be missing, not whether a drop can
 * happen. Do not restate it as an impossibility claim about the org set. Each
 * case above is pinned by a test in `digest-metrics.test.ts`.
 *
 * Four is a design constraint, not a layout one. The grid in
 * `digest-report.tsx` is `grid-cols-2 sm:grid-cols-4`, which tolerates a short
 * count — three cards still fill one row at `sm+`, and four already wrap to
 * two rows below `sm`. What four buys is a clean 2-up at `grid-cols-2` and a
 * full row at `sm:grid-cols-4`, matching the email strip.
 */
export function readHeadlineMetrics(
  metrics: unknown,
  subjectType: string,
): DigestHeadlineMetric[] {
  const candidates = buildHeadlineCandidates(metrics);
  const isOrganization = subjectType === 'ORGANIZATION';
  const primaryKeys = isOrganization
    ? ORGANIZATION_PRIMARY_KEYS
    : USER_PRIMARY_KEYS;
  const fallbackKeys: HeadlineMetricKey[] = [
    ...(isOrganization ? ORGANIZATION_FALLBACK_KEYS : USER_FALLBACK_KEYS),
  ];

  const resolved: DigestHeadlineMetric[] = [];
  for (const key of primaryKeys) {
    const primary = candidates[key];
    if (primary.value !== null) {
      resolved.push(primary);
      continue;
    }
    let substitute: DigestHeadlineMetric | null = null;
    while (substitute === null) {
      const fallbackKey = fallbackKeys.shift();
      if (fallbackKey === undefined) break;
      const candidate = candidates[fallbackKey];
      if (candidate.value !== null) substitute = candidate;
    }
    if (substitute !== null) resolved.push(substitute);
  }
  return resolved;
}

/**
 * Team list for an org digest report: the Impact leaderboard for the period,
 * truncated to the top ten with the remainder acknowledged as a count.
 *
 * The stored `contributors` array is already ordered by `impactScore`
 * descending (`digest-rollup.ts` projects `computeUserLeaderboard` rows in
 * order), so this is a projection plus a cutoff, not a second ranking — the
 * re-sort below only defends the invariant. Rows written before Impact existed
 * carry no score and keep their stored order.
 *
 * `orgId` is what makes each row linkable; omit it (the public share page) and
 * every row renders unlinked.
 */
export function readContributorMetrics(
  metrics: unknown,
  options?: { orgId?: string | null },
): DigestContributorList {
  const contributors = asRecord(metrics)?.contributors;
  if (!Array.isArray(contributors)) return { rows: [], remainderCount: 0 };
  const orgId = options?.orgId ?? null;

  let parsedCount = 0;
  const ranked: DigestContributorMetric[] = [];

  contributors.forEach((value, index) => {
    const contributor = asRecord(value);
    const turns = readCount(contributor?.turnCount);
    const costUsd = readCount(contributor?.totalCostUsd);
    if (turns === null || costUsd === null) return;
    parsedCount += 1;
    const externalId =
      typeof contributor?.userExternalId === 'string' &&
      contributor.userExternalId
        ? contributor.userExternalId
        : null;
    // `computeUserLeaderboard` folds actors it cannot resolve into a single
    // sentinel bucket. That is meaningful on an analytics page and reads as a
    // bug in a report, so it never takes a ranked slot — it is counted in the
    // remainder with the rest of the tail. Historical rows may carry that same
    // bucket as a null id plus the Unknown label; an ordinary named contributor
    // with a null id remains visible but intentionally unlinked.
    if (
      externalId === UNKNOWN_USER_KEY ||
      (externalId === null && contributor?.userName === UNKNOWN_USER_LABEL)
    )
      return;
    ranked.push({
      key: externalId ?? `contributor-${String(index)}`,
      name:
        typeof contributor?.userName === 'string' && contributor.userName
          ? contributor.userName
          : UNKNOWN_USER_LABEL,
      turns,
      costUsd,
      impactScore: readCount(contributor?.impactScore),
      href:
        orgId === null || externalId === null
          ? null
          : memberProfileHref(orgId, externalId),
    });
  });

  ranked.sort((a, b) => (b.impactScore ?? -1) - (a.impactScore ?? -1));
  const rows = ranked.slice(0, TEAM_LIST_LIMIT);

  return { rows, remainderCount: parsedCount - rows.length };
}
