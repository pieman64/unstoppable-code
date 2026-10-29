import type {
  ActivationCampaignId,
  OnboardingChecklistItemId,
  OnboardingChecklistState,
} from '@canopy/desktop-shared/types';
import {
  hasEverSentChatMessage,
  resetChatHistoryScanForTests,
} from '../../lib/chat-history-scan';
import { computeOnboardingChecklistState } from '../../lib/onboarding-checklist-progress';
import {
  latchActivationSignal,
  readActivationJourneyState,
} from './journey-state';

/**
 * Activation signals for the campaign engine (CAN-1967 / CAN-2438).
 *
 * Checklist-derived signals reuse the sidebar onboarding checklist's evaluator
 * rather than re-instrumenting activation: it already derives completion from
 * canonical product state (never clicks or page views) and latches it durably.
 *
 * The two journey-owned signals — first task submitted, mobile ever paired —
 * are deliberately NOT checklist items. The checklist is a user-visible
 * sidebar UI with a fixed, deliberately short list (four items since
 * CAN-2663); adding entries to serve a notification campaign would silently
 * change that surface.
 *
 * Every helper fails closed, but in opposite directions, because the safe
 * answer differs: an unreadable checklist means we cannot prove the user is
 * idle, so `hasMeaningfullyActivated` returns `true` (suppressing the
 * journey), while `isCampaignEligible` returns `false` (also suppressing).
 * Uncertainty must never become a reason to notify.
 */

/**
 * Checklist items that count as meaningful product usage.
 *
 * `create-account` is deliberately excluded for the same reason the former
 * `choose-role` item was: signing in is an account action, not evidence the
 * user did anything with the product.
 *
 * CAN-2663 retired `add-repository`, `run-pipeline`, and
 * `schedule-automation` from the checklist (they moved to the Home
 * suggestions module) and added `start-chat`. Dropping those three does not
 * weaken the gate: `start-chat` and the journey-owned
 * `first-task-submitted` signal below both already prove the same
 * "user did something" fact that a repo add or pipeline run stood in for.
 */
export const ACTIVATION_ITEM_IDS: readonly OnboardingChecklistItemId[] = [
  'start-chat',
  'connect-accounts',
  'add-capability',
];

function isComplete(
  state: OnboardingChecklistState,
  itemId: OnboardingChecklistItemId,
): boolean {
  return state.items.some((item) => item.id === itemId && item.complete);
}

/**
 * Test-only: clears the memoized backfill scan. Production never resets it —
 * scanning once per process is the point.
 */
export function resetActivationSignalsForTests(): void {
  resetChatHistoryScanForTests();
}

export function latchFirstTaskSubmitted(now: string): Promise<void> {
  return latchActivationSignal('first-task-submitted', now).then(
    () => undefined,
    () => undefined,
  );
}

export function latchMobilePaired(now: string): Promise<void> {
  return latchActivationSignal('mobile-paired', now).then(
    () => undefined,
    () => undefined,
  );
}

export async function hasSubmittedFirstTask(): Promise<boolean> {
  const state = await readActivationJourneyState();
  if (state.signals['first-task-submitted'] !== undefined) return true;
  return hasEverSentChatMessage();
}

/**
 * Mobile pairing has no backfill: nothing recorded pairing before this signal
 * existed, and a live portal connection is the only observation available.
 */
export async function hasEverPairedMobile(): Promise<boolean> {
  const state = await readActivationJourneyState();
  return state.signals['mobile-paired'] !== undefined;
}

/**
 * Propagates rather than swallowing a read failure. The caller's
 * `safePredicate` maps a rejection to `probe-failed`, which suppresses
 * (fail-closed is unchanged) AND retries. Catching here returned `true`,
 * which suppressed via the TERMINAL `already-activated` -- so one transient
 * disk error retired the campaign for the whole session.
 *
 * Note this does not by itself make `probe-failed` reachable: the read layer
 * underneath still catches nearly everything (`readStateFile` falls back to
 * empty state, `computeOnboardingChecklistState` wraps its probes in
 * `evaluateSafely`). What changed is that a failure which DOES surface is no
 * longer misreported as terminal.
 */
export async function hasMeaningfullyActivated(): Promise<boolean> {
  const state = await computeOnboardingChecklistState();
  if (ACTIVATION_ITEM_IDS.some((itemId) => isComplete(state, itemId))) {
    return true;
  }
  return hasSubmittedFirstTask();
}

/**
 * Per-campaign predicate. Propagates a read failure for the same reason
 * {@link hasMeaningfullyActivated} does: the caller turns it into the
 * retryable `probe-failed` rather than the terminal `not-eligible`.
 */
export async function isCampaignEligible(
  campaignId: ActivationCampaignId,
): Promise<boolean> {
  switch (campaignId) {
    case 'activation-marketplace': {
      const state = await computeOnboardingChecklistState();
      return !isComplete(state, 'add-capability');
    }
    case 'activation-first-task':
      return !(await hasSubmittedFirstTask());
    case 'activation-mobile':
      return !(await hasEverPairedMobile());
    // Campaign 2 has no state predicate of its own: "no activation action"
    // is already enforced by the global activation gate, and the role
    // mapping decides reachability through the variant resolver.
    case 'activation-role-branch':
      return true;
  }
}
