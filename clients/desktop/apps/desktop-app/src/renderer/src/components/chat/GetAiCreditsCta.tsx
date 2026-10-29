import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  AiCreditsScopeRequest,
  CanopyCloudAccountPublicState,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import { useStableAiCreditsScope } from '@/lib/aiCreditsScope';
import { lapsedOrgNames as lapsedOrgNamesFrom } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import { LoadingSpinner } from '@canopy/ui-shared';
import {
  announceAiCreditsChanged,
  getAiCreditsConnectContext,
  invalidateSharedAiCreditsRead,
  openBillingPage,
  readSharedAiCreditsAvailability,
  resolveAiCreditsCoverage,
} from '@/lib/openBillingPage';
import {
  isConnectedNonGuest,
  useCloudConnectGateStore,
} from '@/stores/cloudConnectGateStore';
import { ACCOUNT_BUTTON_PRIMARY } from '@/lib/account-button-styles';

/**
 * CAN-2349 §3 — the one "Get AI Credits" affordance.
 *
 * Cases A, B and C, plus the two existing banners, all end in the same place:
 * `requestConnect` → `openBillingPage` → either Billing opens inside Settings
 * (the CTA returns to idle) or the user leaves for the browser → they come
 * back → we reprobe and either commit or keep waiting. Implementing
 * that per branch is how coverage detection, throttling, cache invalidation and
 * `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT` get subtly wrong in four places at once,
 * so it lives here and takes only what actually varies.
 *
 * `onCovered` is the ONLY behavioral seam, which is why case C reuses this
 * verbatim: C flips `billing.onChange('ai-credits')` where A/B commit a model.
 */

/**
 * Shared post-purchase reprobe throttle (§5). Adopted in shape from
 * `OrgLapsedBanner`.
 *
 * MODULE-level, not per instance. Pickers mount concurrently (worktree chat,
 * cowork, the Home composer, a popped-out composer), and a per-instance
 * throttle would fire one full probe chain PER mounted picker on a single
 * alt-tab. Entries remain owner-scope keyed so one chat never throttles or
 * joins another owner's probe.
 */
const REPROBE_MIN_INTERVAL_MS = 60_000;
const MAX_REPROBE_SCOPES = 256;
const lastReprobeAtByScope = new Map<string, number>();
const reprobeInFlightByScope = new Map<
  string,
  Promise<NativeAiCreditsAvailability | null>
>();

/**
 * Read availability without ever throwing.
 *
 * The bridge itself can be absent (older builds, and test surfaces that render
 * this component without stubbing `window.api`), so the call can throw
 * SYNCHRONOUSLY as well as reject. Both mean the same thing here — "no read" —
 * and neither may escape into a render effect.
 */
