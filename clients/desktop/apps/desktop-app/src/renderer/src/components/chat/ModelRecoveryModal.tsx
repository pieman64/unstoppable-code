import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  AiCreditsScopeRequest,
  CanopyCloudAccountPublicState,
  ChatModel,
  NativeAiCreditsAvailability,
  AgentProviderAuthStatus,
} from '@canopy/desktop-shared/types';
import {
  getExecutionHarnessForModel,
  getModelDisplayName,
  hasHydratedModelRegistry,
  isModelHarness,
} from '@canopy/desktop-shared/types';
import { isGatewayRoutableModel } from '@canopy/desktop-shared/lib/gateway-model-availability';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { lapsedOrgNames as lapsedOrgNamesFrom } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import {
  DialogModal,
  LoadingSpinner,
  MODEL_LIBRARY_UNLOCK_COPY,
} from '@canopy/ui-shared';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { brandText } from '@/lib/brand';
import {
  CONTACT_ORG_ADMIN_COPY,
  CONTACT_ORG_ADMIN_LAPSED_COPY,
  announceAiCreditsChanged,
  readSharedAiCreditsAvailability,
  resolveAiCreditsCoverage,
  useUnlockModelsAction,
  type UnlockModelsResult,
} from '@/lib/openBillingPage';
import { refreshWorkModelLibraryAccess } from '@/lib/modelLibraryAccess';
import {
  checkModelUnlockNow,
  retryModelUnlockApply,
  useModelUnlockIntentStore,
} from '@/lib/modelUnlockIntent';
import { getProviderLabel } from '@/lib/providerLabels';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import {
  GUEST_MODEL_GATE_DISMISS,
  guestModelGateTitle,
  guestModelGateBody,
  guestModelGatePrimaryLabel,
  guestModelGateToast,
} from '@/lib/guest-cta-copy';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import { ACCOUNT_BUTTON_PRIMARY } from '@/lib/account-button-styles';
import type { ModelRecovery } from '@/lib/modelPickerRowGate';
import { GetAiCreditsCta } from './GetAiCreditsCta';
import { saveDailyCreditDripChoice } from '@/lib/daily-credit-drip';

/**
 * CAN-2349 §3 — the ONE recovery modal.
 *
 * Every recoverable gate in the picker (A, B, C-escalation, H) routes here, so
 * the picker has exactly two answers to "you can't have this model yet": this
 * modal, or the shared disabled-reason reveal. It varies only by copy and which
 * CTAs it renders.
 *
 * The continue dialog stays its own component because it confirms an ACTION
 * rather than recovering a gate — but it shares the same primitives
 * (`DialogModal` shell, `LoadingSpinner` busy state, `GetAiCreditsCta`).
 */

/**
 * The selection resolved AT CLICK TIME.
 *
 * §4: the modal never re-derives its branch from live props. `AuthLoginModal`
 * invalidates the provider cache on unmount, which makes `useProviderAvailability`
 * report `loading: true`, and the row gate is OPTIMISTIC while loading — so a
 * user who CANCELS the login would trip a transient "gate cleared" and get the
 * model silently committed. Snapshot, don't observe.
 */
export interface PendingModelRecovery {
  readonly model: ChatModel;
  readonly recovery: ModelRecovery;
  /**
   * What the user was actually trying to do.
   *
   * `'select-model'` (default) is a row click: the model itself is gated, so
   * "add credits to use this model" is accurate copy.
   *
   * `'enable-ai-credits'` is the picker-footer escalation (case C). There
   * `model` is the CURRENT model and nothing is wrong with it — it is very
   * often an ordinary Claude/Codex model that bills fine to a subscription.
   * The user is switching a billing mode, so copy that claims the model
   * "runs on AI Credits" is simply false.
   */
  readonly intent?: 'select-model' | 'enable-ai-credits';
}

/**
 * What the host did with a commit attempt.
 *
 * Returning `void` means "committed" — the ordinary case, and what keeps the
 * five existing call sites unchanged. A `{ ok: false }` says the host REFUSED
 * the commit and supplies the reason to show, which is the only way this modal
 * can tell "the model was applied" apart from "the host dropped it on the
 * floor". `ModelPicker` refuses when the pending row became provider-locked
 * while the modal was open: `chatStore.setModel` is fire-and-forget and its
 * `changeModel` IPC answers `accepted: false` for a cross-provider change on a
 * locked chat, so committing anyway would close this modal over a change that
 * never lands — the silent dead end CAN-2349 exists to remove.
 */
export type ModelCommitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Shown when the commit itself threw rather than being refused. Deliberately
 * does not name a cause — an IPC rejection tells us nothing about why — but the
 * action is the same as every other blocked commit: try again.
 */
const COMMIT_FAILED_REASON =
  'We couldn’t switch models just now. Check your connection and try again.';

export interface ModelRecoveryModalProps {
  readonly pending: PendingModelRecovery;
  readonly ownerDocument?: Document;
  /** Coverage/sign-in confirmed — commit the model. */
  readonly onCommit: (
    model: ChatModel,
  ) => ModelCommitOutcome | void | Promise<ModelCommitOutcome | void>;
  /** Case H only: open a fresh chat on this model instead of committing it. */
  readonly onStartNewChat?: (model: ChatModel) => void;
  readonly onCancel: () => void;
  /**
   * Owner of the chat being recovered (CAN-3463). AI Credits spill only onto
   * that owner's organization pool, so coverage, the lapsed-org list, and the
   * contact-admin copy all describe that one org. Omitted = navigation context.
   */
  readonly aiCreditsScope?: AiCreditsScopeRequest;
  /**
   * CAN-4028 — open browser checkout for the purchase that unlocks advanced
   * models, and remember the pending model so the host applies it once the
   * server confirms. Supplied by `ModelPicker`, which binds the application to
   * the ORIGINATING chat exactly as it binds {@link onCommit}.
   *
   * Optional: without it this modal opens checkout itself and applies
   * nothing, so the user picks the model again once it is unlocked.
   */
  readonly onUnlockPurchase?: () => Promise<UnlockModelsResult>;
}

/**
 * Where the purchase branch is. Everything after `opened` is read from the
 * pending intent instead, because the poll loop that confirms the purchase is
 * owned by the app root and outlives this modal.
 */
type UnlockAttempt =
  | { readonly status: 'idle' }
  | { readonly status: 'opening' }
  | { readonly status: 'opened'; readonly requestId?: string }
  | { readonly status: 'contact-admin' }
  | { readonly status: 'failed' };

/** What the account read says. Snapshotted, never derived from live props. */
type AccountRead =
  | { readonly status: 'loading' }
  /** Read failed or came back inconclusive. NEVER offer a purchase on this. */
  | { readonly status: 'inconclusive' }
  | {
      readonly status: 'settled';
      readonly availability: NativeAiCreditsAvailability;
      readonly guest: boolean;
      /**
       * A cloud credential (guest or signed in) is connected, so the daily
       * free-credit drip can be turned on from here. `guest` is also true with
       * no credential at all, so it cannot answer this.
       */
      readonly connected: boolean;
      /**
       * Orgs that have lost the `teams` capability, read off the SAME account
       * snapshot as `guest`.
       *
       * `resolveAiCreditsCoverage` never discovers these on its own — it only
       * ever echoes back the names its caller hands it (`lapsedOrgNames` is a
       * parameter with a `[]` default, see `openBillingPage.ts`). Omitting the
       * argument therefore guarantees `coverage.lapsedOrgNames` is empty, which
       * makes the lapsed branch below unreachable and drops a lapsed-org member
       * onto the ordinary self-serve purchase copy. `OrgLapsedBanner` sources
       * them the same way.
       */
      readonly lapsedOrgs: readonly string[];
      /**
       * CAN-4028 — this signed-in account still needs a card purchase before
       * the pending model can be selected. Snapshotted with the rest of the
       * read, so the branch cannot flip under the user between renders.
       */
      readonly libraryPurchaseRequired: boolean;
    };

