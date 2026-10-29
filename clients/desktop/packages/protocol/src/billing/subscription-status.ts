// ---------------------------------------------------------------------------
// Subscription status view-model (sidebar plan subtitle + account menu).
//
// Pure, browser-safe, unit-testable projection of the caller's billing
// entitlements (`source` / `plan` / `trial`) into the display view-model the
// desktop sidebar and account menu render. Plan names come from the resolved
// server entitlement (`plan.displayName`); trial lifecycle details are never
// substituted for the effective tier name.
// ---------------------------------------------------------------------------

import type { BillingPresentation, EntitlementSource } from './types';

/** Coarse subscription state the sidebar renders. */
export type SubscriptionStatusKind = 'trial' | 'paid' | 'org' | 'free';

/** Visual emphasis retained for non-sidebar consumers of this view-model. */
export type SubscriptionStatusTone =
  | 'neutral'
  | 'warning'
  | 'critical'
  | 'positive';

/** The billing fields this projection needs (subset of `Entitlements`). */
export interface SubscriptionStatusInput {
  source: EntitlementSource;
  plan: { key: string; displayName: string } | null;
  trial: { active: boolean; endsAt: string } | null;
  /**
   * Highest-priced plan the user should see, ranked across their own live
   * subscription and the orgs they manage (incl. trialing orgs). When present it
   * is shown verbatim in the positive tone, so an org owner on a pricier plan
   * sees that plan instead of a cheaper personal one. Optional / defaults to none
   * — older servers omit it, in which case the projection falls back to
   * `source`/`plan`.
   */
  displayPlan?: {
    key: string;
    displayName: string;
    source: EntitlementSource;
  } | null;
  billingPresentation?: BillingPresentation | null;
}

/** Display view-model consumed by the sidebar plan subtitle and account menu. */
export interface SubscriptionStatus {
  kind: SubscriptionStatusKind;
  /** Effective plan label from entitlements, e.g. `Free`, `Pro`, `Business`. */
  label: string;
  tone: SubscriptionStatusTone;
  trialEndsAt?: string | null;
  billingPresentation?: BillingPresentation | null;
}

function status(
  kind: SubscriptionStatusKind,
  label: string,
  tone: SubscriptionStatusTone,
  trialEndsAt: string | null = null,
  billingPresentation: BillingPresentation | null = null,
): SubscriptionStatus {
  return {
    kind,
    label,
    tone,
    ...(trialEndsAt !== null ? { trialEndsAt } : {}),
    ...(billingPresentation !== null ? { billingPresentation } : {}),
  };
}

/**
 * Project billing entitlements into the sidebar view-model at `nowMs`.
 *
 * Precedence follows the wire `source`. Trial remains a distinct internal kind
 * so actions can still offer an upgrade, but its visible label is the real plan
 * resolved by the server. An expired/stale trial projects to Free.
 */
export function computeSubscriptionStatus(
  input: SubscriptionStatusInput,
  nowMs: number,
): SubscriptionStatus {
  const { source, plan, trial, displayPlan } = input;
  const presentation = input.billingPresentation ?? null;

  if (presentation) {
    const endsMs = presentation.trialEndsAt
      ? Date.parse(presentation.trialEndsAt)
      : Number.NaN;
    const activeTrial =
      presentation.lifecycle === 'trial' &&
      presentation.trialEndsAt !== null &&
      !Number.isNaN(endsMs) &&
      nowMs < endsMs;
    if (presentation.lifecycle === 'trial' && !activeTrial) {
      return status('free', 'Free', 'neutral');
    }
    return status(
      activeTrial
        ? 'trial'
        : presentation.owner.type === 'organization'
          ? 'org'
          : 'paid',
      presentation.plan.displayName,
      activeTrial ? 'neutral' : 'positive',
      activeTrial ? presentation.trialEndsAt : null,
      presentation,
    );
  }

  // Highest-priced plan to display (resolved server-side across the user's own
  // subscription and the orgs they manage, incl. trialing orgs). Shown verbatim
  // in the positive tone so an org owner on a pricier plan sees that plan, not a
  // cheaper personal one. It always takes precedence over a trial/free state.
  // `org` vs `paid` kind only steers the menu CTA copy ("Manage plan" either
  // way); both are positive.
  if (displayPlan) {
    return status(
      displayPlan.source === 'org_seat' ? 'org' : 'paid',
      displayPlan.displayName,
      'positive',
    );
  }

  // Fallback for older servers that don't send `displayPlan`: project from the
  // wallet-primary `source`/`plan`.
  // Paid subscription wins over everything else.
  if (source === 'subscription') {
    return status('paid', plan?.displayName ?? 'Paid', 'positive');
  }

  // Org-seat coverage: billing is managed at the org level.
  if (source === 'org_seat') {
    return status('org', plan?.displayName ?? 'Team', 'neutral');
  }

  // An active trial displays the exact plan tier supplied by the entitlement
  // resolver (currently Business), never a generic lifecycle label or local
  // plan-key mapping. Keep the timestamp check only to avoid showing a stale
  // grant after a previously fetched trial expires client-side.
  if (source === 'trial' && plan) {
    if (!trial) {
      return status('trial', plan.displayName, 'neutral');
    }
    const endsMs = Date.parse(trial.endsAt);
    const expired =
      trial.active === false || Number.isNaN(endsMs) || nowMs >= endsMs;
    if (!expired) {
      return status('trial', plan.displayName, 'neutral', trial.endsAt);
    }
  }

  // No current grant, an expired trial, or an incomplete trial payload: Free.
  return status('free', 'Free', 'neutral');
}
