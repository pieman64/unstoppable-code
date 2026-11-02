import type {
  ActivationJourneyPersistedState,
  CampaignSuppressionReason,
} from '@canopy/desktop-shared/types';
import {
  resolveDueAt,
  resolvePromotionalCapLiftsAt,
  type CampaignDefinition,
} from './campaign-config';

/**
 * Send-time eligibility gate for activation campaigns (CAN-1967).
 *
 * The gate is ordered and fail-closed. Ordering matters twice over: cheap
 * local checks run before the async product-state probes so a suppressed
 * campaign never pays for a filesystem scan, and the reported reason is the
 * FIRST failure, which keeps the funnel's suppression histogram meaningful
 * (a holdout user whose campaign already sent is reported as `already-sent`,
 * not double-counted).
 *
 * The due-time check sits above the transient gates deliberately. It used to
 * run after them, which meant a campaign eight hours from sending could report
 * `notifications-disabled` -- a reason that says nothing about why it did not
 * send, and that polluted the funnel with states the user never reached. The
 * decision object is now self-consistent for any caller, so the scheduler no
 * longer has to re-derive the due time to compensate.
 *
 * Reasons fall into three buckets, and the scheduler keys its retry behavior
 * off which one a reason lands in:
 *
 * - TERMINAL -- the campaign is done for this install: `already-sent`,
 *   `holdout`, `already-activated`, `not-eligible`, `expired`, and the
 *   role/variant failures. Never retried.
 * - TRANSIENT -- resolves with time: `no-anchor`, `not-yet-due`,
 *   `frequency-capped`, `app-focused`, `quiet-hours`, `probe-failed`. Polled
 *   on a bounded retry (the cap arms an exact retry at the time it lifts).
 * - EVENT-DRIVEN -- resolves only when something changes:
 *   `campaign-disabled`, `notifications-disabled`, `category-disabled`,
 *   `delivery-failed`. Never polled; the flag listener and the
 *   preference-save path recompute.
 *
 * A new reason MUST be added to `TRANSIENT_SUPPRESSION_REASONS` or
 * `EVENT_DRIVEN_SUPPRESSION_REASONS` in the scheduler, or it silently
 * defaults to terminal and retires the campaign. The classification test
 * pins all three lists.
 *
 * Every dependency arrives through the context so this module needs no
 * Electron, no filesystem, and no clock of its own.
 */

export interface CampaignEvaluationContext {
  state: ActivationJourneyPersistedState;
  /** Epoch milliseconds, sampled by the scheduler immediately before the call. */
  nowMs: number;
  campaignFlagEnabled: boolean;
  osNotificationsEnabled: boolean;
  activationCategoryEnabled: boolean;
  skipWhenFocused: boolean;
  appFocused: boolean;
  /** Whether `nowMs` falls inside the activation quiet window. */
  inQuietHours: boolean;
  /** Whether the user has meaningfully activated; cancels the whole journey. */
  hasActivated: () => Promise<boolean>;
  /** This campaign's own predicate (e.g. "no capability installed"). */
  isEligible: () => Promise<boolean>;
}

export type CampaignDecision =
  | { send: true }
  | { send: false; reason: CampaignSuppressionReason };

function suppress(reason: CampaignSuppressionReason): CampaignDecision {
  return { send: false, reason };
}

/**
 * Resolve an async predicate, treating a rejection as "do not send". A probe
 * that cannot answer must never be read as permission to notify.
 */
async function safePredicate(
  predicate: () => Promise<boolean>,
): Promise<boolean | null> {
  try {
    return await predicate();
  } catch {
    return null;
  }
}

export async function evaluateCampaign(
  definition: CampaignDefinition,
  context: CampaignEvaluationContext,
): Promise<CampaignDecision> {
  if (!context.campaignFlagEnabled) return suppress('campaign-disabled');

  const record = context.state.campaigns[definition.id];
  if (record?.sentAt !== undefined) return suppress('already-sent');
  // Only an explicit lifecycle event releases a refused delivery hold via
  // releaseDeliveryFailures; scheduled retries must not repeatedly ask the OS.
  if (record?.suppressedReason === 'delivery-failed') {
    return suppress('delivery-failed');
  }

  if (context.state.holdout === true) return suppress('holdout');

  // Due time first, so a campaign that is merely early never reports a
  // transient reason it has not actually hit yet.
  const dueAt = resolveDueAt(definition, context.state);
  // No anchor means the journey has not started, which is not the same as
  // "due now" -- never fire on a fresh install. It is transient, though: the
  // abandonment anchor is written on the first window focus.
  if (dueAt === null) return suppress('no-anchor');
  if (context.nowMs < dueAt) return suppress('not-yet-due');

  // Shared daily cap across every promotional send (CAN-3013). Sits with the
  // due-time check, above the preference gates: it lifts on its own, so it
  // must be reported ahead of the event-driven reasons or the scheduler
  // would have nothing to poll for while the cap is the only blocker.
  const capLiftsAt = resolvePromotionalCapLiftsAt(context.state);
  if (capLiftsAt !== null && context.nowMs < capLiftsAt) {
    return suppress('frequency-capped');
  }

  if (!context.osNotificationsEnabled) {
    return suppress('notifications-disabled');
  }
  if (!context.activationCategoryEnabled) return suppress('category-disabled');

  if (context.skipWhenFocused && context.appFocused) {
    return suppress('app-focused');
  }

  if (context.inQuietHours) return suppress('quiet-hours');

  // A probe that threw reports `probe-failed`, not `not-eligible`: both
  // suppress (fail-closed is unchanged), but only the former is retried. A
  // transient disk error must not retire the campaign for the session.
  const activated = await safePredicate(context.hasActivated);
  if (activated === null) return suppress('probe-failed');
  if (activated) return suppress('already-activated');

  const eligible = await safePredicate(context.isEligible);
  if (eligible === null) return suppress('probe-failed');
  if (!eligible) return suppress('not-eligible');

  // Lateness is checked last so a user who genuinely completed the action is
  // reported as `not-eligible` (the happy path) rather than `expired`.
  if (context.nowMs > dueAt + definition.maxLatenessMs) {
    return suppress('expired');
  }

  return { send: true };
}
