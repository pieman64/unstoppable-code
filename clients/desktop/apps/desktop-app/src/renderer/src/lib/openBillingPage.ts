import { useCallback } from 'react';
import type {
  AiCreditsScopeRequest,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  buildBillingTopUpIntentPath,
  isBillingIntentIdentifier,
  resolveCreditsBillingTarget,
} from '@canopy/protocol/billing';
import { MODEL_LIBRARY_UNLOCK_COPY } from '@canopy/ui-shared/components';
import { hostedSettingsOpenable } from '@/components/settings/hosted/hosted-settings-availability';
import { invalidateAiCreditsAvailabilityCache } from '@/hooks/useAiCreditsAvailability';
import { brandText } from '@/lib/brand';
import { announceCanopyCloudAccountChanged } from '@/lib/canopyCloudAccountChange';
import {
  aiCreditsScopeKey,
  readNavigationScopeKey,
} from '@/lib/aiCreditsScope';
import {
  useCloudConnectGateStore,
  type CloudConnectGateContext,
} from '@/stores/cloudConnectGateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { resolveCreditsBillingPath } from '@/lib/contextBillingTarget';
import { refreshWorkModelLibraryAccess } from '@/lib/modelLibraryAccess';
import {
  openSettingsPathOrWebReported,
  type SettingsOpenResult,
} from '@/lib/navigation/settings-destinations';
import {
  beginModelUnlockIntent,
  type ModelUnlockIntentHandlers,
} from '@/lib/modelUnlockIntent';

/**
 * Shared AI-Credits purchase affordances (ECW-9091).
 *
 * Extracted from `AiCreditsUsageLimitBanner` so every banner that offers a
 * credits CTA — the usage-limit banner and the no-billing-source banner — makes
 * the same org-coverage decision and hands off to the same billing page. Two
 * copies of this logic would silently drift and start showing a purchase CTA to
 * org members who cannot buy.
 */

/**
 * Copy for an org member whose org carries the credit-pool capability but has no
 * spendable headroom right now. They cannot buy credits themselves, so every
 * banner shows this instead of a purchase CTA.
 */
export const CONTACT_ORG_ADMIN_COPY =
  'Contact your org admin to increase your spend quota.';

/**
 * Copy for a member of an org that has LOST the `teams` capability (CAN-2311).
 *
 * Deliberately distinct from {@link CONTACT_ORG_ADMIN_COPY}: that one describes
 * a live org that is merely out of headroom, and telling a member of a lapsed
 * org to ask for "more spend quota" would send them to their admin with the
 * wrong request. The org is not over budget, it has no active plan.
 */
export const CONTACT_ORG_ADMIN_LAPSED_COPY =
  'Contact your org admin to restore your team.';

export interface AiCreditsCoverage {
  /**
   * The account can pay for a gateway-routed turn right now: a spendable
   * personal balance (native OR already-linked UD) or an org with headroom.
   */
  canSpendCredits: boolean;
  /** Show the static "contact your org admin" copy and NO purchase CTA. */
  showContactAdmin: boolean;
  /** Fully uncovered — show the purchase CTA. */
  showPurchase: boolean;
  /**
   * At least one of the user's orgs has lapsed AND that is costing them
   * something right now (they cannot otherwise pay for a turn). Drives the
   * lapsed-org banner; empty when nothing is lapsed or the user is covered
   * anyway, so a healthy org silences it entirely.
   */
  lapsedOrgNames: string[];
}

/**
 * Tell the rest of the app that a fresh read confirmed usable credits, so the
 * billing toggle, banners, and subscription status converge in the same tick.
 *
 * A credits change, never an identity change: every caller follows an
 * availability read, and sign-in or sign-out announce themselves.
 */
export function announceAiCreditsChanged(): void {
  invalidateAiCreditsAvailabilityCache();
  announceCanopyCloudAccountChanged('same-account-refresh');
}

