import { useEffect, useState, type JSX } from 'react';
import type {
  AgentProviderType,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import { lapsedOrgNames } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { orgsWithoutActivePlanSentence } from '@canopy/ui-shared/lib/org-lapse-sentence';
import { organizationBillingPath } from '@canopy/protocol/billing';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { useChatTargetAiCreditsScope } from '@/lib/aiCreditsScope';
import {
  announceCanopyCloudAccountChanged,
  refreshCanopyCloudAccountData,
} from '@/lib/canopyCloudAccountChange';
import { openSettingsPathOrWeb } from '@/lib/navigation/settings-destinations';
import type { ChatBannerTarget } from '@/stores/aiCreditsBannerStore';
import {
  CONTACT_ORG_ADMIN_LAPSED_COPY,
  resolveAiCreditsCoverage,
} from '@/lib/openBillingPage';

/**
 * "Your organization has no active plan" banner (CAN-2311).
 *
 * When an org's trial ends with no subscription it loses the `teams`
 * capability, and its credit pool stops funding its members immediately — no
 * grace period. Without this banner that lands as an unattributed failure: the
 * turn just stops being payable, and nothing on screen says which org changed
 * or who can change it back.
 *
 * Two restraints keep it from becoming noise:
 *
 *  1. PER-ORG, never global. It names the lapsed orgs specifically, and a user
 *     who belongs to a lapsed org AND a healthy one sees nothing — the healthy
 *     org still covers them, which is exactly the CAN-2311 guarantee.
 *  2. Only when it COSTS them. Visibility runs through the shared
 *     `resolveAiCreditsCoverage`, so a user with a spendable personal balance
 *     is not told about an org lapse that is not currently blocking anything.
 *
 * Restraint 2 also bounds the COPY, and that pairing is load-bearing. A lapse
 * pauses shared runs and org memory as well as the credit pool, but those stay
 * paused for the covered user who never sees this banner — so a banner gated on
 * credits cannot honestly claim them, and it names only the consequence its own
 * visibility rule proves. The other two refuse at their own point of use
 * instead, which is where a user actually meets them: a lapsed org is still
 * listed in the share picker and the lapse is reported when the share is
 * actually attempted (`getShareRunEligibility` deliberately probes with no
 * target org so the pre-audience check cannot become a global kill switch — the
 * refusal happens inside `shareRun`), and Remote Control shows its own on-hold
 * CTA. Changing either half means changing the other: broaden the copy back out
 * only by broadening the visibility rule to match.
 *
 * It offers no purchase CTA. Restoring a lapsed org is a subscription action
 * taken by an owner/admin on the organization's billing page, not a credits
 * top-up. The lapsed org's OWNER gets Open billing, which opens that page
 * (inside Settings when hosted settings are openable, otherwise on the web);
 * anyone else, including a read-only ADMIN, is told who can fix it.
 */
export interface OrgLapsedBannerProps {
  /** Provider the current model resolves to. Only `claude` / `codex` can bill. */
  provider: AgentProviderType;
  /**
   * Whether the user is signed in to the provider natively (a Claude Max /
   * ChatGPT subscription), from the same `useProviderAvailability` read
   * `NoBillingSourceBanner` consumes.
   *
   * Load-bearing for restraint 2 in the header ("Only when it COSTS them").
   * A natively-authed user's turns bill against their own subscription, not the
   * org credit pool, so the lapse costs them nothing — and this banner's copy
   * ("its credit pool is paused and is not paying for this chat") would be a
   * false claim, permanently, since `dismissedKey` is component state and
   * re-raises on every mount. `loadOrgAiCreditsSpendable` zeroes a lapsed org,
   * so the credit-coverage signals alone cannot distinguish this case.
   */
  nativeAuth?: boolean;
  /**
   * Whether the provider availability read is still inconclusive.
   *
   * `useProviderAvailability` deliberately reports `nativeAuth: false,
   * loading: true` when the auth probe FAILS, so callers do not read a failed
   * probe as a confirmed logout — and `NoBillingSourceBanner` honors that.
   * Without the same term here a transient probe failure re-raises exactly the
   * false claim `nativeAuth` was added to remove, because `probeFailed` is
   * deliberately not cached and so persists until the next probe.
   */
  availabilityLoading?: boolean;
  /**
   * Told whenever this banner starts or stops occupying the composer, so the
   * generic `NoBillingSourceBanner` can stand down while the specific
   * explanation is up (CAN-2311 review round 3).
   *
   * The two banners describe the SAME dead end whenever a member of a lapsed
   * org has no other way to pay: the lapse zeroes the org credit pool, which is
   * exactly the "nothing can pay for this turn" condition the other banner
   * watches. Stacked, they hand the user two different next actions ("Get AI
   * Credits" above "Contact your org admin to restore your team"). Neither is
   * wrong — a personal top-up really would unblock the turn — so the fix is
   * sequencing rather than suppression: the banner that names the CAUSE speaks
   * first, and the generic self-serve remedies return the moment this one is
   * dismissed or the org is restored. That keeps exactly one next action on
   * screen without ever leaving the composer silent.
   *
   * Scoped to `NoBillingSourceBanner` on purpose. `AiCreditsUsageLimitBanner`
   * deliberately still co-renders: it reports a PROVIDER rate limit, which is a
   * different fact with a different remedy, and its primary affordance is
   * Schedule Resume rather than a purchase CTA. Suppressing it behind an org
   * lapse would hide the reset time and the scheduling control for a condition
   * the org's billing has no bearing on. The overlap the sequencing exists to
   * fix — two banners describing the SAME dead end — does not apply there.
   */
  onVisibleChange?: (visible: boolean) => void;
  /**
   * The chat this banner belongs to (CAN-3463). Only the organization that
   * OWNS this work can pay for it, so only that org's lapse is named; a lapsed
   * org that does not own the chat costs this turn nothing. `null`/omitted
   * reads the navigation context.
   */
  target?: ChatBannerTarget | null;
}

/**
 * Identity of a lapse, used to scope a dismissal.
 *
 * Keyed on org IDs, not display names. Names are neither stable nor unique: a
 * rename would re-raise a banner the user already dismissed, and two orgs
 * sharing a display name would collide into one key, so dismissing one would
 * silently suppress the other. IDs are sorted so a reordered snapshot is the
 * same lapse, and serialized (rather than joined) so no separator can appear
 * inside a value.
 */
function lapseKey(organizationIds: readonly string[]): string {
  return JSON.stringify([...organizationIds].sort());
}

/**
 * Minimum gap between enforcement re-probes, and the timestamp of the last one.
 *
 * MODULE-level, not per component. `ChatInput` mounts concurrently in several
 * places (worktree chat, cowork, the queued-message editor), and a per-instance
 * guard let a single alt-tab fire one full probe chain PER mounted composer.
 * Each chain is a `GET /account` (which resolves org entitlements server-side),
 * an account-file write, `applyEnforcedSettings`, and an AI-credits fan-out
 * including one spendable-credits call per org — on the desktop's hot refresh
 * path.
 *
 * 60s is well under the 20-minute background interval this exists to shortcut,
 * so a user returning from a completed checkout still sees the restore promptly,
 * while ordinary window switching costs nothing.
 */
const REPROBE_MIN_INTERVAL_MS = 60_000;
let lastReprobeAt = 0;
let reprobeInFlight: Promise<void> | null = null;

/**
 * Re-probe at most once per {@link REPROBE_MIN_INTERVAL_MS}, shared across every
 * mounted banner. Returns immediately when a probe is already in flight or the
 * last one is still fresh, so callers can await it unconditionally.
 */
function reprobeEnforcementThrottled(): Promise<void> {
  if (reprobeInFlight) {
    return reprobeInFlight;
  }
  const now = Date.now();
  if (now - lastReprobeAt < REPROBE_MIN_INTERVAL_MS) {
    return Promise.resolve();
  }
  lastReprobeAt = now;
  reprobeInFlight = refreshCanopyCloudAccountData()
    .then((outcome) => {
      // A failed probe is not evidence of anything; fall through to the cached
      // snapshot rather than surfacing an error in the composer. A stored
      // account that changed meanwhile still is, and is announced.
      if (outcome.status === 'failed' && outcome.reason !== 'identity') return;
      // The account snapshot just changed on disk. Tell the rest of the app,
      // so the portal modal and sidebar stop rendering a lapse that has been
      // resolved (they listen for this and would otherwise stay stale until
      // their own next read). The reason lets account-scoped caches survive a
      // refresh of the same account (CAN-4061).
      announceCanopyCloudAccountChanged(outcome.reason);
    })
    .finally(() => {
      reprobeInFlight = null;
    });
  return reprobeInFlight;
}

export function OrgLapsedBanner({
  provider,
  nativeAuth,
  availabilityLoading,
  onVisibleChange,
  target = null,
}: OrgLapsedBannerProps): JSX.Element | null {
  const creditsScope = useChatTargetAiCreditsScope(target);
  const [names, setNames] = useState<string[]>([]);
  // The IDs behind `names`, carried alongside purely so a dismissal can be
  // keyed on identity rather than on copy. Never rendered.
  const [ids, setIds] = useState<string[]>([]);
  // The lapsed owner organization when the viewer is its OWNER, who can
  // choose a plan there; `null` for everyone else and while nothing has lapsed.
  const [billingOrganizationId, setBillingOrganizationId] = useState<
    string | null
  >(null);
  // Dismissal is scoped to the exact set of lapsed orgs it was taken against,
  // not to the component. Dismissing "Acme has no active plan" is the user
  // saying they have seen THAT lapse; it is not consent to be kept in the dark
  // when a different org lapses later in the same session, which a plain
  // boolean would silently suppress. Keying it also means the banner re-raises
  // only when the set of lapsed orgs actually changed, not on every refresh.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const billable = provider === 'claude' || provider === 'codex';

  useEffect(() => {
    if (!billable) {
      return;
    }
    let cancelled = false;
    // A new owner scope starts from silence: another chat's lapse must never
    // stand in while this chat's own read is in flight.
    setNames([]);
    setIds([]);
    setBillingOrganizationId(null);
    // Per-refresh sequence token. `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT` can fire
    // in quick succession (sign-in, org restored, refreshed account payload) and
    // each refresh issues two awaited reads, so a `cancelled` flag alone would
    // still let an earlier slow read land after a newer one and re-assert a
    // lapse the newer snapshot already cleared. Each refresh bumps `latest` and
    // its resolutions no-op once a newer refresh has started (last-issued wins).
    let latest = 0;

    // Re-probing (rather than re-reading the cached snapshot) is what stops a
    // just-restored org from staying locally blocked for up to the 20-minute
    // background interval. See `reprobeEnforcementThrottled`, which owns the
    // rate limit and the cross-component de-duplication.

    const refresh = (opts?: { reprobe?: boolean }): void => {
      const seq = ++latest;
      const stale = (): boolean => cancelled || seq !== latest;
      void (async (): Promise<void> => {
        try {
          if (opts?.reprobe) {
            await reprobeEnforcementThrottled();
            if (stale()) return;
          }
          // Two independent reads: the account snapshot says WHICH orgs lapsed,
          // the availability read says whether the user is covered anyway.
          const account = await window.api.loadCanopyCloudAccount();
          const allStates = account?.orgBillingStates ?? [];
          const clearLapse = (): void => {
            if (!stale()) {
              setNames([]);
              setIds([]);
              setBillingOrganizationId(null);
              // Clear the dismissal with the lapse it was taken against.
              // Without this, `lapseKey(ids)` for the SAME orgs is byte
              // identical, so a user who dismissed the banner, then had it
              // hide for another reason (topping up credits), would never see
              // it again when the lapse re-asserted — the key would scope the
              // dismissal to "those org ids, forever" rather than to that lapse.
              setDismissedKey(null);
            }
          };
          if (allStates.every((state) => state.teamsEntitled)) {
            clearLapse();
            return;
          }
          let availability: NativeAiCreditsAvailability | null = null;
          try {
            availability =
              await window.api.loadNativeAiCreditsAvailability(creditsScope);
          } catch {
            availability = null;
          }
          // `loadNativeAiCreditsAvailability` never throws: a disconnected
          // account or a transient cloud error degrades to an all-false payload
          // that is indistinguishable from "genuinely nothing can pay". Reading
          // that as coverage would make this banner assert the org lapse is
          // blocking the turn for a user who has a funded personal balance and
          // merely lost Wi-Fi. An inconclusive read is not evidence, so hold the
          // previous state rather than raising a claim we cannot support.
          if (availability?.inconclusive) {
            return;
          }
          // Only the owner org's lapse can cost this turn anything (CAN-3463):
          // AI Credits never spill onto another org's pool. Personal work has
          // no owner org, so no lapse applies.
          const ownerOrganizationId = availability?.ownerOrganization?.id;
          const states = ownerOrganizationId
            ? allStates.filter(
                (state) => state.organizationId === ownerOrganizationId,
              )
            : [];
          const lapsed = lapsedOrgNames(
            states,
            states.map((state) => state.organizationId),
          );
          const lapsedIds = states
            .filter((state) => !state.teamsEntitled)
            .map((state) => state.organizationId);
          if (lapsed.length === 0) {
            clearLapse();
            return;
          }
          const coverage = resolveAiCreditsCoverage(availability, lapsed);
          // The owner org's ID comes from the same space as the account's
          // memberships and the settings routes, so the viewer's role there
          // decides whether they can open its billing. Only an OWNER can
          // choose a plan; an ADMIN's billing view is read-only.
          const ownerRole = account?.organizations?.find(
            (organization) => organization.id === ownerOrganizationId,
          )?.role;
          const managesBilling = ownerRole === 'OWNER';
          if (!stale()) {
            setNames(coverage.lapsedOrgNames);
            // `resolveAiCreditsCoverage` either passes the lapse through or
            // clears it entirely (the user can still spend), so the IDs track
            // the names exactly.
            setIds(coverage.lapsedOrgNames.length > 0 ? lapsedIds : []);
            setBillingOrganizationId(
              coverage.lapsedOrgNames.length > 0 &&
                managesBilling &&
                ownerOrganizationId !== undefined
                ? ownerOrganizationId
                : null,
            );
          }
        } catch {
          // Fail quiet: an unreadable account is not evidence of a lapse, and a
          // banner asserting one would be worse than silence. Clearing here also
          // means a banner raised by an earlier read never outlives the snapshot
          // that produced it.
          if (!stale()) {
            setNames([]);
            setIds([]);
            setBillingOrganizationId(null);
          }
        }
      })();
    };

    // `ChatInput` is long-lived, so a mount-only read would never notice an org
    // that lapses — or is restored — mid-session.
    refresh();
    const onAccountChanged = (): void => refresh();
    // Returning to the app is the moment a just-completed web subscription
    // becomes observable, so it is the moment worth spending a probe on.
    const onReturn = (): void => {
      if (document.visibilityState === 'hidden') return;
      refresh({ reprobe: true });
    };
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return (): void => {
      cancelled = true;
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        onAccountChanged,
      );
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [billable, creditsScope]);

  const dismissed = names.length > 0 && dismissedKey === lapseKey(ids);
  // `!nativeAuth` is what makes the copy true. Without it a Claude Max user
  // with no personal credit balance who belongs to one lapsed org sees
  // "... is not paying for this chat" on every turn that is, in fact, being
  // paid for natively.
  const visible =
    billable &&
    !availabilityLoading &&
    !nativeAuth &&
    !dismissed &&
    names.length > 0;

  // The cleanup reports `false` as well, so an unmount (or a change of provider
  // that takes this whole subtree away) releases the composer instead of
  // leaving the generic banner suppressed by a component that is no longer
  // there. On a true→false→true transition both calls land in the same commit,
  // so the parent settles on one value rather than flickering.
  useEffect(() => {
    onVisibleChange?.(visible);
    return (): void => {
      onVisibleChange?.(false);
    };
  }, [visible, onVisibleChange]);

  if (!visible) {
    return null;
  }

  // Shared with the Remote Control upgrade CTA so the same fact is never
  // phrased two different ways in one session. The shared opener is the
  // title (minus its full stop); the consequence and the next step follow it
  // on the same line.
  const subject = orgsWithoutActivePlanSentence(names).replace(/\.$/, '');
  // `orgsWithoutActivePlanSentence` is already plural-capable ("Acme and
  // Initech have no active plan."), so the continuation has to agree with it —
  // otherwise two lapsed orgs render "... have no active plan. Its credit pool
  // is paused", which is the same singular/plural mismatch the ShareRunModal
  // copy just fixed. `names` can hold more than one org: it maps over every
  // lapsed state.
  //
  // The continuation carries ONLY the consequence, never the billing state
  // again (CAN-2590). It used to open "Its billing is on hold, so ...", which
  // spent a second consecutive sentence restating the fact the subject had just
  // established — in jargon, at that.
  const continuation =
    names.length > 1
      ? 'Their paused credit pools are not paying for this chat;'
      : 'Its paused credit pool is not paying for this chat;';

  return (
    <Notice
      intent="attention"
      title={subject}
      data-testid="chat-input-org-lapsed-banner"
      onDismiss={(): void => setDismissedKey(lapseKey(ids))}
      dismissLabel="Dismiss organization plan notice"
      dismissTestId="chat-input-org-lapsed-dismiss"
      actions={
        billingOrganizationId !== null ? (
          <NoticeButton
            variant="primary"
            data-testid="chat-input-org-lapsed-open-billing"
            onClick={(): void => {
              openSettingsPathOrWeb(
                organizationBillingPath(billingOrganizationId),
              );
            }}
          >
            Open billing
          </NoticeButton>
        ) : undefined
      }
    >
      {/* Cause-neutral on purpose. The desktop only receives `teamsEntitled`
          and `trialEndedAt` over the wire — never the subscription status —
          so it cannot tell a trial expiry from a declined card or a
          cancellation. Asserting "its trial ended" was therefore a guess, and
          a wrong one for every paying org that lapsed some other way. "No
          active plan" is true in all three cases, and the web billing page
          (which does know) names the specific cause and remedy. */}
      {`${continuation} `}
      {billingOrganizationId !== null ? (
        'open billing to restore your team.'
      ) : (
        <span data-testid="chat-input-org-lapsed-contact-admin">
          {CONTACT_ORG_ADMIN_LAPSED_COPY.charAt(0).toLowerCase() +
            CONTACT_ORG_ADMIN_LAPSED_COPY.slice(1)}
        </span>
      )}
    </Notice>
  );
}