function readAvailabilitySafely(
  options: {
    readonly fresh?: boolean;
    readonly scope?: AiCreditsScopeRequest | undefined;
  } = {},
): Promise<NativeAiCreditsAvailability | null> {
  // Shared, so a post-connect read this component makes cannot disagree with
  // the one `ModelRecoveryModal` makes on the same gate close. See
  // `readSharedAiCreditsAvailability`.
  return readSharedAiCreditsAvailability({
    ...(options.fresh === true ? { fresh: true } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  });
}

/**
 * Read native credits availability fresh from main.
 *
 * `force` bypasses the throttle and is what **Check again** passes: a user who
 * returns within 60s of an automatic probe and presses the button themselves
 * must not get a silent no-op. The automatic focus/visibilitychange path does
 * NOT force, so ordinary window switching costs nothing.
 */
async function probeCreditsAvailability(
  force: boolean,
  scope: AiCreditsScopeRequest | undefined,
  key: string,
): Promise<NativeAiCreditsAvailability | null> {
  // Only join a probe that asked about the SAME owner; another chat's answer
  // would name another organization's pool (CAN-3463).
  const existing = reprobeInFlightByScope.get(key);
  if (existing) return existing;
  const now = Date.now();
  const lastReprobeAt = lastReprobeAtByScope.get(key) ?? 0;
  if (!force && now - lastReprobeAt < REPROBE_MIN_INTERVAL_MS) {
    return null;
  }
  lastReprobeAtByScope.delete(key);
  lastReprobeAtByScope.set(key, now);
  if (lastReprobeAtByScope.size > MAX_REPROBE_SCOPES) {
    const oldest = lastReprobeAtByScope.keys().next().value;
    if (oldest !== undefined) lastReprobeAtByScope.delete(oldest);
  }
  // Through `readAvailabilitySafely` so a SYNCHRONOUS bridge throw (absent
  // `window.api` on an older build or an unstubbed test surface) is contained
  // here. `checkCoverage` wraps this in `try/finally`, not `try/catch`, so a
  // throw would otherwise escape both the focus listener's `void
  // checkCoverage(false)` and the Check-again click as an unhandled rejection.
  // FRESH, always. This is the post-purchase re-probe: its entire job is to
  // notice that the answer just changed, so serving it the episode's retained
  // answer would defeat it exactly when it matters — the user comes back from
  // checkout and we tell them what we already believed before they paid.
  const probe = readAvailabilitySafely({ fresh: true, scope }).finally(() => {
    if (reprobeInFlightByScope.get(key) === probe) {
      reprobeInFlightByScope.delete(key);
    }
  });
  reprobeInFlightByScope.set(key, probe);
  return probe;
}

export type GetAiCreditsCtaVariant = 'primary' | 'inline';

export interface GetAiCreditsCtaProps {
  /** e.g. "Get AI Credits" / "Add credits to use Claude Opus 4.5". */
  readonly label: string;
  /** Case-specific line rendered above the button. */
  readonly description?: string;
  /**
   * Coverage was detected. Commit the model (A/B) or flip the billing toggle
   * (C). The only behavioral difference between the three call sites.
   */
  /**
   * Return `false` to say the coverage was real but the host could NOT act on
   * it — `ModelRecoveryModal` returns it when the pending row went
   * provider-locked. The one-shot latch below is not armed in that case, so
   * the user can press this button again once the lock clears. Returning
   * `void` (the common case) means committed.
   */
  readonly onCovered: () => boolean | void | Promise<boolean | void>;
  /**
   * Optional compact-surface escape hatch (case C). A picker footer cannot
   * explain guest, contact-admin, lapsed, or inconclusive account state, so it
   * asks its parent to open the full recovery modal for those branches.
   */
  readonly onNeedsRecovery?: () => void;
  /** `'primary'` = modal button, `'inline'` = picker-footer button. */
  readonly variant?: GetAiCreditsCtaVariant;
  /** Preserve an established host surface's button treatment. */
  readonly buttonClassName?: string;
  /**
   * How the post-hand-off state is laid out.
   *
   * `'block'` (default) stacks the "finish this in your browser" line above
   * **Check again**, which is right for the modal and the picker footer — both
   * are vertical, full-width surfaces.
   *
   * `'compact'` is for the two banners, whose action bar is a horizontal,
   * right-aligned row of buttons: dropping a two-line block into it re-flows
   * the whole bar. There the explanation moves onto the button itself
   * (`title` + `aria-label`) so the hand-off state stays exactly one button
   * wide, like every other control in that row.
   */
  readonly handoffLayout?: 'block' | 'compact';
  /**
   * Host-supplied inert gate, ORed with this component's own `busy` state.
   *
   * `NoBillingSourceBanner` keeps the button RENDERED but disabled while its
   * own coverage read is in flight, so the action bar never changes width and
   * nothing that spends money is clickable on a decision made from a stale
   * read. That is the host's fact to know, not this component's.
   */
  readonly disabled?: boolean;
  /**
   * Hand off to billing when the post-connect coverage read is INCONCLUSIVE,
   * instead of stopping to report that it failed.
   *
   * Opt-in, and only correct for a host whose affordance exists *because* that
   * same read was already inconclusive — `NoBillingSourceBanner`'s fallback
   * CTA. There, explaining the failure is a guaranteed dead end: the read that
   * would have to succeed is the one that just failed, so the branch added to
   * guarantee the banner is never actionless becomes reliably actionless.
   *
   * Safe because the hand-off does not depend on the read: `openBillingPage`
   * only consults availability for its unauthenticated `pricingUrl` fallback,
   * and tries the in-app or signed-in billing page first regardless. This restores
   * the unconditional open the hand-rolled button had before the shared CTA
   * replaced it.
   *
   * Every other host keeps the default: they have an inconclusive branch of
   * their own to explain the outcome, and guessing on their behalf would push
   * a possibly-covered user at a purchase page.
   */
  readonly handoffOnInconclusiveRead?: boolean;
  /**
   * Owner of the work this CTA is for (CAN-3463). Every coverage read asks
   * about this owner's organization pool only; omitted = navigation context.
   */
  readonly aiCreditsScope?: AiCreditsScopeRequest;
  /**
   * Billing opened inside Settings (CAN-4691). Called once after an in-app
   * open, never after a browser hand-off or a failed open, so an overlay host
   * (dialog, popover) can close itself and let the user see Settings. Inline
   * banner hosts omit it.
   */
  readonly onOpenedInApp?: () => void;
  readonly dataTestId?: string;
}

/**
 * What a post-connect coverage re-read concluded.
 *
 * `'gone'` is deliberately distinct from `'uncovered'`: the read finished, but
 * the CTA that asked for it is no longer mounted, so the answer belongs to
 * nobody. Callers must not translate it into a purchase.
 */
type CoverageCommitOutcome = 'covered' | 'uncovered' | 'unknown' | 'gone';

/** Shown once the user has been sent to billing, in both layouts. */
const HANDOFF_COPY =
  "Finish adding credits in your browser — we'll pick this up as soon as they land.";

const INLINE_BUTTON_CLASS =
  'mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-2xs fg-primary transition hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60';

export function GetAiCreditsCta({
  label,
  description,
  onCovered,
  onNeedsRecovery,
  variant = 'primary',
  buttonClassName,
  handoffLayout = 'block',
  disabled = false,
  handoffOnInconclusiveRead = false,
  aiCreditsScope,
  onOpenedInApp,
  dataTestId = 'get-ai-credits-cta',
}: GetAiCreditsCtaProps): JSX.Element {
  const { scope: stableAiCreditsScope, key: aiCreditsScopeKey } =
    useStableAiCreditsScope(aiCreditsScope);
  // Read through a ref so the stable callbacks below always ask about the
  // CURRENT owner without re-subscribing their listeners.
  const scopeRef = useRef(stableAiCreditsScope);
  scopeRef.current = stableAiCreditsScope;
  const scopeKeyRef = useRef(aiCreditsScopeKey);
  const requestConnect = useCloudConnectGateStore((s) => s.requestConnect);
  const cloudGatePending = useCloudConnectGateStore((s) => s.pending);
  const [busy, setBusy] = useState(false);
  const [handedOff, setHandedOff] = useState(false);
  const [handoffFailed, setHandoffFailed] = useState(false);
  /**
   * The post-connect coverage read did not resolve.
   *
   * Distinct state from {@link handoffFailed}, because it is a distinct fact
   * with distinct copy: "we couldn't open the billing page" is wrong when the
   * truth is "we couldn't tell whether you need one". Without this, an
   * `'unknown'` outcome is a SILENT dead click in every host that has no
   * recovery modal to explain it — both banners mount this CTA without
   * `onNeedsRecovery`, and the picker footer reaches the same path whenever its
   * pre-gate read was conclusive. During an availability outage every click
   * would appear to do nothing at all.
   */
  const [readFailed, setReadFailed] = useState(false);
  const mountedRef = useRef(true);
  const availabilityRef = useRef<NativeAiCreditsAvailability | null>(null);
  /**
   * The in-flight seed read, so the hand-off can AWAIT it instead of racing it.
   * A user who clicks the moment this button appears would otherwise reach
   * `openBillingPage(null)`, whose unauthenticated fallback has no pricing URL
   * and therefore opens nothing at all.
   */
  const availabilityPromiseRef =
    useRef<Promise<NativeAiCreditsAvailability | null> | null>(null);
  // A prop/context change takes effect during render, before an effect can run:
  // a click in that frame must not consume the previous owner's settled value.
  if (scopeKeyRef.current !== aiCreditsScopeKey) {
    scopeKeyRef.current = aiCreditsScopeKey;
    availabilityRef.current = null;
    availabilityPromiseRef.current = null;
  }
  const awaitingCloudGateRef = useRef(false);
  const sawCloudGateRef = useRef(false);
  const handoffStartedRef = useRef(false);
  /**
   * `onCovered` fires AT MOST ONCE per hand-off.
   *
   * Returning from the browser commonly fires `focus` and `visibilitychange`
   * together. `probeCreditsAvailability` shares the in-flight read, but each
   * awaiting caller resumes with the same covered result and would invoke
   * `onCovered` independently — committing a model twice, flipping the billing
   * toggle twice, or running quota recovery twice. Reset when a new hand-off
   * begins so a later covered → uncovered → purchase cycle still commits.
   */
  const coveredRef = useRef(false);
  const checkInFlightRef = useRef(false);
  // Read through a ref so the focus/visibilitychange listeners below never have
  // to re-register just because the caller passed a new closure.
  const onCoveredRef = useRef(onCovered);
  onCoveredRef.current = onCovered;
  const onOpenedInAppRef = useRef(onOpenedInApp);
  onOpenedInAppRef.current = onOpenedInApp;
  // NOTE: availability lives ONLY in `availabilityRef`, and every path that
  // learns one writes it there directly.
  //
  // It used to be mirrored into state and re-synced back into the ref during
  // render. Nothing ever read that state — no rendered output depends on
  // availability — so its only effect was to undo the one write that matters:
  // `resolveAvailabilityForHandoff` deliberately clears the ref to `null` after
  // a failed read so the next hand-off re-reads instead of replaying the
  // failure, and a render-phase re-sync silently restored the stale value on
  // the very next render. A render-phase ref write is also unsafe under
  // StrictMode double-rendering. Do not reintroduce either half.

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  // Seed the pricing URL / org coverage that `openBillingPage` needs. Not
  // forced: the shared throttle already keeps this cheap across mounts. The
  // promise is retained so a click that lands before it settles can await it
  // rather than handing off with a `null` availability.
  useEffect(() => {
    const seedKey = aiCreditsScopeKey;
    availabilityRef.current = null;
    setBusy(false);
    setHandedOff(false);
    setHandoffFailed(false);
    setReadFailed(false);
    awaitingCloudGateRef.current = false;
    sawCloudGateRef.current = false;
    handoffStartedRef.current = false;
    coveredRef.current = false;
    checkInFlightRef.current = false;
    const seed = readAvailabilitySafely({ scope: stableAiCreditsScope });
    availabilityPromiseRef.current = seed;
    void seed.then((native) => {
      if (
        mountedRef.current &&
        scopeKeyRef.current === seedKey &&
        availabilityPromiseRef.current === seed
      ) {
        availabilityRef.current = native;
      }
    });
  }, [aiCreditsScopeKey, stableAiCreditsScope]);

  /**
   * The availability the hand-off should use, waiting on the seed read if it is
   * still in flight. A rejected/`null` read still resolves to `null` — the
   * caller decides what to do about it — but it is never skipped merely because
   * the user was fast.
   */
  const resolveAvailabilityForHandoff =
    useCallback(async (): Promise<NativeAiCreditsAvailability | null> => {
      const requestScopeKey = scopeKeyRef.current;
      if (availabilityRef.current !== null) {
        return availabilityRef.current;
      }
      const pending =
        availabilityPromiseRef.current ??
        readAvailabilitySafely({ scope: scopeRef.current });
      availabilityPromiseRef.current = pending;
      const native = await pending;
      if (scopeKeyRef.current !== requestScopeKey) return null;
      if (native === null) {
        // A settled-`null` promise must not be cached HERE, or a seed read that
        // failed once would be replayed for the life of this instance and
        // every later hand-off would keep losing the `pricingUrl` fallback —
        // the exact failure this helper exists to prevent.
        //
        // Note the scope: `readSharedAiCreditsAvailability` now retains its
        // answer for the surrounding episode, so clearing this instance ref
        // only un-caches within that episode. It is not a leak — every path
        // that reaches a hand-off opens a fresh episode first — but this ref is
        // no longer the outermost cache it was written to be.
        if (availabilityPromiseRef.current === pending) {
          availabilityPromiseRef.current = null;
        }
      }
      availabilityRef.current = native;
      return native;
    }, []);

  /**
   * Re-read coverage and commit if credits have appeared.
   *
   * Success is `canSpendCredits === true` and nothing else. A failed or
   * inconclusive read leaves the hand-off state up with **Check again** rather
   * than asserting "you still have no credits" — the read failing is not
   * evidence about the user's balance.
   */
  /**
   * Invoke `onCovered` at most once per hand-off.
   *
   * Announcing is deliberately NOT done here: a confirmed-covered read is
   * app-wide news (it invalidates the availability cache) and stays true even
   * when this instance has already committed, so callers announce
   * unconditionally and use this only to guard the one-shot commit.
   *
   * The latch arms only on a host that ACTED. A host returning `false` saw the
   * coverage but could not apply it (the pending row went provider-locked), and
   * arming on that would turn every later press of this button into a silent
   * no-op — the latch is only reset by `beginBillingHandoff`, which a
   * covered-account retry never reaches.
   */
  const commitCovered = useCallback(async (): Promise<void> => {
    if (coveredRef.current) return;
    // Provisional latch, taken BEFORE awaiting. The host's answer can now take
    // an IPC round trip, and `focus` + `visibilitychange` commonly fire
    // together on return from the browser — without holding the latch across
    // the await, both would pass the check and commit twice, which is the exact
    // double-commit this latch exists to prevent.
    coveredRef.current = true;
    try {
      if ((await onCoveredRef.current()) === false) {
        // Refused: the host saw the coverage but could not apply it. Release
        // the latch so the user can press again once the block clears.
        coveredRef.current = false;
      }
    } catch {
      // A throw is not a commit. Releasing matters more here than anywhere
      // else: nothing resets this latch except `beginBillingHandoff`, which a
      // covered-account retry never reaches, so keeping it armed would make
      // every later confirmed-covered read a silent no-op for the life of the
      // hand-off.
      coveredRef.current = false;
    }
  }, []);

  /**
   * Commit if a fresh read shows coverage; report whether it did.
   *
   * Used after a successful cloud connect: a guest who signs in receives free
   * starting credits, and the guest copy promises exactly that. Handing them
   * off to a BILLING page at that point contradicts the offer and parks them
   * on "Check again" until they happen to alt-tab back.
   *
   * FOUR outcomes, not two. Only ONE of them may open a billing page, so each
   * non-answer has to stay distinguishable from a real "no credits":
   *
   * - `'gone'` — this CTA unmounted while the read was in flight. Collapsing it
   *   into `'uncovered'` is what let a cancelled or superseded recovery still
   *   open a billing page: the caller read "no credits" from what was really
   *   "nobody is asking any more".
   * - `'unknown'` — the read failed or came back `inconclusive`. Asserting a
   *   balance from a read that did not resolve is the same error this PR fixed
   *   in `resolveAiCreditsCoverage` and in the modal's inconclusive branch, and
   *   it is visible to the user: the modal renders "we couldn't check your
   *   account" from the SAME read that would have sent them to a purchase page.
   * - `'uncovered'` — a settled read that genuinely shows no credits. The only
   *   outcome that justifies a hand-off.
   */
  const commitIfAlreadyCovered =
    useCallback(async (): Promise<CoverageCommitOutcome> => {
      const requestScopeKey = scopeKeyRef.current;
      const native = await readAvailabilitySafely({
        scope: scopeRef.current,
      });
      if (!mountedRef.current || scopeKeyRef.current !== requestScopeKey) {
        return 'gone';
      }
      if (native !== null) {
        availabilityRef.current = native;
      }
      if (native === null || native.inconclusive === true) {
        return 'unknown';
      }
      if (!resolveAiCreditsCoverage(native).canSpendCredits) {
        return 'uncovered';
      }
      setBusy(false);
      announceAiCreditsChanged();
      void commitCovered();
      return 'covered';
    }, [commitCovered]);

  const checkCoverage = useCallback(
    async (force: boolean): Promise<void> => {
      if (!mountedRef.current) return;
      // Per-instance guard, not just the shared probe: `focus` and
      // `visibilitychange` both fire on return, and two callers awaiting the
      // SAME shared probe would each fall through to `commitCovered` below.
      if (checkInFlightRef.current) return;
      checkInFlightRef.current = true;
      setBusy(true);
      const requestScopeKey = scopeKeyRef.current;
      try {
        const native = await probeCreditsAvailability(
          force,
          scopeRef.current,
          requestScopeKey,
        );
        if (!mountedRef.current || scopeKeyRef.current !== requestScopeKey) {
          return;
        }
        if (native === null) {
          // Throttled or failed — keep whatever we already knew.
          return;
        }
        availabilityRef.current = native;
        if (resolveAiCreditsCoverage(native).canSpendCredits) {
          setHandedOff(false);
          // The hand-off is over, so the one-shot latch must open again or a
          // later purchase from this same instance would spin forever.
          handoffStartedRef.current = false;
          // Announce every confirmed-covered read, even if this instance has
          // already committed: hosts (the usage-limit banner) re-derive their
          // affordances from it, and skipping it leaves them stale.
          announceAiCreditsChanged();
          void commitCovered();
        }
      } finally {
        if (scopeKeyRef.current === requestScopeKey) {
          checkInFlightRef.current = false;
        }
        if (mountedRef.current && scopeKeyRef.current === requestScopeKey) {
          setBusy(false);
        }
      }
    },
    [commitCovered],
  );

  // §5 post-purchase return. Registered ONLY while handed off to billing, so an
  // ordinary alt-tab away from the picker costs nothing.
  useEffect(() => {
    if (!handedOff) {
      return;
    }
    const onReturn = (): void => {
      // Returning to the app is the moment a just-completed checkout becomes
      // observable, so it is the moment worth spending a probe on.
      if (document.visibilityState === 'hidden') return;
      void checkCoverage(false);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return (): void => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [handedOff, checkCoverage]);

  /**
   * Route the purchase through the shared cloud connect gate rather than
   * opening billing directly. A guest credential is "technically connected" (it
   * has a device key) but cannot buy credits, so a bare billing open would dead
   * end them. `requestConnect` short-circuits when a real account is already
   * connected, so a signed-in user goes straight to billing in one click.
   */
  const beginBillingHandoff = useCallback((): void => {
    // Cleared BEFORE the already-started guard, not after. Reaching this
    // function at all means this CTA is no longer waiting on a gate, so an
    // early return that skips the reset leaves the flag armed — and a stale
    // `true` lets the NEXT unrelated cloud gate to close (Remote Control, an
    // upgrade nudge) drive this CTA's `proceedAfterConnect` and open a billing
    // page nobody asked for.
    awaitingCloudGateRef.current = false;
    if (handoffStartedRef.current) return;
    handoffStartedRef.current = true;
    // A fresh hand-off is a fresh chance to commit.
    coveredRef.current = false;
    setHandoffFailed(false);
    void (async (): Promise<void> => {
      const requestScopeKey = scopeKeyRef.current;
      // Wait for a conclusive read first: `openBillingPage`'s unauthenticated
      // fallback needs `pricingUrl`, and without it a rejected authenticated
      // hand-off opens NOTHING.
      const native = await resolveAvailabilityForHandoff();
      // Check BEFORE opening, not after. `openBillingPage` has a visible side
      // effect — a browser tab or the Settings overlay — so a post-open bail
      // still leaves the user looking at a page they can no longer connect to
      // anything they did.
      if (!mountedRef.current || scopeKeyRef.current !== requestScopeKey) {
        return;
      }
      const result = await openBillingPage(native, scopeRef.current);
      if (!mountedRef.current || scopeKeyRef.current !== requestScopeKey) {
        return;
      }
      setBusy(false);
      if (result === 'web') {
        setHandedOff(true);
        return;
      }
      // Not a browser hand-off: release the one-shot latch so the button works
      // again.
      handoffStartedRef.current = false;
      if (result === 'settings') {
        // The user is looking at Settings → Billing inside the app, so there
        // is no browser return to wait for. This CTA stops tracking the
        // purchase; `openBillingPage` re-reads AI Credits for every mounted
        // surface once Settings closes. Call the host last: it may unmount us.
        onOpenedInAppRef.current?.();
        return;
      }
      // Nothing opened. Say so and keep the button live rather than parking the
      // user on "finish this in your browser" for a page that never appeared.
      setHandoffFailed(true);
    })();
  }, [resolveAvailabilityForHandoff]);

  /**
   * What to do once an account is connected.
   *
   * Coverage is re-read FIRST. Signing in is itself a way to acquire credits —
   * a new account starts with free ones, which is exactly what the guest copy
   * promises — so handing a now-covered user off to a BILLING page would
   * contradict the offer they just accepted and park them on "Check again"
   * until they happened to alt-tab back.
   */
  const proceedAfterConnect = useCallback((): void => {
    void (async (): Promise<void> => {
      const outcome = await commitIfAlreadyCovered();
      if (outcome === 'covered') {
        awaitingCloudGateRef.current = false;
        return;
      }
      if (outcome === 'gone') {
        // The affordance that asked for this is no longer on screen — the user
        // cancelled, or another path committed and tore it down. Opening an
        // external billing page for a request nobody is waiting on is the one
        // outcome worse than doing nothing: it is unattributable to any action
        // the user can still see.
        awaitingCloudGateRef.current = false;
        return;
      }
      if (outcome === 'unknown') {
        // We do not know whether they have credits, so we must not act as if we
        // know they do not — but we must not go silent either. Only the
        // recovery modal has an inconclusive branch to explain this; the two
        // banners and the picker footer have none, so without saying something
        // here an explicit purchase click just stops.
        //
        // ...unless the host's affordance EXISTS because this read was already
        // inconclusive, in which case reporting the failure is the dead end and
        // the hand-off is the useful answer. See `handoffOnInconclusiveRead`.
        if (handoffOnInconclusiveRead) {
          beginBillingHandoff();
          return;
        }
        awaitingCloudGateRef.current = false;
        if (mountedRef.current) {
          setBusy(false);
          setReadFailed(true);
        }
        return;
      }
      beginBillingHandoff();
    })();
  }, [beginBillingHandoff, commitIfAlreadyCovered, handoffOnInconclusiveRead]);

  const requestBillingHandoff = useCallback((): void => {
    awaitingCloudGateRef.current = true;
    sawCloudGateRef.current = false;
    // Open a fresh availability episode for this attempt.
    //
    // The gate close does this too, but an already-signed-in user never sees a
    // gate: `requestConnect` short-circuits and runs `proceedAfterConnect`
    // straight away. Without this, that path would decide whether to charge
    // someone from an answer retained since this button mounted. There is no
    // second reader on the short-circuit path (the modal's gate-close effect
    // requires a gate that actually opened), so nothing loses its shared answer
    // by starting a new episode here.
    invalidateSharedAiCreditsRead();
    requestConnect(getAiCreditsConnectContext(), proceedAfterConnect);
  }, [proceedAfterConnect, requestConnect]);

  // When the shared cloud modal closes, it performs its own account re-check
  // before invoking `proceed`. Mirror that read so a cancelled gate can clear
  // this button's busy state, while a successful sign-in keeps the spinner in
  // the originating affordance until the guarded billing hand-off runs.
  useEffect(() => {
    if (!awaitingCloudGateRef.current) return;
    if (cloudGatePending) {
      sawCloudGateRef.current = true;
      return;
    }
    if (!sawCloudGateRef.current) return;
    void window.api
      .loadCanopyCloudAccount()
      .then((account) => {
        if (!mountedRef.current || !awaitingCloudGateRef.current) return;
        if (isConnectedNonGuest(account)) {
          // Coverage first: a just-created account may already have the free
          // starting credits the guest copy promised.
          proceedAfterConnect();
          return;
        }
        awaitingCloudGateRef.current = false;
        setBusy(false);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        awaitingCloudGateRef.current = false;
        setBusy(false);
      });
  }, [cloudGatePending, proceedAfterConnect]);

  const handleGetCredits = useCallback((): void => {
    setBusy(true);
    // A new attempt supersedes EVERY previous verdict, not just the newest
    // one. Clearing only `readFailed` let the two warning lines stack: a first
    // attempt that opened nothing leaves `handoffFailed` up, and a second that
    // cannot read coverage adds `readFailed` beneath it — two `role="status"`
    // regions giving one click two different explanations.
    setHandoffFailed(false);
    setReadFailed(false);
    if (!onNeedsRecovery) {
      requestBillingHandoff();
      return;
    }

    // Case C lives in the picker footer, where account-state explanations do
    // not fit. Read the real state before deciding whether this can remain a
    // one-click billing hand-off or must escalate into ModelRecoveryModal.
    void (async (): Promise<void> => {
      const requestScopeKey = scopeKeyRef.current;
      let native: NativeAiCreditsAvailability | null = null;
      let account: CanopyCloudAccountPublicState | null | undefined;
      try {
        // Read through the SHARED helper, not the bridge directly. A raw read
        // is neither retained for the episode (so a shared reader a microtask
        // later could legitimately return a different answer about the same
        // account — the disagreement `openBillingPage.ts` states can never
        // happen) nor epoch-stamped, so it could not be retracted if credits
        // drained mid-flight. `commitCovered()` below flips the chat's billing
        // framework on this answer, so it must be retractable. `fresh: true`
        // matches the intent — this click is asking the question now — and
        // opens the episode `requestBillingHandoff` would otherwise open a
        // moment later.
        [native, account] = await Promise.all([
          readAvailabilitySafely({ fresh: true, scope: scopeRef.current }),
          window.api.loadCanopyCloudAccount(),
        ]);
      } catch {
        native = null;
        account = null;
      }
      if (!mountedRef.current || scopeKeyRef.current !== requestScopeKey) {
        return;
      }
      availabilityRef.current = native;

      const orgBillingStates = account?.orgBillingStates ?? [];
      const ownerOrganizationId = native?.ownerOrganization?.id;
      const lapsed = lapsedOrgNamesFrom(
        orgBillingStates,
        ownerOrganizationId ? [ownerOrganizationId] : [],
      );
      const coverage = resolveAiCreditsCoverage(native, lapsed);
      if (coverage.canSpendCredits) {
        setBusy(false);
        announceAiCreditsChanged();
        void commitCovered();
        return;
      }
      if (
        native === null ||
        native.inconclusive === true ||
        !isConnectedNonGuest(account) ||
        coverage.showContactAdmin ||
        coverage.lapsedOrgNames.length > 0
      ) {
        setBusy(false);
        onNeedsRecovery();
        return;
      }
      requestBillingHandoff();
    })();
  }, [commitCovered, onNeedsRecovery, requestBillingHandoff]);

  const buttonClass =
    buttonClassName ??
    (variant === 'inline'
      ? INLINE_BUTTON_CLASS
      : `w-full ${ACCOUNT_BUTTON_PRIMARY} flex items-center justify-center gap-1.5`);

  if (handedOff) {
    const checkAgain = (
      <button
        type="button"
        data-testid={`${dataTestId}-check-again`}
        // Honors the host's inert gate as well as our own busy state, exactly
        // like the primary button below. A host that knows its own read is in
        // flight means it for every control in this CTA, not just the one it
        // happened to be looking at when it passed the prop.
        disabled={busy || disabled}
        onMouseDown={(e): void => e.preventDefault()}
        // Forced: bypasses the §5 throttle so a user returning inside the
        // 60s window gets a real read instead of a silent no-op.
        onClick={(): void => void checkCoverage(true)}
        className={buttonClass}
        {...(handoffLayout === 'compact'
          ? {
              title: HANDOFF_COPY,
              'aria-label': `Check again — ${HANDOFF_COPY}`,
            }
          : {})}
      >
        {busy && (
          <LoadingSpinner dataTestId={`${dataTestId}-spinner`} decorative />
        )}
        Check again
      </button>
    );

    // Compact: one button, no stacked paragraph, so a banner's horizontal
    // action bar keeps its shape. The copy survives on the button itself.
    if (handoffLayout === 'compact') {
      return (
        <span
          className="inline-flex shrink-0 items-center"
          data-testid={`${dataTestId}-handoff`}
        >
          {checkAgain}
        </span>
      );
    }

    return (
      <div
        className="flex flex-col gap-1.5"
        data-testid={`${dataTestId}-handoff`}
      >
        <p className="text-2xs leading-snug fg-secondary">{HANDOFF_COPY}</p>
        {checkAgain}
      </div>
    );
  }

  const containerClass =
    handoffLayout === 'compact'
      ? 'inline-flex shrink-0 flex-col items-stretch gap-1.5'
      : 'flex flex-col gap-1.5';

  return (
    <div className={containerClass}>
      {description ? (
        <p className="text-2xs leading-snug fg-secondary">{description}</p>
      ) : null}
      <button
        type="button"
        data-testid={dataTestId}
        disabled={busy || disabled}
        aria-busy={busy || disabled}
        onMouseDown={(e): void => e.preventDefault()}
        onClick={handleGetCredits}
        className={buttonClass}
      >
        {busy && (
          <LoadingSpinner dataTestId={`${dataTestId}-spinner`} decorative />
        )}
        {label}
      </button>
      {/* Nothing opened (no authenticated hand-off AND no pricing URL). Saying
          so beats parking the user on a "finish this in your browser" state for
          a page that never appeared. */}
      {handoffFailed ? (
        <p
          role="status"
          data-testid={`${dataTestId}-handoff-failed`}
          className="text-2xs leading-snug fg-warning"
        >
          We couldn&apos;t open your billing page. Check your connection and try
          again.
        </p>
      ) : null}
      {/* The post-connect read never resolved, so we genuinely do not know
          whether this user needs to buy anything. Say that, rather than
          silently doing nothing or asserting a balance we did not read. */}
      {readFailed ? (
        <p
          role="status"
          data-testid={`${dataTestId}-read-failed`}
          className="text-2xs leading-snug fg-warning"
        >
          We couldn&apos;t check your account. Check your connection and try
          again.
        </p>
      ) : null}
    </div>
  );
}