/**
 * The single in-flight availability read, shared by everyone who asks at once.
 *
 * Closing the cloud gate wakes several independent readers on the same event —
 * `ModelRecoveryModal`'s gate-close `refreshAccountRead`, `GetAiCreditsCta`'s
 * post-connect coverage check, and the gate's own re-check. Each used to issue
 * its own IPC read, and two reads of the same account CAN disagree: the credits
 * fan-out is network-backed, and a transient org-credit failure degrades to
 * "uncovered" rather than to an error. That let the modal conclude *covered*
 * and commit while the CTA concluded *uncovered* and opened a billing page for
 * the credits the user had just been granted.
 *
 * ONE ANSWER PER EPISODE is the guarantee. Sharing only the *in-flight* promise
 * would make agreement a timing coincidence: the modal reads availability before
 * account state, while the CTA's post-connect read waits behind a
 * `loadCanopyCloudAccount()` hop, so a fast first read settles during that hop
 * and the second reader issues its own — reopening the disagreement whenever the
 * two answers differ. So the SETTLED RESULT is retained for the episode too, not
 * just the pending promise.
 *
 * Be precise about what that does and does not promise. Readers within one
 * episode always agree. An episode can also END between two readers — on an
 * account change, a gate close, or credit exhaustion from another chat — and
 * then the second reader correctly gets a *different, newer* answer rather than
 * a shared stale one. That is the intended behavior, not a hole: the two are
 * answering questions about different account states. What can never happen is
 * two readers disagreeing about the *same* state, or an answer surviving the
 * state it described.
 *
 * AN EPISODE IS AN ACCOUNT EPOCH, which is what keeps retention safe rather
 * than merely cheap. "In flight" alone is the wrong key: this read fans out per
 * org over the network under a multi-second budget, and `GetAiCreditsCta` seeds
 * one the moment it mounts — so a read STARTED as a guest can still be joined
 * AFTER the user signs in. A guest's pre-sign-in answer is a plain uncovered
 * result carrying no `inconclusive` marker, so joining it post-connect
 * reintroduces the exact bug this helper was added to prevent, only now with
 * both readers confidently agreeing on the previous account. The inverse is
 * just as bad: a stale *covered* answer committing a recovery under an account
 * that no longer holds the credits.
 *
 * Every read is therefore stamped with the epoch it began in, and the epoch is
 * bumped by anything that can change the answer: a cloud-account change, the
 * connect gate closing, and every caller that explicitly asks for a fresh read.
 * A reader from an older epoch never inherits an answer about somebody else.
 *
 * RETENTION IS BOUNDED THREE WAYS, because a retained answer about money is
 * only safe while it is still true:
 *
 * 1. Every decision point that needs current truth — **Try again**, **Check
 *    again**, the post-purchase focus probe, the start of each purchase
 *    attempt, and the recovery modal's opening read — passes `{ fresh: true }`,
 *    which opens a new episode. Without that, retention would silently defeat
 *    the post-purchase re-probe, whose entire job is to notice that the answer
 *    just changed.
 * 2. Anything that changes the answer ends the episode: a cloud-account change,
 *    the connect gate closing, and credit exhaustion mid-session.
 * 3. {@link SHARED_READ_MAX_AGE_MS} is the backstop for everything nobody
 *    thought of. It mirrors `useAiCreditsAvailability`'s TTL for the same
 *    stated reason — a stale value must not be able to outlive the session
 *    because some future flow forgot to invalidate. Two review rounds of this
 *    change were spent on exactly that class of miss, so the episode is capped
 *    rather than trusted.
 */
const SHARED_READ_MAX_AGE_MS = 60_000;

type SharedAvailabilityEntry = {
  readonly epoch: number;
  /** `null` while the read is still in flight; stamped when it settles. */
  settledAt: number | null;
  readonly value: Promise<NativeAiCreditsAvailability | null>;
};
/**
 * Episodes are per owner scope (CAN-3463): two chats owned by different orgs
 * are different questions, and joining one's answer from the other would name
 * the wrong pool. The navigation context is part of every key.
 */
const sharedAvailability = new Map<string, SharedAvailabilityEntry>();
let currentAccountEpoch = 0;

/**
 * Open a new availability episode: drop the retained answer and start counting
 * from a fresh epoch, because whatever it described may no longer be true.
 *
 * Exported so tests can reset this module-level state, and called on every
 * `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT` — including the one
 * {@link announceAiCreditsChanged} dispatches — on cloud-gate close, and on any
 * `{ fresh: true }` read.
 */
export function invalidateSharedAiCreditsRead(): void {
  currentAccountEpoch += 1;
  sharedAvailability.clear();
}

