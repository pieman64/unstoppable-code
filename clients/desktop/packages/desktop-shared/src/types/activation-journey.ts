import type {
  NavigationPage,
  OnboardingChecklistItemId,
  SettingsSection,
} from '../types';

/**
 * Activation notification journey contracts (CAN-1967 / CAN-2438).
 *
 * The campaign engine itself is main-process-only, but these ids are shared so
 * renderer settings, click routing, and instrumentation all name the same
 * campaigns. The journey is deliberately local-only: there is no server-side
 * schedule and no cross-device deduplication (see the design doc at
 * `docs/planning/2026-09-01-activation-notification-journey/design.md`).
 */
export const ACTIVATION_CAMPAIGN_IDS = [
  'activation-first-task',
  'activation-role-branch',
  'activation-marketplace',
  'activation-mobile',
] as const;

export type ActivationCampaignId = (typeof ACTIVATION_CAMPAIGN_IDS)[number];

/**
 * The daily Getting Started checklist sequence (CAN-3013).
 *
 * Deliberately NOT a member of {@link ACTIVATION_CAMPAIGN_IDS}: that list is
 * the hub-served contract (`@canopy/protocol/notification-campaigns`), one
 * definition and one send per id. The sequence is one campaign whose steps are
 * the canonical checklist item ids, so its per-step identity is the pair
 * (this id, `OnboardingChecklistItemId`) rather than four more campaign ids.
 */
export const GETTING_STARTED_SEQUENCE_CAMPAIGN_ID = 'getting-started-sequence';

export type GettingStartedSequenceCampaignId =
  typeof GETTING_STARTED_SEQUENCE_CAMPAIGN_ID;

/** Every campaign the promotional engine can send, click-route, or measure. */
export type PromotionalCampaignId =
  | ActivationCampaignId
  | GettingStartedSequenceCampaignId;

/**
 * Why a scheduled send did not happen. Every gate failure records one, so the
 * funnel can tell "never eligible" apart from "suppressed at send time", and
 * so a campaign that silently never fires is diagnosable.
 */
export const CAMPAIGN_SUPPRESSION_REASONS = [
  'campaign-disabled',
  'already-sent',
  'holdout',
  'notifications-disabled',
  'category-disabled',
  'app-focused',
  'quiet-hours',
  'already-activated',
  'not-eligible',
  /**
   * The journey has no anchor yet (fresh install, before the first window
   * focus). Distinct from `not-eligible` because it is TRANSIENT: the anchor
   * arrives shortly and the campaign must be retried, not written off.
   */
  'no-anchor',
  /** Due time has not arrived. Transient by definition. */
  'not-yet-due',
  /**
   * Another promotional notification (a campaign or a Getting Started step)
   * sent within the shared daily window (CAN-3013). Transient: the cap lifts
   * on its own 24 hours after that send.
   */
  'frequency-capped',
  /**
   * The OS accepted the request and then refused to present it -- on macOS,
   * typically because the app lacks notification authorization. Recorded by
   * unwinding the send latch, so the campaign stays deliverable. Without this
   * a banner the user never saw still burned its once-per-install send and
   * reported `delivered`.
   */
  'delivery-failed',
  /**
   * A product-state probe threw. Distinct from `not-eligible` so a transient
   * filesystem or network error retries instead of retiring the campaign for
   * the session -- the answer is unknown, not "no".
   */
  'probe-failed',
  'expired',
  /** No copy variant resolved for this user. */
  'variant-unavailable',
  /** Role-branched campaign: the user never answered the role question. */
  'role-unknown',
  /** Role-branched campaign: their role maps to neither copy branch. */
  'role-not-mapped',
  /**
   * Getting Started sequence only (CAN-3013): the user permanently dismissed
   * the checklist, which opts them out of being nudged about it. Event-driven:
   * it clears when they restore the checklist, never on a timer.
   */
  'checklist-dismissed',
] as const;

export type CampaignSuppressionReason =
  (typeof CAMPAIGN_SUPPRESSION_REASONS)[number];

/**
 * Where a campaign click lands. `page` reuses the renderer's existing
 * `NavigationPage` vocabulary so campaigns cannot invent unreachable
 * destinations; `canopy-portal` opens the Remote Control pairing modal, which
 * is a modal rather than a page and so cannot be expressed as a NavigationPage.
 */
export type CampaignDestination =
  | { kind: 'page'; page: NavigationPage }
  | { kind: 'canopy-portal' }
  | { kind: 'add-workspace' }
  | {
      kind: 'settings';
      section: SettingsSection;
      /**
       * Narrows an `account` click to the Integrations page when the renderer
       * shows hosted account settings. Ignored by the legacy rail, which keeps
       * GitHub and Linear on the Accounts section.
       */
      target?: 'integrations';
    }
  /**
   * The unfiltered skills/plugins discovery view. Not expressible as
   * `{ kind: 'page', page: 'plugins' }`: a bare page navigation leaves any
   * pending plugins intent in place, so a stale app-only filter would be
   * consumed by the remounting page.
   */
  | { kind: 'plugins-discovery' };

export interface ActivationCampaignRecord {
  sentAt?: string;
  suppressedAt?: string;
  suppressedReason?: CampaignSuppressionReason;
  clickedAt?: string;
}

/**
 * Journey-owned activation signals (CAN-2438 phase 2). These are deliberately
 * NOT onboarding-checklist items: the checklist is a user-visible sidebar UI
 * with a fixed six-item list, and adding entries to it to serve a notification
 * campaign would silently change that surface.
 */
export const ACTIVATION_SIGNAL_NAMES = [
  'first-task-submitted',
  'mobile-paired',
] as const;

export type ActivationSignalName = (typeof ACTIVATION_SIGNAL_NAMES)[number];

/**
 * Durable state for the Getting Started sequence (CAN-3013). Each step is
 * latched like a campaign so it sends at most once per install; the
 * sequence-level suppression exists only to dedupe funnel events for gates
 * that fail before a step is chosen.
 */
export interface GettingStartedSequenceRecord {
  steps: Partial<Record<OnboardingChecklistItemId, ActivationCampaignRecord>>;
  suppressedAt?: string;
  suppressedReason?: CampaignSuppressionReason;
}

export interface ActivationJourneyPersistedState {
  /** ISO-8601. Recorded once, on the first main start that finds no anchor. */
  firstOpenAt: string | null;
  /** ISO-8601. Updated on foreground activity; drives abandonment anchors. */
  lastActiveAt: string | null;
  /** Assigned once at journey start and never re-rolled. */
  holdout: boolean | null;
  campaigns: Partial<Record<ActivationCampaignId, ActivationCampaignRecord>>;
  /** ISO-8601 first-observation stamps, keyed by signal name. */
  signals: Partial<Record<ActivationSignalName, string>>;
  /** Absent on files written before CAN-3013; read as an empty sequence. */
  gettingStarted?: GettingStartedSequenceRecord;
}

/** Renderer navigation intent produced by a campaign notification click. */
export interface ActivationCampaignNavigateEvent {
  campaignId: PromotionalCampaignId;
  /** Set for Getting Started sequence clicks: the checklist step clicked. */
  itemId?: OnboardingChecklistItemId;
  destination: CampaignDestination;
}

/** Result of a state mutation; `changed` is false when the call was a no-op. */
export interface ActivationJourneyMutationResult {
  state: ActivationJourneyPersistedState;
  changed: boolean;
}
