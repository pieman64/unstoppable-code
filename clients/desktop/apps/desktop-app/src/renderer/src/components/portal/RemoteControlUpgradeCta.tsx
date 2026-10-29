import type { JSX } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { orgsWithoutActivePlanClause } from '@canopy/ui-shared/lib/org-lapse-sentence';
import { MODAL_BUTTON_PRIMARY } from '@/components/portal/portal-button-styles';

interface RemoteControlUpgradeCtaProps {
  /**
   * Opens this branch's billing destination in the external browser: the lapsed
   * org's billing page on the owner/admin branch (carrying a plan intent only
   * when {@link planDisplayName} names that org's own plan), the account's own
   * upgrade path otherwise. The modal owns the destination because it owns the
   * same signals this component branches its copy on.
   */
  onUpgrade: () => void;
  /**
   * Names of the user's orgs that have LOST the `teams` capability (CAN-2311).
   * When one of them was the org covering Remote Control, the generic
   * "included with Pro and Business" line describes a plan the user never chose
   * and never lost — it reads as an upsell rather than as context for why
   * something that worked yesterday stopped. Empty (the default) keeps the
   * original copy exactly as it was.
   *
   * NOTE: naming the org is the ONLY claim this makes. Nothing available in the
   * renderer says whether the lapsed org was ever the source of THIS user's
   * Remote Control coverage — the account snapshot carries only current
   * capabilities plus per-org `teamsEntitled`, with no history and no per-org
   * plan detail. A user on a personal free plan, or in a healthy org whose plan
   * never granted `remote_control`, can belong to a lapsed org and have lost
   * nothing at all, so the copy must not assert that Remote Control was paused
   * by this lapse or offer to "restore" it.
   */
  lapsedOrgNames?: readonly string[];
  /**
   * The lapsed org this user can manage billing for, or null for a plain member
   * (CAN-2590). Resolved by `resolveManageableLapsedOrg` in the modal, since
   * {@link lapsedOrgNames} carries names only and cannot be matched against an
   * org id here. Null — including the wire default when the server says nothing
   * about admin rights — takes the member branch.
   */
  manageableLapsedOrg?: { id: string; name: string } | null;
  /**
   * Display name of the plan the owner/admin is being sent to buy, from
   * `billingPresentation.plan.displayName` — but only when that presentation's
   * `owner` IS {@link manageableLapsedOrg}. The modal enforces that pairing; do
   * not pass the raw presentation plan here. It is a wallet-wide winner ranked
   * across the caller's own subscription and every org they administer, so
   * naming it beside a different org's id states a requirement the linked
   * billing page cannot sell (CAN-2590).
   *
   * Null is a real, common state — an unmatched owner, or a server old enough to
   * omit `billingPresentation` entirely. The copy then drops the plan name and
   * the button falls back to the generic action rather than rendering
   * `Get undefined`. Unused on the member branch, which names no plan at all.
   */
  planDisplayName?: string | null;
  /** Extra classes applied to the CTA container. */
  className?: string;
}