// Bump on ANY account change, not just the ones routed through
// `announceAiCreditsChanged` — sign-in and sign-out reach this event by other
// paths, and those are precisely the transitions that make an in-flight read
// describe the wrong user. Guarded for non-DOM (test/node) import contexts.
if (
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function'
) {
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, (): void => {
    invalidateSharedAiCreditsRead();
  });
}

/**
 * Read native AI-credits availability, returning the CURRENT EPISODE's answer
 * — pending or already settled — rather than issuing a second read.
 *
 * Pass `{ fresh: true }` when the caller's whole purpose is to notice a change
 * (**Try again**, **Check again**, the post-purchase focus probe, the start of
 * a purchase attempt). That opens a new episode, so it both gets current truth
 * and gives everyone who reads alongside it the same answer.
 *
 * Never throws or rejects: the bridge itself can be absent (older builds, test
 * surfaces that render without stubbing `window.api`), so a SYNCHRONOUS throw
 * is contained here alongside a rejection. Both mean the same thing — "no
 * read" — which callers must treat as *unknown*, never as "no credits".
 */
export function readSharedAiCreditsAvailability(
  options: {
    readonly fresh?: boolean;
    /** Owner of the work being asked about; omitted = navigation context. */
    readonly scope?: AiCreditsScopeRequest;
  } = {},
): Promise<NativeAiCreditsAvailability | null> {
  const key = aiCreditsScopeKey(options.scope, readNavigationScopeKey());
  const retained = sharedAvailability.get(key);
  if (options.fresh === true) {
    invalidateSharedAiCreditsRead();
  } else if (
    retained?.epoch === currentAccountEpoch &&
    // Age out only a SETTLED answer. While a read is still in flight it is
    // always joinable, because in-flight coalescing is the stronger property
    // and the one this helper was originally added for: aging out a pending
    // read would start a parallel duplicate whose answer could differ from the
    // one another surface is already awaiting. Only a retained *result* can go
    // stale, and only a retained result is capped.
    (retained.settledAt === null ||
      Date.now() - retained.settledAt < SHARED_READ_MAX_AGE_MS)
  ) {
    return retained.value;
  }
  let started: Promise<NativeAiCreditsAvailability | null>;
  try {
    started = window.api
      .loadNativeAiCreditsAvailability(options.scope)
      .catch((): NativeAiCreditsAvailability | null => null);
  } catch {
    return Promise.resolve(null);
  }
  const epochAtStart = currentAccountEpoch;
  const entry: SharedAvailabilityEntry = {
    epoch: epochAtStart,
    settledAt: null,
    // Retained after it settles, so a reader arriving one IPC hop later gets
    // this same answer instead of asking again and possibly getting a
    // different one. The episode — not the promise's lifetime — is the scope.
    //
    // The epoch is re-checked AT RESOLUTION, not only at join time, because
    // dropping the handle cannot reach a caller that is already awaiting this
    // promise. Credits can be exhausted by another chat while a recovery read
    // is in flight: without this, that read would resolve `covered` afterwards
    // and its existing awaiters would commit a model whose credits are gone.
    // A superseded answer degrades to `null`, which every caller already
    // handles as *unknown* — the modal shows its inconclusive branch, the CTA
    // shows "we couldn't check your account", and neither commits nor
    // purchases. Failing to an honest non-answer is the only safe way to
    // retract an answer someone is already waiting on.
    value: started.then((value) =>
      epochAtStart === currentAccountEpoch ? value : null,
    ),
  };
  void started.finally((): void => {
    if (sharedAvailability.get(key) === entry) {
      entry.settledAt = Date.now();
    }
  });
  sharedAvailability.set(key, entry);
  return entry.value;
}

/**
 * Resolve which credits affordance (if any) a banner should offer.
 *
 * A `null` or inconclusive availability means the read has not resolved or
 * failed, so nothing is offered — asserting "you have no credits" on a failed
 * read would push a paying user at the purchase page.
 *
 * `lapsedOrgNames` is the names of the user's orgs that have lost the `teams`
 * capability (CAN-2311). It only ever REPLACES the generic contact-admin state:
 * a user who can still spend (personal balance, or a second healthy org) sees
 * nothing about the lapse, because per CAN-2311 the gate is per-org and a
 * healthy org must keep working untouched.
 */
