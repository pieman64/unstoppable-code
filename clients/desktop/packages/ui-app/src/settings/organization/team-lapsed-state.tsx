'use client';

import type { JSX } from 'react';
import { EmptyState, buttonClassName } from '@canopy/ui-shared/components';
import { organizationBillingPath } from '@canopy/protocol/billing';
import type { OrgTeamsLapseReason } from '@canopy/protocol/settings';
import { formatPlanDateUtc } from '@canopy/protocol/settings/plan-display';
import { SettingsLink } from '../host';

/**
 * The lapsed-org panel (CAN-2311).
 *
 * An org whose trial ended with no subscription loses the `teams` capability,
 * and the server rejects its org mutations from that moment on — no grace
 * period. This is what the blocked tabs render INSTEAD of their content.
 *
 * Deliberately not a `notFound()`: a lapsed org is a real org the viewer really
 * belongs to, and 404-ing it would strand an owner one click away from the
 * billing page that fixes it. It is also not a bespoke panel — it is the shared
 * `EmptyState` the AI-credits empty state already uses, so a blocked tab reads
 * as an ordinary empty surface with a way forward rather than as an error.
 *
 * The CTA branches on whether the viewer can edit the org, because the two
 * audiences have different next actions: an owner/admin can pay, a member can
 * only ask someone who can. This CTA is the only trail to billing, and it
 * renders for `canEdit` alone — a member never gets one, and the Billing
 * settings subtab is hidden from them, since subscribing is not theirs to do.
 * A payment CTA would promise them an action they do not have.
 */
export interface TeamLapsedStateProps {
  /** Org externalId, for the billing link. */
  orgId: string;
  /** Org name — the copy names the org explicitly, since a viewer may belong to
   * several and only one of them is on hold. */
  orgName: string;
  /** When the trial ended. `null` falls back to date-free copy. Only rendered
   * when `lapseReason` is `trial_ended` — for any other cause the trial date is
   * a true fact about a window that is not why the org is on hold. */
  trialEndedAt: string | null;
  /** Why the org lost `teams`. See `OrgTeamsAccess.lapseReason`. */
  lapseReason: OrgTeamsLapseReason | null;
  /** Cheapest plan that restores `teams`. `null` falls back to plan-free copy. */
  requiredPlanName: string | null;
  /** Whether the viewer is an OWNER/ADMIN, i.e. someone who can subscribe. */
  canEdit: boolean;
}

/**
 * The one sentence that states WHY the org is on hold.
 *
 * Branches on the cause rather than on `trialEndedAt` being non-null. The old
 * unconditional "Your trial ended on {date}" printed a date from a trial that,
 * for a past-due or cancelled org, ended long before the subscription started —
 * above a CTA telling them to buy a plan they already own.
 */
function lapseSentence(
  lapseReason: TeamLapsedStateProps['lapseReason'],
  trialEndedAt: string | null,
): string {
  switch (lapseReason) {
    case 'payment_failed':
      return 'Your last payment failed.';
    case 'subscription_ended':
      return 'Your subscription has ended.';
    case 'trial_ended':
      return trialEndedAt
        ? `Your trial ended on ${formatPlanDateUtc(trialEndedAt)}.`
        : 'Your trial has ended.';
    default:
      return 'Your plan no longer includes team features.';
  }
}

export function TeamLapsedState({
  orgId,
  orgName,
  trialEndedAt,
  lapseReason,
  requiredPlanName,
  canEdit,
}: TeamLapsedStateProps): JSX.Element {
  // `requiredPlanName` is null only if no seeded plan grants `teams`, in which
  // case naming a plan would print "null" — fall back to plan-free copy.
  //
  // A past-due org is told to fix the card, not to subscribe: it already has a
  // subscription, and "Subscribe to Business" is both wrong and unactionable
  // for someone whose plan is already Business.
  const restoreSentence =
    lapseReason === 'payment_failed'
      ? 'Update your payment method to restore your team.'
      : requiredPlanName
        ? `Subscribe to ${requiredPlanName} to restore your team.`
        : 'Subscribe to restore your team.';

  const askAdminSentence =
    lapseReason === 'payment_failed'
      ? 'Ask an organization administrator to update the payment method to restore your team.'
      : 'Ask an organization administrator to subscribe to restore your team.';

  const cause = lapseSentence(lapseReason, trialEndedAt);
  const subtitle = canEdit
    ? `${cause} ${restoreSentence}`
    : `${cause} ${askAdminSentence}`;

  return (
    <div data-testid="team-lapsed-state">
      <EmptyState
        title={`${orgName} is on hold`}
        subtitle={subtitle}
        action={
          canEdit ? (
            <SettingsLink
              href={organizationBillingPath(orgId)}
              data-testid="team-lapsed-billing-cta"
              className={buttonClassName({
                variant: 'secondary',
                size: 'compact',
              })}
            >
              Go to billing
            </SettingsLink>
          ) : undefined
        }
      />
    </div>
  );
}
