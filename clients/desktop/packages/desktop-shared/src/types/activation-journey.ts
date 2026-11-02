import type { NavigationPage, SettingsSection } from '../types';

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

/** Every campaign the promotional engine can send, click-route, or measure. */
export type PromotionalCampaignId = ActivationCampaignId;

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

/** Independent first-observation signals used only by activation campaigns. */
export const ACTIVATION_SIGNAL_NAMES = [
  'first-task-submitted',
  'mobile-paired',
  'tool-connected',
  'capability-installed',
] as const;

export type ActivationSignalName = (typeof ACTIVATION_SIGNAL_NAMES)[number];

/** Read-only legacy sends retained solely for the shared daily rate limit. */
export interface LegacyPromotionalSendHistory {
  steps: Partial<
    Record<
      'start-chat' | 'connect-accounts' | 'add-capability' | 'create-account',
      { sentAt: string }
    >
  >;
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
  /** Legacy send timestamps only, retained for the daily promotional cap. */
  gettingStarted?: LegacyPromotionalSendHistory;
  legacyChecklistMigrationVersion?: 1;
}

/** Renderer navigation intent produced by a campaign notification click. */
export interface ActivationCampaignNavigateEvent {
  campaignId: PromotionalCampaignId;
  destination: CampaignDestination;
}

/** Result of a state mutation; `changed` is false when the call was a no-op. */
export interface ActivationJourneyMutationResult {
  state: ActivationJourneyPersistedState;
  changed: boolean;
}