export function resolveAiCreditsCoverage(
  availability: NativeAiCreditsAvailability | null,
  lapsedOrgNames: readonly string[] = [],
): AiCreditsCoverage {
  if (!availability || availability.inconclusive === true) {
    return {
      canSpendCredits: false,
      showContactAdmin: false,
      showPurchase: false,
      lapsedOrgNames: [],
    };
  }
  const canSpendCredits =
    availability.personalEligible === true ||
    availability.orgSpendable === true;
  // Only surface the lapse when it actually costs them a turn right now.
  const lapsed = canSpendCredits ? [] : [...lapsedOrgNames];
  // A lapsed org reports no credit-pool coverage (the main process zeroes it at
  // `loadOrgAiCreditsSpendable`), so `orgCreditPoolCovered` is already false and
  // the quota message cannot arise for a lapsed-only member. Suppressing
  // explicitly anyway keeps the two admin messages from ever stacking if that
  // upstream signal changes.
  //
  // The SAME zeroing flips `showPurchase` on, though, so a purchase CTA and a
  // lapse are very much reachable together (a member of one lapsed org with no
  // personal balance). That is deliberate and correct here — a personal top-up
  // really would unblock their turn — but it means two banners would otherwise
  // offer two different next actions. The composer sequences them instead:
  // `OrgLapsedBanner` reports its visibility to `ChatInput`, which stands
  // `NoBillingSourceBanner` down while the lapse is being explained and brings
  // it back the moment that banner is dismissed or the org is restored.
  // The `lapsed.length === 0` term is LOAD-BEARING, not dead weight. It is
  // true that today's production callers pass no names, so the term is
  // currently always true in the app — but this is an exported pure helper with
  // its own asserted contract ("ask for more spend quota" is the wrong request
  // for an org with no active plan, see its test), and removing the term silently changes
  // that contract for the first caller that does pass names. Keeping it makes
  // the helper correct independently of which arguments callers happen to use.
  const showContactAdmin =
    !canSpendCredits &&
    lapsed.length === 0 &&
    availability.inOrg === true &&
    availability.orgCreditPoolCovered === true;
  return {
    canSpendCredits,
    showContactAdmin,
    showPurchase: !canSpendCredits && !showContactAdmin,
    lapsedOrgNames: lapsed,
  };
}

/**
 * The page credits are bought on for the selected navigation context: the
 * organization's billing for its OWNER (the only role that can fund its pool),
 * the personal account billing page for everyone else (CAN-3463).
 */
function creditsBillingPath(
  availability: NativeAiCreditsAvailability | null,
  scope?: AiCreditsScopeRequest,
): string {
  try {
    const { context, organizations } =
      useWorkspaceContextStore.getState().state;
    if (availability?.ownerOrganization) {
      return resolveCreditsBillingPath(
        {
          kind: 'organization',
          organizationId: availability.ownerOrganization.id,
        },
        organizations,
      );
    }
    // A work-scoped read with no organization owner is Personal (or could not
    // establish an owner). Never substitute an unrelated live org selection.
    if (scope?.kind === 'work') return '/account/billing';
    return resolveCreditsBillingPath(context, organizations);
  } catch {
    return '/account/billing';
  }
}

/**
 * The plain, unauthenticated pricing page: the last resort when the signed-in
 * hand-off opened nothing. Resolves to whether a browser page opened.
 */
async function openUnauthenticatedPricingPage(
  availability: NativeAiCreditsAvailability | null,
): Promise<boolean> {
  const url = availability?.pricingUrl;
  if (!url) return false;
  try {
    await window.api.browser.openExternal({ url });
    return true;
  } catch {
    // Best-effort external open.
    return false;
  }
}

/**
 * Where a Get AI Credits billing open went. `'settings'`: Billing opened
 * inside Settings and the user has NOT left the app. `'web'`: a browser page
 * opened (signed-in billing, or the unauthenticated pricing fallback).
 * `'failed'`: nothing opened.
 */
export type BillingPageOpenResult = SettingsOpenResult | 'failed';

let stopSettingsCloseReread: (() => void) | null = null;