/**
 * Upgrade CTA shown inside the Remote Control modal when a signed-in user on a
 * plan that does not include Remote Control opens it (billing on, account lacks
 * the `portal-v1` capability). Remote Control is a Pro/Business perk, so this
 * points the user at the shortest path to unlock it. Presentational — the
 * gate, the handler, and the branch inputs come from the modal (via
 * `useSubscriptionStatus`).
 *
 * When one of the user's orgs has no active plan (CAN-2311), the copy adds that
 * fact by name so an org member is not left guessing why the app is offering
 * them an upgrade. One sentence, three beats in the order the reader needs
 * them: what unlocks the feature, why the org is not that route, what to do.
 * The org status is a subordinate clause rather than the opener (CAN-2590).
 *
 * Who the reader is decides the action, so the lapsed state has two branches:
 *
 * - **Owner/admin** of a lapsed org ({@link manageableLapsedOrg}) gets a button
 *   into that org's billing page. When a plan can be named for THAT org (see
 *   {@link planDisplayName}) the copy ends on "Upgrade to unlock." and the
 *   button reads `Get <plan>`, so the panel does not state the same action
 *   twice. When it cannot — the common case, since a lapsed org is usually not
 *   the presentation's owner — the sentence stops after the org clause and the
 *   button keeps the generic label. Naming a plan the linked page cannot sell
 *   would be a bigger mis-statement than naming none.
 * - **Everyone else** ends on "Ask an organization owner to renew, or upgrade
 *   your own plan." and keeps the generic button. This branch is not only plain
 *   members: it also takes any reader the modal can PROVE cannot buy for the
 *   named org (a non-owner ADMIN, whose `billingPresentation.action` is `view`),
 *   because the org billing page would sell them nothing.
 *
 * That second branch NAMES BOTH ROUTES on purpose, and an earlier revision of
 * this component was wrong to drop the button. The reasoning then was "a member
 * cannot renew the org's plan, so do not hand them a button they cannot press."
 * Two things make that premise false:
 *
 *  1. **This branch is not only members.** {@link manageableLapsedOrg} is null
 *     whenever no single lapsed org can be named without guessing (CAN-3465):
 *     an OWNER of two lapsed orgs who has neither selected lands here, as does
 *     an owner whose memberships have not loaded while the server's
 *     `billingManageableOrg` is null because they manage several orgs. Without
 *     the button they would be told to go ask themselves.
 *  2. **The button was never the org's renewal button.** It is the reader's own
 *     upgrade path, and a personal plan really does unlock Remote Control. As
 *     `lapsedOrgNames` explains at length, the app cannot tell whether this
 *     lapse took anything from this reader at all — so "ask an admin" may be
 *     advice that unlocks nothing while their own upgrade would work today.
 *
 * Removing a working route on the strength of a signal that cannot support the
 * inference is the same class of error CAN-2590 exists to fix, so the copy names
 * the org remedy and the button offers the personal one.
 *
 * No branch claims this lapse is what took Remote Control away, and none offers
 * to "restore" it (see `lapsedOrgNames` for why). "Ask an organization owner to
 * renew" is an instruction about the org's own lapsed plan, not an assertion
 * that renewing gives this user back something they lost.
 */
export function RemoteControlUpgradeCta({
  onUpgrade,
  lapsedOrgNames = [],
  manageableLapsedOrg = null,
  planDisplayName = null,
  className = '',
}: RemoteControlUpgradeCtaProps): JSX.Element {
  const lapsed = lapsedOrgNames.length > 0;
  // The plan name is only ever spoken on the owner/admin branch: it names the
  // org tier they are being sent to buy, which is not a tier a member could
  // purchase for themselves.
  const namedPlan = manageableLapsedOrg ? planDisplayName : null;
  const requirement = namedPlan
    ? `This feature requires ${namedPlan},`
    : 'This feature requires a paid plan,';
  const action = manageableLapsedOrg
    ? namedPlan
      ? // The button says `Get <plan>`, so the copy may name the action.
        ' Upgrade to unlock.'
      : // No plan name means no `Get <plan>` label to move the action onto, so
        // the button carries the action verbatim ("Upgrade to unlock") and the
        // sentence stops rather than saying it a second time. This is the
        // PRODUCTION path for an owner/admin, not a rare fallback — see the
        // reachability note in `CanopyPortalModal` — so it is deliberately not
        // a dead end: the reader still gets one clear action, on the button,
        // pointed at their own org's billing page. The branch below is longer
        // only because that reader has a SECOND route (asking someone else)
        // that no button can express.
        ''
    : // Names BOTH routes, because both are real and the app cannot tell which
      // one applies to this reader. See the header for why the button stayed.
      //
      // "owner", not "admin": every billing CTA on the org billing page is
      // OWNER-gated, and this branch now deliberately includes a non-owner ADMIN
      // whose `billingPresentation.action` is `view` (see `CanopyPortalModal`).
      // Telling an admin to "ask an admin" would point them at themselves.
      ' Ask an organization owner to renew, or upgrade your own plan.';
  const lapsedMessage = `${requirement} and ${orgsWithoutActivePlanClause(lapsedOrgNames)} to cover it.${action}`;
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border bg-secondary/40 p-3 sm:flex-row sm:items-center sm:justify-between ${className}`}
      data-testid="canopy-portal-upgrade-cta"
    >
      {lapsed ? (
        <p
          className="text-s fg-secondary"
          data-testid="canopy-portal-upgrade-cta-lapsed-copy"
        >
          {lapsedMessage}
        </p>
      ) : (
        <p className="text-s fg-secondary">
          {REMOTE_CONTROL_LABEL} is included with the Pro and Business plans.
        </p>
      )}
      <button
        type="button"
        onClick={onUpgrade}
        data-testid="canopy-portal-upgrade-cta-button"
        className={`shrink-0 ${MODAL_BUTTON_PRIMARY}`}
      >
        {namedPlan ? `Get ${namedPlan}` : 'Upgrade to unlock'}
      </button>
    </div>
  );
}
