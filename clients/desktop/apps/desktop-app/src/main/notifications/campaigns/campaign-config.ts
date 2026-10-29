import type {
  ActivationCampaignId,
  ActivationJourneyPersistedState,
  CampaignDestination,
} from '@canopy/desktop-shared/types';

/**
 * Declarative campaign definitions for the activation journey (CAN-1967).
 *
 * Campaigns are data, not code: the scheduler reads this table and knows
 * nothing about any individual campaign. Adding a campaign is a table entry
 * plus an eligibility predicate, never a new timer or notification call site.
 *
 * Copy here is intentionally brand-free. Any campaign that needs to name the
 * product must resolve it from the brand runtime rather than hard-coding it,
 * per the branding rules in CLAUDE.md.
 */

/**
 * `first-open` anchors to the install (absolute offsets from the first launch).
 * `abandonment` anchors to the last foreground activity, so the offset measures
 * how long the user has been away rather than how long since they installed.
 */
export type CampaignAnchor = 'first-open' | 'abandonment';

/**
 * One resolved copy + destination pairing. Variants exist because two
 * campaigns branch on user state — campaign 1 on whether a trial offer is
 * confirmed claimable, campaign 2 on persisted role — and both need the
 * destination to move with the copy, not just the words.
 */
export interface CampaignVariant {
  title: string;
  body: string;
  destination: CampaignDestination;
}

export const DEFAULT_VARIANT_KEY = 'default';

export interface CampaignDefinition {
  id: ActivationCampaignId;
  anchor: CampaignAnchor;
  offsetMs: number;
  /**
   * How late a send may be and still be worth making. Past this bound the
   * campaign expires instead of firing: a machine asleep for three days should
   * not wake up and deliver a stale 8-hour nudge.
   */
  maxLatenessMs: number;
  /**
   * Keyed copy. A campaign whose resolver returns a key absent from this map
   * suppresses as `variant-unavailable` rather than falling back, so a
   * campaign can deliberately have no neutral branch (campaign 2 does not).
   */
  variants: Record<string, CampaignVariant>;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** All four CAN-2438 campaigns. */
export const ACTIVATION_CAMPAIGNS: readonly CampaignDefinition[] = [
  {
    id: 'activation-first-task',
    anchor: 'abandonment',
    offsetMs: 10 * MINUTE_MS,
    maxLatenessMs: 12 * HOUR_MS,
    variants: {
      // Used whenever a claimable trial cannot be positively confirmed. The
      // ticket is explicit: never show an offer the account cannot claim.
      [DEFAULT_VARIANT_KEY]: {
        title: 'Ready when you are',
        body: 'Start your first task and put an agent to work.',
        destination: { kind: 'page', page: 'home' },
      },
      offer: {
        title: 'Your free month is ready',
        body: 'Start your first task and put it to work.',
        destination: { kind: 'page', page: 'home' },
      },
    },
  },
  {
    id: 'activation-role-branch',
    anchor: 'abandonment',
    offsetMs: HOUR_MS,
    maxLatenessMs: 12 * HOUR_MS,
    // Deliberately no `default`: the ticket specifies neutral copy for an
    // unknown role, but silence beats a generic nudge, so an unmapped or
    // unset role suppresses instead. Since the onboarding wizard no longer
    // auto-launches, unset is the common case and this campaign reaches a
    // minority by design.
    variants: {
      developer: {
        title: 'Put an agent on real code',
        body: 'Add a repository and let an agent work in it.',
        destination: { kind: 'add-workspace' },
      },
      business: {
        title: 'Connect the tools you already use',
        body: 'Hook up your accounts and start working with AI.',
        destination: { kind: 'settings', section: 'mcp' },
      },
    },
  },
  {
    id: 'activation-marketplace',
    anchor: 'first-open',
    offsetMs: 8 * HOUR_MS,
    maxLatenessMs: 48 * HOUR_MS,
    variants: {
      [DEFAULT_VARIANT_KEY]: {
        title: 'Ready-made pipelines are waiting',
        body: 'Discover plugins and pipelines to get started faster.',
        destination: { kind: 'page', page: 'plugins' },
      },
    },
  },
  {
    id: 'activation-mobile',
    anchor: 'first-open',
    offsetMs: 24 * HOUR_MS,
    maxLatenessMs: 72 * HOUR_MS,
    variants: {
      [DEFAULT_VARIANT_KEY]: {
        title: 'Keep work moving from your phone',
        body: 'Set up Remote Control to check on agents while you are away.',
        destination: { kind: 'canopy-portal' },
      },
    },
  },
];

/**
 * Absolute epoch milliseconds at which a campaign becomes due, or `null` when
 * its anchor has not been recorded yet (or is unparseable, which a corrupt
 * file could produce). A `null` due time means "not schedulable", never "due
 * now" — treating it as due would fire every campaign on a fresh install.
 */
export function resolveDueAt(
  definition: CampaignDefinition,
  state: ActivationJourneyPersistedState,
): number | null {
  const anchorValue =
    definition.anchor === 'first-open' ? state.firstOpenAt : state.lastActiveAt;
  if (anchorValue === null) return null;
  const anchoredAt = Date.parse(anchorValue);
  if (Number.isNaN(anchoredAt)) return null;
  return anchoredAt + definition.offsetMs;
}

/**
 * Shared promotional frequency cap (CAN-3013). At most one promotional
 * notification of ANY kind -- activation campaign or Getting Started step --
 * per window, so two banners never land on the same day from either side.
 */
export const PROMOTIONAL_SEND_INTERVAL_MS = 24 * HOUR_MS;

/** Most recent promotional send of any kind, in epoch milliseconds. */
export function resolveLastPromotionalSendMs(
  state: ActivationJourneyPersistedState,
): number | null {
  const stamps: Array<string | undefined> = [
    ...Object.values(state.campaigns).map((record) => record?.sentAt),
    ...Object.values(state.gettingStarted?.steps ?? {}).map(
      (record) => record?.sentAt,
    ),
  ];
  let latest: number | null = null;
  for (const stamp of stamps) {
    if (stamp === undefined) continue;
    const parsed = Date.parse(stamp);
    if (Number.isNaN(parsed)) continue;
    if (latest === null || parsed > latest) latest = parsed;
  }
  return latest;
}

/**
 * When the shared cap next lifts, or `null` when nothing has sent yet.
 */
export function resolvePromotionalCapLiftsAt(
  state: ActivationJourneyPersistedState,
): number | null {
  const lastSendMs = resolveLastPromotionalSendMs(state);
  return lastSendMs === null ? null : lastSendMs + PROMOTIONAL_SEND_INTERVAL_MS;
}