/**
 * Re-read AI Credits once Settings closes after an in-app Billing open
 * (CAN-4691). A top-up from there still finishes in the browser, and the
 * surfaces behind Settings stay mounted holding a conclusive answer that
 * nothing re-reads on a timer (the availability TTL applies only when a
 * consumer re-runs its read). Announced through the same
 * `announceAiCreditsChanged` the browser-return probe uses, so usage, account
 * and model-library surfaces refresh too. Unlike that probe it announces on
 * close whether or not anything was bought: there is no prior read to compare
 * against, and one extra refresh per in-app open is cheap. One-shot: a later
 * Settings visit does not re-read again, so a purchase that lands after the
 * close shows up only on a later availability read.
 */
function rereadAiCreditsWhenSettingsCloses(): void {
  stopSettingsCloseReread?.();
  const unsubscribe = useNavigationStore.subscribe((state, previous) => {
    if (!previous.settingsOpen || state.settingsOpen) return;
    unsubscribe();
    stopSettingsCloseReread = null;
    announceAiCreditsChanged();
  });
  stopSettingsCloseReread = unsubscribe;
}

/** Test-only: drops a pending Settings-close re-read between Jest cases. */
export function resetSettingsCloseRereadForTests(): void {
  stopSettingsCloseReread?.();
  stopSettingsCloseReread = null;
}

/**
 * Open the credits billing page (CAN-4691): inside Settings when hosted
 * settings are openable in this window (never a Remote Control window, never
 * with the rollout flag off), otherwise the web page already signed in, and
 * only when that hand-off opened nothing the plain pricing page.
 *
 * The answer is load-bearing for callers that render a "finish this in your
 * browser" state. `'settings'` means there is no browser to return from, so
 * they must not render one. `'failed'` happens when the signed-in hand-off
 * opens nothing AND `availability` carries no `pricingUrl` (a `null` read, or
 * one that never resolved); a caller that assumed a page opened would strand
 * the user waiting on one that does not exist, so it keeps the button and
 * says so instead.
 */
export async function openBillingPage(
  availability: NativeAiCreditsAvailability | null,
  scope?: AiCreditsScopeRequest,
): Promise<BillingPageOpenResult> {
  const result = await openSettingsPathOrWebReported(
    creditsBillingPath(availability, scope),
  );
  if (result === 'settings') rereadAiCreditsWhenSettingsCloses();
  if (result !== 'failed') return result;
  return (await openUnauthenticatedPricingPage(availability))
    ? 'web'
    : 'failed';
}

/**
 * The connect-gate context for every Get AI Credits click (CAN-4691). The
 * gate shows the toast as it closes, before the billing page opens, so it
 * names where that page will open. Call it at click time: whether hosted
 * settings are openable can change between render and click.
 */
export function getAiCreditsConnectContext(): CloudConnectGateContext {
  return {
    title: 'Get AI Credits',
    subtitle: `Connect your ${brandText.appName} account to add AI Credits.`,
    toastMessage: hostedSettingsOpenable()
      ? "You're connected. Opening Billing in Settings so you can add AI Credits."
      : "You're connected. Opening your billing page so you can add AI Credits.",
  };
}

/**
 * The one "Get AI Credits" click handler, shared by every surface that offers
 * the purchase action (CAN-2413): the composer's `NoBillingSourceBanner` and
 * the in-transcript `CanopyProxyErrorNotice`.
 *
 * The gate hand-off is the part that must not be duplicated. Opening billing
 * directly dead-ends a guest credential — it has a device key, so it reads as
 * "connected", but it cannot buy credits: hosted Settings → Billing needs the
 * signed-in account, and `openBillingPage`'s web fallback mints a magic link
 * that has no non-guest credential to exchange. Routing through
 * `requestConnect` opens the shared sign-in modal first and auto-resumes the
 * hand-off once a real account exists. A second copy of that rationale in
 * another component is how one of the two surfaces silently loses it.
 *
 * `availability` only feeds the unauthenticated pricing-URL fallback, so
 * callers without a native availability read (the transcript notice) can pass
 * nothing and still get the in-app or signed-in billing page.
 */