export function ModelRecoveryModal({
  pending,
  ownerDocument,
  onCommit,
  onStartNewChat,
  onCancel,
  aiCreditsScope,
  onUnlockPurchase,
}: ModelRecoveryModalProps): JSX.Element | null {
  const modelLabel = getModelDisplayName(pending.model);
  /**
   * Can AI Credits actually run THIS model?
   *
   * `resolveAiCreditsCoverage(...).canSpendCredits` answers a question about
   * the ACCOUNT — "can you pay for a gateway-routed turn?" — and says nothing
   * about whether the pending model has a gateway route at all. A native-only
   * model (no `gatewayId`, e.g. `gpt-5.3-codex-spark`) gated on
   * `needs-billing-source` is cleared by signing in to the provider and by
   * nothing else: buying credits cannot route it, so neither committing it on
   * coverage nor offering a purchase would help.
   *
   * Scoped to `needs-billing-source` deliberately. The credits-shaped
   * recoveries (case B `needs-credits`, and the case-C billing-mode switch)
   * are only ever raised for models the picker already established are
   * credit-payable, so re-deriving routability there would risk suppressing a
   * legitimate recovery on a registry mismatch.
   *
   * Registry emptiness is genuinely AMBIGUOUS ("not loaded yet" vs. "no routes
   * exist"). The gateway registry starts empty and is filled from the
   * model-configuration broadcast, so during that window every model looks
   * non-routable — and neither answer may be acted on:
   *
   *  - Treating it as "native only" would strip the purchase path from users
   *    who genuinely can buy their way out.
   *  - Auto-COMMITTING on it selects a model with no gateway route and still no
   *    provider login, which is exactly the dead end this modal exists to
   *    prevent.
   *
   * So the AUTO-COMMIT fails closed (below), and RENDERING does not answer the
   * question at all: while `needsGatewayRoute && !gatewayRoutesKnown` the modal
   * shows a routes-loading shell and every branch that acts on routability
   * waits for the real answer. That pairing is load-bearing — the two used to
   * fail in opposite directions on the SAME render, which put a `Use {model}`
   * button in front of a covered account whose handler then refused to commit,
   * repainting the identical modal on every click.
   */
  // Readiness is a REGISTRY-LIFECYCLE question, not a route-count one.
  // `hasGatewayModelRoutes()` answers `false` both for "the registry has not
  // loaded" and for "a loaded, policy-filtered registry that legitimately has
  // zero gateway routes" — the second reachable once an org policy blocks every
  // gateway-routable entry while leaving an allowed native-only model. Keying
  // the loading shell off the route count would then wait forever for a route
  // that can never arrive, and the user would never reach the provider sign-in
  // branch that actually clears their gate.
  const gatewayRoutesKnown = hasHydratedModelRegistry();
  const needsGatewayRoute = pending.recovery.kind === 'needs-billing-source';
  /**
   * Fail-OPEN, and only ever read AFTER the routes-loading shell has returned,
   * so by then it is equal to `creditsProvenToRunPendingModel`. Kept distinct
   * because the open default is what makes that early return safe: it is the
   * reason an unknown registry can never render the native-only branch.
   */
  const creditsCanRunPendingModel =
    !needsGatewayRoute ||
    !gatewayRoutesKnown ||
    isGatewayRoutableModel(pending.model);
  /**
   * Fail-CLOSED. Drives the silent auto-commit, which runs from an EFFECT and
   * therefore still sees the ambiguous window the render path now skips. An
   * empty registry withholds the commit instead of guessing; the user reaches
   * the model through the rendered branch once the registry has loaded.
   */
  const creditsProvenToRunPendingModel =
    !needsGatewayRoute ||
    (gatewayRoutesKnown && isGatewayRoutableModel(pending.model));
  const [read, setRead] = useState<AccountRead>({ status: 'loading' });
  const [loginOpen, setLoginOpen] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const mountedRef = useRef(true);
  const providerAuthSnapshotRef = useRef<{
    readonly provider: 'claude' | 'codex';
    readonly authenticated: false;
  } | null>(null);
  // §3 child-surface exclusivity: `CloudSyncModal` renders at `DialogModal`'s
  // modal tier, so without this we would cover the
  // sign-in modal we just asked for.
  const cloudGatePending = useCloudConnectGateStore((s) => s.pending);
  // Read through a ref so `refreshAccountRead` (and therefore the mount effect
  // that depends on it) keeps a stable identity across parent re-renders.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  /** Monotonic token; only the newest account read may apply its result. */
  const readSeqRef = useRef(0);
  /**
   * This modal commits AT MOST ONCE, whichever path gets there first.
   *
   * Closing the cloud gate wakes up two independent commit paths that both
   * re-read coverage and both conclude "covered": this modal's own gate-close
   * `refreshAccountRead`, and `GetAiCreditsCta`'s `proceedAfterConnect` →
   * `onCovered`. `GetAiCreditsCta.coveredRef` latches only the CTA's half, and
   * the two chains are two IPC hops each with no ordering between them, so
   * without a latch here a single sign-in can commit the model twice.
   *
   * The second commit is not merely redundant. `ModelPicker` clears
   * `recoveryModelChangeRef` when the first one lands, so a late duplicate
   * falls back to the LIVE `props.onModelChange` — re-selecting the model on
   * whatever chat is active by then, which is exactly the cross-chat leak that
   * ref was added to prevent.
   */
  const committedRef = useRef(false);
  /**
   * The host's reason for refusing the last commit, or `null`.
   *
   * Rendered as a status line that keeps this modal OPEN, because the refusal
   * is transient by construction: `ModelPicker` only refuses on
   * `locked-provider`, whose own copy ("stop the current turn, then switch")
   * describes something the user clears themselves. The recovery itself
   * SUCCEEDED — credits arrived, or the login landed — so cancelling it here
   * would throw that away; the user retries with the same button once the turn
   * finishes.
   */
  const [commitBlockedReason, setCommitBlockedReason] = useState<string | null>(
    null,
  );
  /**
   * How many times the user has pressed the blocked branch's **Try again**.
   *
   * Load-bearing, not telemetry. A still-refused retry calls
   * `setCommitBlockedReason` with the string it ALREADY holds, and React bails
   * out of a re-render on an unchanged value — so without a changing piece of
   * state the press produces no repaint at all. `lockedProviderReason` is
   * stable for the whole duration of a streaming or queued turn, so every press
   * before that turn ends would be a literal no-op: the dead click this ticket
   * exists to remove, inside the branch written to remove it.
   */
  const [commitAttempt, setCommitAttempt] = useState(0);
  /**
   * Busy state for the blocked branch's retry.
   *
   * `commitModel` awaits an IPC round trip, and this was the only async
   * affordance in the flow without one — every sibling (`renderRetry`,
   * `renderSignIn`, `GetAiCreditsCta`, and the `ConfirmDialog` spinner this
   * change shipped) disables and shows a spinner while in flight.
   * `commitInFlightRef` already made a double press harmless, but harmless is
   * not the same as visible.
   */
  const [commitRetryBusy, setCommitRetryBusy] = useState(false);
  /**
   * The "Turn on free daily credits" action for a user who opted out of the
   * daily drip. `saved` means the preference is on but the re-read still found
   * no balance (the grant failed, or today's drip was already granted and
   * spent): the action is hidden, since the preference is already saved, and
   * the modal says when credits arrive instead of closing on a stale balance.
   */
  const [dailyDrip, setDailyDrip] = useState<
    'idle' | 'busy' | 'error' | 'saved'
  >('idle');
  const dailyDripBusyRef = useRef(false);
  /**
   * ASYNC because the host's answer is authoritative and comes from main.
   *
   * `ModelPicker` routes a row recovery through `setModelAndWait`, which
   * resolves to whether the ORIGINATING chat actually accepted the change — the
   * only answer that is correct across a chat-tab switch. A synchronous guess
   * from the rendered rows could refuse a valid commit or miss a real refusal.
   *
   * The in-flight latch matters as much as the committed one: awaiting opens a
   * window in which the same button (or a focus/visibilitychange re-probe) can
   * fire again, and two overlapping commits are exactly what `committedRef`
   * exists to prevent.
   */
  const commitInFlightRef = useRef(false);
  const commitModel = useCallback(
    async (model: ChatModel): Promise<boolean> => {
      if (committedRef.current) return true;
      if (commitInFlightRef.current) return false;
      commitInFlightRef.current = true;
      try {
        const outcome = await onCommitRef.current(model);
        if (outcome !== undefined && outcome.ok === false) {
          // NOT latched: a refused commit never reached the host's state, so
          // the retry must be allowed to try again.
          if (mountedRef.current) setCommitBlockedReason(outcome.reason);
          return false;
        }
        committedRef.current = true;
        if (mountedRef.current) setCommitBlockedReason(null);
        return true;
      } catch {
        // A THROW is not a refusal, but it strands the user the same way, and
        // every caller here latches busy state before awaiting: an escaping
        // rejection would leave the modal on "Checking your account…", or Try
        // again / Sign in permanently disabled, plus an unhandled rejection
        // from each `void` call site. Route it into the same blocked branch —
        // it already means "the recovery succeeded, the commit did not land"
        // and already offers the retry.
        if (mountedRef.current) setCommitBlockedReason(COMMIT_FAILED_REASON);
        return false;
      } finally {
        commitInFlightRef.current = false;
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const refreshAccountRead = useCallback(
    async (options: { readonly fresh?: boolean } = {}): Promise<void> => {
      // Only the newest read may write state. Two reads can overlap (mount +
      // Try again, or a re-run after `pending.model` changes), and the IPC pair
      // below is not ordered, so without this an older, staler answer can land
      // last and win.
      const seq = ++readSeqRef.current;
      let availability: NativeAiCreditsAvailability | null = null;
      let account: CanopyCloudAccountPublicState | null | undefined;
      // SHARED with `GetAiCreditsCta`'s post-connect read. Both wake on the same
      // gate close, and two independent reads of the same account can disagree —
      // the credits fan-out is network-backed and a transient failure degrades to
      // "uncovered", not to an error. That let this modal conclude *covered* and
      // commit while the CTA concluded *uncovered* and opened a billing page for
      // credits the user had just been granted. One episode, one answer.
      //
      // `fresh` is passed only by **Try again**, whose entire purpose is to ask
      // the question again — serving it the answer this modal already has would
      // make the button a no-op.
      availability = await readSharedAiCreditsAvailability({
        ...options,
        ...(aiCreditsScope ? { scope: aiCreditsScope } : {}),
      });
      try {
        account = await window.api.loadCanopyCloudAccount();
      } catch {
        account = null;
      }
      // CAN-4028 — library access is its own server fact, read fresh alongside
      // the account so a guest who just signed in is judged as the account
      // they now are. Skipped for every other recovery kind: they are funding
      // or provider questions, and must not grow an extra cloud read.
      const libraryRead =
        pending.recovery.kind === 'needs-purchase' ||
        pending.recovery.kind === 'needs-account'
          ? await refreshWorkModelLibraryAccess(aiCreditsScope)
          : undefined;
      if (!mountedRef.current || seq !== readSeqRef.current) return;
      // The §7 guard lives in `resolveAiCreditsCoverage`, but the modal has to
      // distinguish "inconclusive" from "conclusively uncovered" to pick a
      // branch, so it checks the field itself rather than inferring it from
      // three false flags — inferring it is exactly the failure mode that keeps
      // both the old and new tests green while genuinely-uncovered users lose
      // their purchase CTA.
      if (!availability || availability.inconclusive === true) {
        setRead({ status: 'inconclusive' });
        return;
      }
      // Only the owner org's lapse can block this chat (CAN-3463); Personal
      // work has no owner org, so no lapse applies to it.
      const ownerOrganizationId = availability.ownerOrganization?.id;
      const orgBillingStates = ownerOrganizationId
        ? (account?.orgBillingStates ?? []).filter(
            (state) => state.organizationId === ownerOrganizationId,
          )
        : [];
      const guest =
        !isCanopyCloudConnected(account) ||
        isGuestAccount(account ?? undefined);
      // A row gated on `needs-purchase` stays gated when the re-read FAILS
      // (`null`): the lock was drawn from a real answer, and a blip is not
      // evidence it lifted. It does lift on any answered read that no longer
      // says `needs_purchase` — unlocked, or a server without the gate.
      //
      // A `needs-account` recovery reaches this only after sign-in, and then
      // only an explicit `needs_purchase` holds it: the guest's lock said
      // nothing about the account they signed in to.
      const libraryPurchaseRequired =
        !guest &&
        (pending.recovery.kind === 'needs-purchase'
          ? libraryRead === null || libraryRead?.access === 'needs_purchase'
          : pending.recovery.kind === 'needs-account' &&
            libraryRead?.access === 'needs_purchase');
      const nextRead: AccountRead = {
        status: 'settled',
        availability,
        guest,
        libraryPurchaseRequired,
        connected: isCanopyCloudConnected(account),
        lapsedOrgs: lapsedOrgNamesFrom(
          orgBillingStates,
          orgBillingStates.map((state) => state.organizationId),
        ),
      };
      const coverage = resolveAiCreditsCoverage(
        nextRead.availability,
        nextRead.lapsedOrgs,
      );
      // Coverage may have appeared between the row click and this snapshot, or
      // while a contact-admin/inconclusive branch was waiting on Try again. In
      // either case the recovery has succeeded: commit immediately instead of
      // falling through to a misleading purchase branch with a "Use model"
      // button that would open billing again.
      //
      // `canSpendCredits` is ACCOUNT coverage, not proof this model can use it.
      // A native-only model (no `gatewayId`, e.g. `gpt-5.3-codex-spark`) whose
      // row is gated on `needs-billing-source` cannot be routed to credits at
      // all, so committing it here would select a model that has no way to run:
      // no gateway route and still no provider login. That branch is cleared by
      // signing in to the provider, and nothing else.
      // CAN-3026 — a `needs-account` recovery is NOT a funding question, so
      // coverage must not clear it. A guest may already be FUNDED (a guest who
      // opted in to the daily free-credit drip tops up every day, like a
      // signed-in free account), which makes `canSpendCredits` true for exactly
      // the principal this gate exists to stop — and committing on it here would
      // silently hand the guest the expensive model the row gate just refused.
      //
      // Not a dead end: signing in clears `guest` on the gate-close re-read
      // below, this guard lifts, and the commit fires then.
      const guestAccountGateStands =
        pending.recovery.kind === 'needs-account' && nextRead.guest;
      // CAN-4028 — and neither may it clear a purchase lock. A signed-in
      // non-payer's daily free credits make `canSpendCredits` true while the
      // library stays locked, so committing here would select a model the
      // server refuses on the next send.
      if (
        !guestAccountGateStands &&
        !libraryPurchaseRequired &&
        coverage.canSpendCredits &&
        creditsProvenToRunPendingModel
      ) {
        announceAiCreditsChanged();
        // Only stop here if the commit LANDED. A refused commit (the row went
        // provider-locked) must still publish the settled read: returning early
        // on the mount read would pin the modal on "Checking your account…"
        // with nothing but Cancel, so the retry the refusal promises would not
        // exist on any branch.
        if (await commitModel(pending.model)) return;
      }
      setRead(nextRead);
      // `onCommit` is read through a ref (via the stable `commitModel`), NOT
      // taken as a dependency. Callers pass it as an inline arrow (`ModelPicker`
      // does), so depending on it would give this callback a new identity on
      // every parent render — and the mount effect below, which depends on it,
      // would re-fire and issue two more unthrottled IPC reads each time.
      // `ChatInput`'s `tab` prop changes on every streamed chunk, so a modal left
      // open during a turn would re-probe the account continuously. `commitModel`
      // is `useCallback([])`, so listing it costs nothing.
    },
    [
      aiCreditsScope,
      commitModel,
      creditsProvenToRunPendingModel,
      pending.model,
      pending.recovery.kind,
    ],
  );

  // ---- CAN-4028: the purchase that unlocks advanced models.
  const [unlockAttempt, setUnlockAttempt] = useState<UnlockAttempt>({
    status: 'idle',
  });
  const [unlockCheckBusy, setUnlockCheckBusy] = useState(false);
  const [unlockApplyBusy, setUnlockApplyBusy] = useState(false);
  const unlockOpeningRef = useRef(false);
  const defaultUnlockModels = useUnlockModelsAction(aiCreditsScope);
  const onUnlockPurchaseRef = useRef(onUnlockPurchase);
  onUnlockPurchaseRef.current = onUnlockPurchase;
  /**
   * The phase of the intent THIS modal opened, or null.
   *
   * Matched on the request id so a different attempt — another chat's, or a
   * newer one from this chat — is never narrated here as this one's progress.
   */
  const unlockRequestId =
    unlockAttempt.status === 'opened' ? unlockAttempt.requestId : undefined;
  const unlockPhase = useModelUnlockIntentStore((state) =>
    unlockRequestId !== undefined && state.intent?.requestId === unlockRequestId
      ? state.phase
      : null,
  );

  /**
   * Open checkout in the browser. Also the **Reopen checkout** action after a
   * timeout: a second attempt simply replaces the first as the pending one.
   */
  const handleUnlockPurchase = useCallback((): void => {
    if (unlockOpeningRef.current) return;
    unlockOpeningRef.current = true;
    setUnlockAttempt({ status: 'opening' });
    void (async (): Promise<void> => {
      let result: UnlockModelsResult;
      try {
        result = await (onUnlockPurchaseRef.current
          ? onUnlockPurchaseRef.current()
          : defaultUnlockModels({
              source: 'desktop',
              modelId: pending.model,
            }));
      } catch {
        result = { outcome: 'failed' };
      }
      unlockOpeningRef.current = false;
      if (!mountedRef.current) return;
      if (result.outcome === 'unlocked') {
        // Already unlocked: no checkout opened. Re-read so the ordinary
        // branches take over and commit, exactly as if the lock had never
        // been drawn.
        setUnlockAttempt({ status: 'idle' });
        void refreshAccountRead({ fresh: true });
        return;
      }
      if (result.outcome === 'sign-in') {
        // The shared gate is up; this modal hides behind it and the gate-close
        // re-read picks the next branch.
        setUnlockAttempt({ status: 'idle' });
        return;
      }
      setUnlockAttempt(
        result.outcome === 'opened'
          ? {
              status: 'opened',
              ...(result.requestId !== undefined
                ? { requestId: result.requestId }
                : {}),
            }
          : { status: result.outcome },
      );
    })();
  }, [defaultUnlockModels, pending.model, refreshAccountRead]);

  const handleUnlockCheckAgain = useCallback((): void => {
    setUnlockCheckBusy(true);
    void checkModelUnlockNow().finally((): void => {
      if (mountedRef.current) setUnlockCheckBusy(false);
    });
  }, []);

  const handleUnlockApplyRetry = useCallback((): void => {
    setUnlockApplyBusy(true);
    void retryModelUnlockApply().finally((): void => {
      if (mountedRef.current) setUnlockApplyBusy(false);
    });
  }, []);

  /**
   * The CTA's commit path, held to the SAME fail-closed bar as the silent one.
   *
   * Which branch renders is decided by the fail-OPEN constant, so during the
   * empty-registry window a `needs-billing-source` guest reaches the guest
   * branch, signs in, receives free credits — and would commit a native-only
   * model that credits still cannot route. Gating only the silent auto-commit
   * left this second door open to exactly the dead end the split was added to
   * prevent. On unproven routability, re-read instead of committing: once the
   * registry has loaded the modal re-renders into the honest native-only
   * branch, which asks for a provider sign-in.
   */
  const handleCoveredFromCta = useCallback(async (): Promise<boolean> => {
    if (!creditsProvenToRunPendingModel) {
      void refreshAccountRead({ fresh: true });
      // Not a refusal: we are re-reading, and the CTA's one-shot latch SHOULD
      // stay open so the user can act again once the registry lands.
      return false;
    }
    // Propagated so a refused commit leaves the CTA's latch open — otherwise
    // the retry this modal promises is a dead click.
    return commitModel(pending.model);
  }, [
    commitModel,
    creditsProvenToRunPendingModel,
    pending.model,
    refreshAccountRead,
  ]);

  useEffect(() => {
    // Case H is billing-free: it needs no account state at all, so it must not
    // sit behind an account read that could fail and strand it on "couldn't
    // check your account" for a question that has nothing to do with billing.
    if (pending.recovery.kind === 'needs-new-chat') {
      return;
    }
    // FRESH. This is the branch-selecting read — the one the user's click on a
    // gated row is actually asking — and it is the only read in the flow that
    // could otherwise return an answer of unbounded age. It decides whether to
    // auto-commit on coverage, so a retained answer here could commit a model
    // whose credits were spent since, or show purchase copy to someone whose
    // admin just granted headroom. The GATE-CLOSE read below stays non-fresh:
    // that is the one that must share its answer with `GetAiCreditsCta`.
    void refreshAccountRead({ fresh: true });
  }, [pending.recovery.kind, refreshAccountRead]);

  /**
   * Re-read the account when the shared cloud gate closes.
   *
   * The branch this modal is showing was chosen from a PRE-sign-in snapshot, so
   * without this a guest who just signed in comes back to "Sign in to your
   * account…" — copy aimed at someone who is now signed in. The CTA's own
   * post-connect coverage check commits when credits are already there; this
   * covers the rest (a connect that yields no credits, or a cancelled one that
   * still changed account state).
   */
  const sawCloudGateRef = useRef(false);
  useEffect(() => {
    if (cloudGatePending !== null) {
      sawCloudGateRef.current = true;
      return;
    }
    if (!sawCloudGateRef.current) return;
    sawCloudGateRef.current = false;
    if (pending.recovery.kind === 'needs-new-chat') return;
    void refreshAccountRead();
  }, [cloudGatePending, pending.recovery.kind, refreshAccountRead]);

  const handleRetry = useCallback((): void => {
    setRetryBusy(true);
    void (async (): Promise<void> => {
      await refreshAccountRead({ fresh: true });
      if (mountedRef.current) {
        setRetryBusy(false);
      }
    })();
  }, [refreshAccountRead]);

  /**
   * Turn the daily drip on, wait for every AI-credits cache to hold the new
   * balance, then re-run the same account read the modal opened with. Enabling
   * grants today's drip server-side before the save resolves, so a covered
   * re-read commits the pending model (and the host closes this modal) through
   * the ordinary auto-commit path. Never a second PUT while one is in flight.
   */
  const handleTurnOnDailyDrip = useCallback((): void => {
    if (dailyDripBusyRef.current) return;
    dailyDripBusyRef.current = true;
    setDailyDrip('busy');
    void (async (): Promise<void> => {
      try {
        const { refreshed } = await saveDailyCreditDripChoice(true);
        await refreshed;
      } catch {
        dailyDripBusyRef.current = false;
        if (mountedRef.current) setDailyDrip('error');
        return;
      }
      await refreshAccountRead({ fresh: true });
      dailyDripBusyRef.current = false;
      if (mountedRef.current && !committedRef.current) setDailyDrip('saved');
    })();
  }, [refreshAccountRead]);

  const probeProviderAuth = useCallback(
    async (
      provider: 'claude' | 'codex',
    ): Promise<AgentProviderAuthStatus | null> => {
      try {
        return provider === 'claude'
          ? await window.api.getClaudeAuthStatus({ forceRefresh: true })
          : await window.api.getCodexAuthStatus({ forceRefresh: true });
      } catch {
        return null;
      }
    },
    [],
  );

  /**
   * Take a settled provider-auth snapshot BEFORE mounting AuthLoginModal.
   * Besides making a cancelled login safe, this closes a stale-row race: if
   * auth was restored between the row click and this action, the model can be
   * committed without opening a login surface the user no longer needs.
   */
  const handleSignIn = useCallback((): void => {
    if (pending.recovery.kind !== 'needs-billing-source') return;
    const provider = pending.recovery.provider;
    setSignInBusy(true);
    void (async (): Promise<void> => {
      const status = await probeProviderAuth(provider);
      if (!mountedRef.current) return;
      if (status === null || status.probeFailed === true) {
        providerAuthSnapshotRef.current = null;
        setSignInBusy(false);
        setRead({ status: 'inconclusive' });
        return;
      }
      if (status.authenticated === true) {
        // Leave the button busy only when the commit actually landed — the
        // modal unmounts on that path. A refusal keeps it mounted, and a stuck
        // `signInBusy` would permanently disable the one retry affordance the
        // settled purchase branch still offers for case A.
        if (!(await commitModel(pending.model))) setSignInBusy(false);
        return;
      }
      providerAuthSnapshotRef.current = {
        provider,
        authenticated: false,
      };
      setSignInBusy(false);
      setLoginOpen(true);
    })();
  }, [commitModel, pending.model, pending.recovery, probeProviderAuth]);

  /**
   * §4 provider sign-in: re-probe with `forceRefresh` and commit ONLY on a
   * settled `authenticated: true`. A failed probe shows Try again, never
   * "you're still not signed in" — an inconclusive probe is not a logout.
   */
  const handleLoginClosed = useCallback((): void => {
    setLoginOpen(false);
    if (pending.recovery.kind !== 'needs-billing-source') {
      return;
    }
    const provider = pending.recovery.provider;
    const snapshot = providerAuthSnapshotRef.current;
    providerAuthSnapshotRef.current = null;
    if (!snapshot || snapshot.provider !== provider) {
      setSignInBusy(false);
      setRead({ status: 'inconclusive' });
      return;
    }
    setSignInBusy(true);
    void (async (): Promise<void> => {
      const status = await probeProviderAuth(provider);
      if (!mountedRef.current) return;
      if (status === null || status.probeFailed === true) {
        setSignInBusy(false);
        setRead({ status: 'inconclusive' });
        return;
      }
      if (status.authenticated === true) {
        // Same as `handleSignIn`: only a landed commit unmounts us, so a
        // refusal must release the button.
        if (!(await commitModel(pending.model))) setSignInBusy(false);
        return;
      }
      if (mountedRef.current) {
        setSignInBusy(false);
        void refreshAccountRead();
      }
    })();
  }, [
    pending.recovery,
    pending.model,
    commitModel,
    probeProviderAuth,
    refreshAccountRead,
  ]);

  // The login modal wins outright: it is the child surface we asked for.
  if (loginOpen && pending.recovery.kind === 'needs-billing-source') {
    return (
      <AuthLoginModal
        provider={pending.recovery.provider}
        ownerDocument={ownerDocument}
        onClose={handleLoginClosed}
      />
    );
  }

  // While the shared cloud gate is up this modal HIDES (display:none via the
  // overlay class) instead of unmounting, so `CloudSyncModal` is not buried
  // under our overlay.
  //
  // Hidden, NOT unmounted — load-bearing. `GetAiCreditsCta` is the thing that
  // called `requestConnect`, and `CloudConnectGate` closes by resolving first
  // and invoking `proceed` afterwards. Unmounting here left that callback an
  // orphan whose `mountedRef` was already false, so its post-connect coverage
  // re-read bailed out and fell through to opening a billing page: the guest
  // signed in, received the free starting credits the copy promised, and got a
  // purchase page plus a modal still telling them to sign in.
  //
  // Still a plain render-time read of the store, NOT a latched flag, so a
  // CANCELLED sign-in (where `proceed` never ran) brings the modal straight
  // back rather than leaving an invisible dialog holding a pending selection.
  const hiddenBehindCloudGate = cloudGatePending !== null;

  const signInProvider =
    pending.recovery.kind === 'needs-billing-source'
      ? pending.recovery.provider
      : null;

  const renderSignIn = (): JSX.Element | null => {
    if (!signInProvider) return null;
    return (
      <button
        type="button"
        data-testid="model-recovery-sign-in"
        disabled={signInBusy}
        onClick={handleSignIn}
        className={`flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-s fg-primary transition hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {signInBusy && (
          <LoadingSpinner
            dataTestId="model-recovery-sign-in-spinner"
            decorative
          />
        )}
        {`Sign in to ${getProviderLabel(signInProvider)}`}
      </button>
    );
  };

  const renderRetry = (): JSX.Element => (
    <button
      type="button"
      data-testid="model-recovery-try-again"
      disabled={retryBusy}
      onClick={handleRetry}
      className={`flex w-full items-center justify-center gap-1.5 ${ACCOUNT_BUTTON_PRIMARY} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {retryBusy && (
        <LoadingSpinner
          dataTestId="model-recovery-try-again-spinner"
          decorative
        />
      )}
      Try again
    </button>
  );

  const renderCancel = (label: string = 'Cancel'): JSX.Element => (
    <button
      type="button"
      data-testid="model-recovery-cancel"
      onClick={onCancel}
      className="w-full rounded-md px-3 py-1.5 text-s fg-secondary transition hover:bg-subtle"
    >
      {label}
    </button>
  );

  const shell = (
    title: string,
    body: JSX.Element,
    actions: JSX.Element,
  ): JSX.Element => (
    <DialogModal
      onClose={onCancel}
      title={title}
      maxWidth="sm"
      // Matches AuthLoginModal so the two never fight over stacking order.
      // `hidden` while the cloud gate owns the screen — see
      // `hiddenBehindCloudGate`; the subtree stays mounted underneath.
      overlayClassName={hiddenBehindCloudGate ? 'hidden' : ''}
      dataTestId="model-recovery-modal"
      ownerDocument={ownerDocument}
    >
      <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
        <div className="text-s leading-relaxed fg-secondary">{body}</div>
        <div className="flex flex-col gap-2">{actions}</div>
      </div>
    </DialogModal>
  );

  // ---- Case H: billing-free, and deliberately NOT the continue dialog's copy.
  // That dialog promises to bring a summary across, which is exactly what a
  // non-continuable pair cannot do. Promising it would be a lie.
  if (pending.recovery.kind === 'needs-new-chat') {
    const { lockedProvider, lockedHarness } = pending.recovery;
    const sourceHarness =
      lockedHarness ??
      (isModelHarness(lockedProvider) ? lockedProvider : undefined);
    const lockedLabel = sourceHarness
      ? `the ${getProviderLabel(sourceHarness)} harness`
      : getProviderLabel(lockedProvider);
    const targetHarness = getExecutionHarnessForModel(pending.model);
    const targetLabel = targetHarness
      ? `the ${getProviderLabel(targetHarness)} harness`
      : 'another harness';
    return shell(
      `Start a new chat with ${targetLabel}?`,
      <span data-testid="model-recovery-new-chat-body">
        {`This chat uses ${lockedLabel} and can't switch to ${targetLabel}. Starting a new chat leaves this one unchanged.`}
      </span>,
      <>
        <button
          type="button"
          data-testid="model-recovery-start-new-chat"
          onClick={(): void => onStartNewChat?.(pending.model)}
          className={`w-full ${ACCOUNT_BUTTON_PRIMARY}`}
        >
          {`Start a new chat`}
        </button>
        {renderCancel()}
      </>,
    );
  }

  // ---- Read in flight. Never assert an account state we haven't read.
  if (read.status === 'loading') {
    return shell(
      modelLabel,
      <span
        data-testid="model-recovery-checking"
        className="flex items-center gap-2"
      >
        <LoadingSpinner dataTestId="model-recovery-checking-spinner" />
        Checking your account…
      </span>,
      renderCancel(),
    );
  }

  // ---- The recovery SUCCEEDED but the host refused the commit.
  //
  // Owns its own branch rather than decorating whichever branch happened to be
  // rendering, because the underlying account state is now "resolved" — the
  // credits landed, or the login went through — and every resolved branch
  // either has no action left or offers the wrong one (a covered account shown
  // a purchase). Only this branch can promise the retry the copy describes.
  //
  // **Try again** re-attempts the COMMIT rather than re-reading the account.
  // The account question is already answered — re-reading would be the wrong
  // retry for a provider-sign-in recovery, whose success came from
  // `probeProviderAuth` and which a coverage read would never re-establish. A
  // still-refused retry simply re-renders this branch. Takes priority over
  // every read-status branch below.
  if (commitBlockedReason !== null) {
    return shell(
      modelLabel,
      <span
        role="status"
        data-testid="model-recovery-commit-blocked"
        className="flex flex-col gap-2"
      >
        <span>{commitBlockedReason}</span>
        {/* Claims no condition. The reason above deliberately names no cause,
            because `false` also covers `setModelAndWait`'s pre-flight bail-outs
            and swallowed IPC rejections — so "once that clears" would have no
            antecedent, and on those paths "will be selected" is a promise that
            can never come true. Say what is certain: the model is still
            waiting, and there are two ways out. */}
        <span
          className="fg-secondary"
          data-testid="model-recovery-blocked-hint"
        >
          {commitAttempt === 0
            ? `${modelLabel} is still waiting. Try again, or cancel and pick it from the picker later.`
            : `Still no luck. Try again, or cancel and pick ${modelLabel} from the picker later.`}
        </span>
      </span>,
      <>
        <button
          type="button"
          data-testid="model-recovery-commit-retry"
          disabled={commitRetryBusy}
          onClick={(): void => {
            // Counter FIRST: a still-refused commit re-sets the same reason,
            // which React treats as no change, so this is the only thing that
            // guarantees the press repaints and can be acknowledged.
            setCommitAttempt((n) => n + 1);
            setCommitRetryBusy(true);
            void commitModel(pending.model).finally(() => {
              if (mountedRef.current) setCommitRetryBusy(false);
            });
          }}
          className={`flex w-full items-center justify-center gap-1.5 ${ACCOUNT_BUTTON_PRIMARY} disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {commitRetryBusy && (
            <LoadingSpinner
              dataTestId="model-recovery-commit-retry-spinner"
              decorative
            />
          )}
          Try again
        </button>
        {renderCancel()}
      </>,
    );
  }

  // ---- Routability still unknown, and it is the thing this branch turns on.
  //
  // `creditsCanRunPendingModel` fails OPEN and `creditsProvenToRunPendingModel`
  // fails CLOSED, so while the gateway registry is empty a `needs-billing-source`
  // recovery on an account that already has credits renders the self-serve
  // branch — and its button re-reads instead of committing, repainting the
  // identical modal. That is the silent no-op click this ticket exists to
  // remove. The registry genuinely IS still loading, so say so and let the
  // honest branch (purchase, or native-only) render once it lands.
  if (needsGatewayRoute && !gatewayRoutesKnown) {
    return shell(
      modelLabel,
      <span
        data-testid="model-recovery-checking-routes"
        className="flex items-center gap-2"
      >
        <LoadingSpinner dataTestId="model-recovery-checking-routes-spinner" />
        Checking what this model can run on…
      </span>,
      renderCancel(),
    );
  }

  // ---- CAN-3026: a guest picked a model Canopy would pay for that is not on
  // the guest allowlist. An ACCOUNT is the missing thing, not a balance, so
  // this branch sits ahead of every credits branch and needs no billing
  // arithmetic at all. `needsGatewayRoute` is false for this kind, so the
  // routes-loading shell above never intercepts it.
  //
  // Conditioned on the LIVE `read.guest` as well as the snapshotted recovery:
  // a guest who signs in while this modal is open is no longer a guest, and
  // must fall straight through to the ordinary coverage branches (which then
  // commit) rather than being asked to sign in again.
  //
  // An inconclusive read deliberately falls through to the branch below. We
  // cannot prove guest-ness, and Try again is a better answer than a sign-in
  // prompt aimed at someone who may already be signed in.
  if (
    pending.recovery.kind === 'needs-account' &&
    read.status === 'settled' &&
    read.guest
  ) {
    // CAN-4028 — when the account will also need a purchase after sign-in,
    // say so up front with the shared unlock copy, so the sign-in is not
    // followed by a second, unannounced ask. Sign-in alone keeps its own copy.
    const thenPurchase =
      pending.recovery.access === 'needs_sign_in_then_purchase';
    return shell(
      thenPurchase ? MODEL_LIBRARY_UNLOCK_COPY.title : modelLabel,
      <span data-testid="model-recovery-needs-account">
        {thenPurchase
          ? MODEL_LIBRARY_UNLOCK_COPY.guestBody
          : guestModelGateBody(modelLabel)}
      </span>,
      <>
        <button
          type="button"
          data-testid="model-recovery-account-sign-in"
          onClick={(): void => {
            // The SHARED gate, not a bespoke sign-in. This modal hides (rather
            // than unmounts) behind it — see `hiddenBehindCloudGate` — so the
            // gate-close effect above re-reads the account, `read.guest` flips
            // false, and the ordinary coverage path commits the model.
            //
            // `proceed` is empty for that reason: the commit is owned by the
            // coverage re-read, which is the only thing that can prove the new
            // account can actually run this model.
            useCloudConnectGateStore.getState().requestConnect(
              thenPurchase
                ? {
                    title: MODEL_LIBRARY_UNLOCK_COPY.title,
                    subtitle: MODEL_LIBRARY_UNLOCK_COPY.guestBody,
                    // No "you can now use…" toast: signing in does not unlock
                    // the model here, the purchase that follows does.
                  }
                : {
                    title: guestModelGateTitle(),
                    // The panel's lead line and benefit rows carry the pitch.
                    subtitle: null,
                    toastMessage: guestModelGateToast(modelLabel),
                    guestBenefits: true,
                  },
              () => {},
            );
          }}
          className={`w-full ${ACCOUNT_BUTTON_PRIMARY}`}
        >
          {thenPurchase
            ? MODEL_LIBRARY_UNLOCK_COPY.signInAction
            : guestModelGatePrimaryLabel(modelLabel)}
        </button>
        {renderCancel(
          thenPurchase
            ? MODEL_LIBRARY_UNLOCK_COPY.dismissAction
            : GUEST_MODEL_GATE_DISMISS,
        )}
      </>,
    );
  }

  // ---- CAN-4028: signed in, and a card purchase is what unlocks this model.
  //
  // Ahead of every credits branch for the same reason the guest branch is: a
  // balance is not the missing thing. A non-payer's daily credits would
  // otherwise land them on "Use {model}" or "Turn on free daily credits",
  // neither of which the server will honor for a locked model.
  //
  // Reached two ways: a signed-in row click (`needs-purchase`), and a guest
  // who signed in from the branch above and still needs the purchase. The
  // second is why this reads the settled snapshot rather than the recovery
  // kind.
  //
  // Checkout is in the browser, so after it opens the rest is narrated from
  // the pending intent. The app root's poll confirms the purchase and applies
  // the model through the host; on success the host closes this modal.
  if (read.status === 'settled' && read.libraryPurchaseRequired) {
    const purchaseButton = (label: string): JSX.Element => (
      <button
        type="button"
        data-testid="model-recovery-unlock-purchase"
        disabled={unlockAttempt.status === 'opening'}
        onClick={handleUnlockPurchase}
        className={`flex w-full items-center justify-center gap-1.5 ${ACCOUNT_BUTTON_PRIMARY} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {unlockAttempt.status === 'opening' && (
          <LoadingSpinner
            dataTestId="model-recovery-unlock-purchase-spinner"
            decorative
          />
        )}
        {label}
      </button>
    );
    const checkAgainButton = (primary: boolean): JSX.Element => (
      <button
        type="button"
        data-testid="model-recovery-unlock-check-again"
        disabled={unlockCheckBusy}
        onClick={handleUnlockCheckAgain}
        className={
          primary
            ? `flex w-full items-center justify-center gap-1.5 ${ACCOUNT_BUTTON_PRIMARY} disabled:cursor-not-allowed disabled:opacity-60`
            : 'flex w-full items-center justify-center gap-1.5 rounded-md border border-line-base px-3 py-1.5 text-s fg-primary transition hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60'
        }
      >
        {unlockCheckBusy && (
          <LoadingSpinner
            dataTestId="model-recovery-unlock-check-again-spinner"
            decorative
          />
        )}
        Check again
      </button>
    );

    // The work belongs to an organization this user cannot fund. A personal
    // purchase would not unlock it, so none is offered.
    if (unlockAttempt.status === 'contact-admin') {
      return shell(
        MODEL_LIBRARY_UNLOCK_COPY.title,
        <span data-testid="model-recovery-unlock-contact-admin">
          {CONTACT_ORG_ADMIN_COPY}
        </span>,
        renderCancel('Close'),
      );
    }

    // Confirmed, but the model did not land. The unlock stands; only the
    // selection is offered again — the one place "Use {model}" appears.
    if (unlockPhase === 'apply-failed') {
      return shell(
        MODEL_LIBRARY_UNLOCK_COPY.title,
        <span
          role="status"
          data-testid="model-recovery-unlock-apply-failed"
          className="flex flex-col gap-2"
        >
          <span>{MODEL_LIBRARY_UNLOCK_COPY.confirmed}</span>
          <span>{`We couldn’t switch to ${modelLabel} just now.`}</span>
        </span>,
        <>
          <button
            type="button"
            data-testid="model-recovery-unlock-use-model"
            disabled={unlockApplyBusy}
            onClick={handleUnlockApplyRetry}
            className={`flex w-full items-center justify-center gap-1.5 ${ACCOUNT_BUTTON_PRIMARY} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {unlockApplyBusy && (
              <LoadingSpinner
                dataTestId="model-recovery-unlock-use-model-spinner"
                decorative
              />
            )}
            {`Use ${modelLabel}`}
          </button>
          {renderCancel('Close')}
        </>,
      );
    }

    // Confirmed. Either the host is applying the model right now and will
    // close this modal, or there was nothing left to apply (the selection
    // moved while the user was paying) and Close is the only thing to offer.
    if (unlockPhase === 'applying' || unlockPhase === 'unlocked') {
      return shell(
        MODEL_LIBRARY_UNLOCK_COPY.title,
        <span
          role="status"
          data-testid="model-recovery-unlock-confirmed"
          className="flex items-center gap-2"
        >
          {unlockPhase === 'applying' && (
            <LoadingSpinner
              dataTestId="model-recovery-unlock-confirmed-spinner"
              decorative
            />
          )}
          {MODEL_LIBRARY_UNLOCK_COPY.confirmed}
        </span>,
        renderCancel('Close'),
      );
    }

    // The poll stopped. That is all it means: the payment may still be in
    // progress, so nothing here calls it failed.
    if (unlockPhase === 'timed-out') {
      return shell(
        MODEL_LIBRARY_UNLOCK_COPY.title,
        <span role="status" data-testid="model-recovery-unlock-timed-out">
          We stopped checking for your payment. Check again once it completes,
          or reopen checkout.
        </span>,
        <>
          {checkAgainButton(true)}
          <button
            type="button"
            data-testid="model-recovery-unlock-reopen"
            onClick={handleUnlockPurchase}
            className="w-full rounded-md border border-line-base px-3 py-1.5 text-s fg-primary transition hover:bg-subtle"
          >
            Reopen checkout
          </button>
          {renderCancel('Close')}
        </>,
      );
    }

    if (unlockAttempt.status === 'opened') {
      return shell(
        MODEL_LIBRARY_UNLOCK_COPY.title,
        <span role="status" data-testid="model-recovery-unlock-waiting">
          {MODEL_LIBRARY_UNLOCK_COPY.waitingInBrowser}
        </span>,
        <>
          {/* Offered only while the desktop is following this purchase. An
              organization-owned one cannot be read back, so a re-check there
              would be a button that can never report success. */}
          {unlockPhase === 'waiting' ? checkAgainButton(false) : null}
          {/* Closing does not cancel: the purchase is in the browser, and the
              pending model is still applied when it completes. */}
          {renderCancel('Close')}
        </>,
      );
    }

    return shell(
      MODEL_LIBRARY_UNLOCK_COPY.title,
      <span data-testid="model-recovery-unlock" className="flex flex-col gap-2">
        <span>{MODEL_LIBRARY_UNLOCK_COPY.purchaseBody}</span>
        {unlockAttempt.status === 'failed' ? (
          <span
            role="alert"
            className="fg-destructive"
            data-testid="model-recovery-unlock-failed"
          >
            We couldn’t open your browser. Try again.
          </span>
        ) : null}
      </span>,
      <>
        {purchaseButton(MODEL_LIBRARY_UNLOCK_COPY.purchaseAction)}
        {renderCancel(MODEL_LIBRARY_UNLOCK_COPY.dismissAction)}
      </>,
    );
  }

  // ---- Read failed / inconclusive. Try again, sign-in for case A, NO purchase.
  if (read.status === 'inconclusive') {
    return shell(
      modelLabel,
      <span data-testid="model-recovery-inconclusive">
        {`We couldn't check your ${brandText.appName} account just now, so we don't know what's available for ${modelLabel}.`}
      </span>,
      <>
        {renderRetry()}
        {renderSignIn()}
        {renderCancel()}
      </>,
    );
  }

  // Pass the lapsed names IN: the helper only ever echoes back what it is
  // given, and it is what clears them again when the user can still spend.
  const coverage = resolveAiCreditsCoverage(read.availability, read.lapsedOrgs);
  const creditsLabel = `Get AI Credits`;
  // Case C: the user is switching this chat's billing mode, not unlocking a
  // model. Copy that names the model as the thing needing credits is wrong.
  const billingModeIntent = pending.intent === 'enable-ai-credits';

  // ---- Native-only model with no provider login. Credits cannot route this
  // model at all, so offering a purchase would sell the user something that
  // does not unblock them. Sign-in is the ONLY exit.
  //
  // Checked BEFORE the guest branch on purpose. That branch offers
  // free-starting-credits framing and commits on coverage, which for a
  // native-only model is a promise AI Credits can never keep — a guest would
  // be told "new accounts start with free AI Credits" about a model those
  // credits cannot pay for, and (once signed in) have it committed anyway.
  if (!creditsCanRunPendingModel && signInProvider) {
    return shell(
      modelLabel,
      <span data-testid="model-recovery-native-only">
        {`This model runs on your ${getProviderLabel(signInProvider)} subscription — ${brandText.appName} AI Credits can't pay for it. Sign in to ${getProviderLabel(signInProvider)} to use it.`}
      </span>,
      <>
        {renderSignIn()}
        {renderCancel()}
      </>,
    );
  }

  // ---- Opted out of the daily free-credit drip. Turning it on is the cheapest
  // way out and works for guests too, so it leads; buying stays secondary and
  // only where purchasing is possible (never for guests). Case A keeps provider
  // sign-in alongside, never instead, and case C keeps its billing-mode copy.
  // Only an EXPLICIT `false` qualifies: an older server omits the field, and
  // that keeps the branches below unchanged.
  if (
    read.connected &&
    (read.availability.dailyDripEnabled === false || dailyDrip === 'saved')
  ) {
    const canBuy = !read.guest && coverage.showPurchase;
    if (dailyDrip === 'saved') {
      return shell(
        modelLabel,
        <span data-testid="model-recovery-daily-credits-saved" role="status">
          {`Your free daily credits start tomorrow.${canBuy ? ' You can also buy credits now.' : ''}`}
        </span>,
        <>
          {canBuy ? (
            <GetAiCreditsCta
              label={creditsLabel}
              onCovered={handleCoveredFromCta}
              // Billing opened inside Settings: close so the dialog does not sit
              // above the page the user just asked for (CAN-4691). This is a
              // plain Cancel by design: the current model stays, and the user
              // picks the new one again after buying. Its focus restore runs a
              // frame later, after the Settings render has made the composer
              // inert, so it does not pull focus behind Settings.
              onOpenedInApp={onCancel}
              dataTestId="model-recovery-get-credits"
            />
          ) : null}
          {renderSignIn()}
          {renderCancel(canBuy || signInProvider ? 'Cancel' : 'Close')}
        </>,
      );
    }
    const turnOnBusy = dailyDrip === 'busy';
    return shell(
      modelLabel,
      <span
        data-testid="model-recovery-daily-credits"
        className="flex flex-col gap-2"
      >
        <span>
          {signInProvider
            ? `To use ${modelLabel}, sign in to ${getProviderLabel(signInProvider)} or turn on free daily credits.`
            : billingModeIntent
              ? 'Turn on free daily credits to bill this chat to AI Credits instead of your subscription.'
              : `${modelLabel} runs on AI Credits. Turn on free daily credits to start using it.`}
        </span>
        {dailyDrip === 'error' ? (
          <span
            role="alert"
            className="fg-destructive"
            data-testid="model-recovery-daily-credits-error"
          >
            Couldn't save. Try again.
          </span>
        ) : null}
      </span>,
      <>
        <button
          type="button"
          data-testid="model-recovery-turn-on-daily-credits"
          disabled={turnOnBusy}
          onClick={handleTurnOnDailyDrip}
          className={`flex w-full items-center justify-center gap-1.5 ${ACCOUNT_BUTTON_PRIMARY}`}
        >
          {turnOnBusy && (
            <LoadingSpinner
              dataTestId="model-recovery-turn-on-daily-credits-spinner"
              decorative
            />
          )}
          Turn on free daily credits
        </button>
        {canBuy ? (
          <GetAiCreditsCta
            label={creditsLabel}
            onCovered={handleCoveredFromCta}
            onOpenedInApp={onCancel}
            dataTestId="model-recovery-get-credits"
            buttonClassName="flex w-full items-center justify-center gap-1.5 rounded-md border border-line-base px-3 py-1.5 text-s fg-primary transition hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
          />
        ) : null}
        {renderSignIn()}
        {renderCancel()}
      </>,
    );
  }

  // ---- Guest / not connected. Free-credits framing, NOT purchase-first
  // (CAN-1929): a guest who has never signed in gets credits by signing in, so
  // leading with a purchase is both wrong and a worse offer.
  if (read.guest) {
    return shell(
      modelLabel,
      <span data-testid="model-recovery-guest">
        {`Sign in to your ${brandText.appName} account to use ${modelLabel}.`}
      </span>,
      <>
        <GetAiCreditsCta
          label={`Sign in to use ${modelLabel}`}
          onCovered={handleCoveredFromCta}
          onOpenedInApp={onCancel}
          {...(aiCreditsScope ? { aiCreditsScope } : {})}
          dataTestId="model-recovery-get-credits"
        />
        {renderSignIn()}
        {renderCancel()}
      </>,
    );
  }

  // ---- Org member whose org has the credit pool but no headroom. They cannot
  // self-serve, so there is NO purchase CTA — but this must not be a dead-end
  // modal either: headroom can be granted while it is open, so Try again stays.
  if (coverage.showContactAdmin || coverage.lapsedOrgNames.length > 0) {
    const lapsed = coverage.lapsedOrgNames.length > 0;
    const ownerOrganizationName =
      read.status === 'settled'
        ? read.availability.ownerOrganization?.name
        : undefined;
    return shell(
      modelLabel,
      <span data-testid="model-recovery-contact-admin">
        {ownerOrganizationName ? (
          <span data-testid="model-recovery-contact-admin-org">
            {`${ownerOrganizationName}'s AI Credits balance can't cover this model right now. `}
          </span>
        ) : (
          `Your organization's AI Credits balance can't cover this model right now. `
        )}
        {lapsed ? CONTACT_ORG_ADMIN_LAPSED_COPY : CONTACT_ORG_ADMIN_COPY}
      </span>,
      <>
        {renderRetry()}
        {renderSignIn()}
        {renderCancel()}
      </>,
    );
  }

  // ---- Ordinary self-serve. Case A offers provider sign-in ALONGSIDE credits,
  // never instead; case B never offers it (a gateway-only model can never bill
  // to a subscription, so "sign in to Claude" would not unblock anything).
  return shell(
    modelLabel,
    <span data-testid="model-recovery-purchase">
      {signInProvider
        ? `To use ${modelLabel}, sign in to ${getProviderLabel(signInProvider)} or add ${brandText.appName} AI Credits.`
        : billingModeIntent
          ? // Case C escalation: nothing is wrong with `modelLabel` — the user
            // asked to bill this chat to credits and has none to bill to.
            `Add ${brandText.appName} AI Credits to bill this chat to them instead of your subscription.`
          : `This model runs on ${brandText.appName} AI Credits. Add credits to start using it.`}
    </span>,
    <>
      <GetAiCreditsCta
        label={
          coverage.showPurchase
            ? creditsLabel
            : billingModeIntent
              ? 'Bill this chat to AI Credits'
              : `Use ${modelLabel}`
        }
        onCovered={handleCoveredFromCta}
        onOpenedInApp={onCancel}
        {...(aiCreditsScope ? { aiCreditsScope } : {})}
        dataTestId="model-recovery-get-credits"
      />
      {renderSignIn()}
      {renderCancel()}
    </>,
  );
}