export function useGetAiCreditsAction(
  scope?: AiCreditsScopeRequest,
): (availability?: NativeAiCreditsAvailability | null) => void {
  const requestConnect = useCloudConnectGateStore((s) => s.requestConnect);
  return useCallback(
    (availability: NativeAiCreditsAvailability | null = null): void => {
      requestConnect(getAiCreditsConnectContext(), async () => {
        const scopedAvailability =
          availability ??
          (scope ? await readSharedAiCreditsAvailability({ scope }) : null);
        return openBillingPage(scopedAvailability, scope);
      });
    },
    [requestConnect, scope],
  );
}

/** Billing-owner key for an availability read: `personal` or `org:<id>`. */
function billingOwnerKey(
  availability: NativeAiCreditsAvailability | null,
): string | null {
  if (!availability || availability.inconclusive === true) return null;
  return availability.ownerOrganization
    ? `org:${availability.ownerOrganization.id.toLowerCase()}`
    : 'personal';
}

/**
 * The billing owner of `scope` right now, or null when the read could not
 * establish one. Uses the shared episode read, so it agrees with every other
 * surface asking about the same work.
 */
export async function readBillingOwnerKey(
  scope?: AiCreditsScopeRequest,
): Promise<string | null> {
  return billingOwnerKey(
    await readSharedAiCreditsAvailability(scope ? { scope } : {}),
  );
}

/**
 * Can this user fund the organization that owns the work? Only its OWNER can,
 * the same rule `resolveCreditsBillingTarget` applies to the credits hand-off.
 */
function canFundOrganization(organizationId: string): boolean {
  try {
    const { organizations } = useWorkspaceContextStore.getState().state;
    return (
      resolveCreditsBillingTarget(
        { kind: 'organization', organizationId },
        organizations,
      ).kind === 'organization'
    );
  } catch {
    return false;
  }
}

export interface UnlockModelsRequest {
  /**
   * Forwarded to checkout for attribution. Always `desktop`, whichever surface
   * started the recovery: it is also how checkout knows to offer the link back
   * to this app once the unlock is confirmed.
   */
  readonly source: 'desktop';
  /** The model the user asked for, when there is one to apply afterwards. */
  readonly modelId?: string;
  /** The chat it was asked for in. */
  readonly chatId?: string;
  /** Applies {@link modelId} once the unlock is confirmed. */
  readonly apply?: ModelUnlockIntentHandlers['apply'];
  readonly isStillWanted?: ModelUnlockIntentHandlers['isStillWanted'];
}

/**
 * What happened when the user asked to unlock.
 *
 * - `opened`: checkout is open in the browser. `requestId` is present when the
 *   desktop is following the purchase and will confirm it on its own.
 * - `sign-in`: a guest was sent to the shared sign-in gate first. Checkout
 *   opens after it, and only if the account still needs a purchase.
 * - `unlocked`: a fresh read says this account is already unlocked, so no
 *   checkout was opened.
 * - `contact-admin`: the work belongs to an organization this user cannot
 *   fund. Show {@link CONTACT_ORG_ADMIN_COPY}.
 * - `failed`: no browser page opened.
 */
export type UnlockModelsResult =
  | { readonly outcome: 'opened'; readonly requestId?: string }
  | { readonly outcome: 'sign-in' }
  | { readonly outcome: 'unlocked' }
  | { readonly outcome: 'contact-admin' }
  | { readonly outcome: 'failed' };

async function openUnlockCheckout(
  scope: AiCreditsScopeRequest | undefined,
  request: UnlockModelsRequest,
): Promise<UnlockModelsResult> {
  // Fresh: the owner decides which billing page opens and whose purchase this
  // is, and a retained answer could name a pool the work no longer belongs to.
  const availability = await readSharedAiCreditsAvailability({
    fresh: true,
    ...(scope ? { scope } : {}),
  });
  if (!availability || availability.inconclusive === true)
    return { outcome: 'failed' };
  const ownerOrganization = availability.ownerOrganization;
  // An organization's access comes from ITS purchases or seat coverage. A
  // member's personal purchase cannot unlock the organization's work, so a
  // member who cannot fund the owner is told who can instead of being sold
  // something that would not help.
  if (ownerOrganization && !canFundOrganization(ownerOrganization.id)) {
    return { outcome: 'contact-admin' };
  }
  const read = await refreshWorkModelLibraryAccess(scope);
  const owner = billingOwnerKey(availability);
  if (
    read?.ownerKey === owner &&
    read?.authoritative === true &&
    read.access === 'unlocked'
  ) {
    // Signing in joined an account that already qualifies, or the purchase
    // landed since the lock was drawn. Checkout would sell it twice.
    return { outcome: 'unlocked' };
  }
  const requestId = crypto.randomUUID();
  let path: string;
  try {
    path = buildBillingTopUpIntentPath(
      creditsBillingPath(availability, scope),
      {
        reason: 'unlock_models',
        source: request.source,
        // Ids that do not fit the link's shape are left out rather than
        // failing the purchase: they only pre-fill attribution, and the
        // pending intent below keeps the real values.
        ...(isBillingIntentIdentifier(request.modelId)
          ? { modelId: request.modelId }
          : {}),
        ...(isBillingIntentIdentifier(request.chatId)
          ? { chatId: request.chatId }
          : {}),
        requestId,
      },
    );
  } catch {
    return { outcome: 'failed' };
  }
  let opened = false;
  try {
    // The browser, always. Card entry never happens inside the desktop app,
    // and there is no unauthenticated fallback: a pricing page is not a
    // checkout, and "finish in your browser" must be true when it is shown.
    opened = await window.api.openAuthenticatedPortalPage(path);
  } catch {
    opened = false;
  }
  if (!opened) return { outcome: 'failed' };
  // Follow only the account and owner validated by the scoped server read.
  if (
    read === null ||
    read.ownerKey !== owner ||
    read.accountKey === null ||
    read.accountKey === undefined
  ) {
    return { outcome: 'opened' };
  }
  beginModelUnlockIntent(
    {
      requestId,
      accountId: read.accountKey,
      owner,
      chatId: request.chatId ?? null,
      modelId: request.modelId ?? null,
      startedAt: Date.now(),
      source: request.source,
    },
    {
      ...(request.apply ? { apply: request.apply } : {}),
      ...(request.isStillWanted
        ? { isStillWanted: request.isStillWanted }
        : {}),
      resolveOwner: () => readBillingOwnerKey(scope),
      refreshAccess: () => refreshWorkModelLibraryAccess(scope),
    },
  );
  return { outcome: 'opened', requestId };
}

/**
 * The one "unlock advanced models" action (CAN-4028), beside
 * {@link useGetAiCreditsAction} and deliberately separate from it.
 *
 * That action's coverage check answers "can this account pay for a turn?",
 * and reports success whenever any spendable credit exists. Library access is
 * a different fact: the daily free credits are spendable and do not unlock
 * anything, so routing a locked model through the credits flow would tell a
 * non-payer their problem was solved.
 *
 * Opens the owner's billing page in the browser with the top-up already
 * open, and remembers the attempt so the desktop can confirm it. A guest goes
 * through the shared sign-in gate first, for the same reason
 * `useGetAiCreditsAction` does: a guest credential cannot buy anything.
 */
export async function unlockModels(
  scope: AiCreditsScopeRequest | undefined,
  request: UnlockModelsRequest,
): Promise<UnlockModelsResult> {
  let guest = false;
  try {
    guest = isGuestAccount(await window.api.loadCanopyCloudAccount());
  } catch {
    // Unreadable account: let the checkout attempt decide. It fails closed on
    // its own when no authenticated page can be opened.
    guest = false;
  }
  if (!guest) return openUnlockCheckout(scope, request);
  useCloudConnectGateStore.getState().requestConnect(
    {
      title: MODEL_LIBRARY_UNLOCK_COPY.title,
      subtitle: MODEL_LIBRARY_UNLOCK_COPY.guestBody,
    },
    (): void => {
      // Runs only after a real account exists. `openUnlockCheckout` re-reads
      // access first, so an account that already qualifies is never sent to
      // checkout.
      void openUnlockCheckout(scope, request);
    },
  );
  return { outcome: 'sign-in' };
}

/** {@link unlockModels} bound to one owner scope, for components. */
export function useUnlockModelsAction(
  scope?: AiCreditsScopeRequest,
): (request: UnlockModelsRequest) => Promise<UnlockModelsResult> {
  return useCallback(
    (request: UnlockModelsRequest): Promise<UnlockModelsResult> =>
      unlockModels(scope, request),
    [scope],
  );
}
