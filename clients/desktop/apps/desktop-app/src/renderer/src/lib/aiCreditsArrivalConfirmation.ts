import { create } from 'zustand';
import { cloudAccountIdentityKey } from '@canopy/desktop-shared/lib/guest-account';
import type {
  AiCreditsScopeRequest,
  CanopyCloudAiCreditsState,
} from '@canopy/desktop-shared/types';
import {
  aiCreditsConfirmationBalanceLoader,
  personalBalanceReading,
  readAiCreditsConfirmationBalance,
  type PersonalBalanceReading,
} from '@/lib/aiCreditsConfirmationBalance';
import type { ChatBannerTarget } from '@/stores/aiCreditsBannerStore';

/**
 * The arrival confirmation after credits bought from a chat banner: the
 * usage-limit banner or the No billing source banner (CAN-5160).
 *
 * Presentation state in renderer memory only. A browser hand-off is tracked
 * from the Get AI Credits click; the first covered return of a hand-off that
 * opened the browser records ONE confirmation for its chat. The notice reads
 * the personal balance again and names the observed increase when a
 * comparable baseline was read before the browser opened.
 *
 * Mirrors the CAN-5027 unlock confirmation's lifecycle: one visible record,
 * hand-off ids remembered for the account session so a duplicate return
 * cannot revive a dismissed record, and the whole session dropped on
 * sign-out or an account switch. An observed increase is a balance change,
 * never a purchase receipt.
 *
 * Buying from a chat is consent to spend the credits there (CAN-5159). Once
 * the banner routes that chat through credits, the record is marked `routed`:
 * the notice never shows it again, and the "Using AI Credits" card shows its
 * evidence until the first credits turn starts or the user switches back.
 *
 * Each record names the banner that started it, and only that banner shows
 * it. A newer hand-off from either banner still supersedes the other's record
 * for the chat: there is one visible record.
 */

/**
 * The surface whose Get AI Credits click started the hand-off. `model-picker`
 * covers the picker's billing toggle and the recovery dialog it opens; they
 * have no notice of their own, so the No billing source banner, which every
 * composer mounts, confirms their purchases too.
 */
export type AiCreditsArrivalOrigin =
  | 'usage-limit'
  | 'no-billing-source'
  | 'model-picker';

type WorkScope = Readonly<Extract<AiCreditsScopeRequest, { kind: 'work' }>>;

export interface AiCreditsArrival {
  readonly handoffId: string;
  readonly accountId: string;
  /** The chat the hand-off started in; the notice shows only there. */
  readonly chatId: string;
  readonly scope: WorkScope;
  /** The banner that started the hand-off; only it shows the record. */
  readonly origin: AiCreditsArrivalOrigin;
}

/**
 * What the balance reads established. `final` is false while reads are still
 * running; the notice shows generic availability until then.
 */
export interface AiCreditsArrivalEvidence {
  readonly handoffId: string;
  readonly final: boolean;
  readonly addedCredits: number | null;
  readonly balanceCredits: number | null;
}

interface AiCreditsArrivalState {
  readonly accountReady: boolean;
  readonly arrival: AiCreditsArrival | null;
  readonly evidence: AiCreditsArrivalEvidence | null;
  /** The banner routed the record's chat through credits; card only. */
  readonly routed: boolean;
}

export const useAiCreditsArrivalStore = create<AiCreditsArrivalState>(() => ({
  accountReady: true,
  arrival: null,
  evidence: null,
  routed: false,
}));

/** Read offsets from the first attempt's start. Never overlapping. */
export const AI_CREDITS_ARRIVAL_READ_OFFSETS_MS = [0, 1_500, 4_000] as const;
/**
 * A read that has not answered by then ends the budget rather than starting
 * another request beside it, so a hung bridge still reaches a final title.
 */
export const AI_CREDITS_ARRIVAL_READ_TIMEOUT_MS = 4_000;

type PersonalReading = PersonalBalanceReading;

type BaselineState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly reading: PersonalReading };

interface QueuedArrival {
  readonly arrival: AiCreditsArrival;
  readonly baseline: PersonalReading | null;
  readonly seq: number;
  readonly sessionGeneration: number;
}

/**
 * The account this session's records belong to. `undefined` until a
 * hand-off or account read establishes it; `null` once signed out.
 */
let sessionAccountKey: string | null | undefined;
/** Bumped whenever the account session ends; fences every async result. */
let sessionGeneration = 0;
let handoffSeq = 0;
/** Identifying hand-offs also need account-change fencing before a key exists. */
const identifyingHandoffs = new Set<string>();
/** Every hand-off recorded in this account session, dismissed or not. */
const seenHandoffIds = new Set<string>();
/** The visible record's sequence; a lower one can never replace it. */
let visibleSeq = 0;
/** A record made while the account was being rechecked. At most one. */
let queued: QueuedArrival | null = null;

interface BalanceRun {
  readonly handoffId: string;
  readonly sessionGeneration: number;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

let balanceRun: BalanceRun | null = null;
/** A final answer read while the account was being rechecked. */
let heldEvidence: AiCreditsArrivalEvidence | null = null;
let heldGeneration = -1;

/** Resolves `null` after `ms` unless cancelled first. */
function readDeadline(ms: number): {
  readonly promise: Promise<null>;
  readonly cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout((): void => resolve(null), ms);
  });
  return {
    promise,
    cancel: (): void => {
      if (timer !== null) clearTimeout(timer);
    },
  };
}

function cancelBalanceRun(): void {
  if (balanceRun === null) return;
  balanceRun.cancelled = true;
  if (balanceRun.timer !== null) clearTimeout(balanceRun.timer);
  balanceRun = null;
}

const personalReading = personalBalanceReading;

/**
 * The daily drip this read minted: a finite, nonnegative amount, `0` when
 * none was granted, or `null` when a grant is reported without one.
 */
function dripGranted(response: CanopyCloudAiCreditsState): number | null {
  const balance = response.balance;
  if (balance?.dailyDripOutcome !== 'granted') return 0;
  const granted = balance.dailyDripGrantedCredits;
  return typeof granted === 'number' && Number.isFinite(granted) && granted >= 0
    ? granted
    : null;
}

function isCurrentSession(generation: number): boolean {
  return generation === sessionGeneration;
}

function publishEvidence(evidence: AiCreditsArrivalEvidence): void {
  const state = useAiCreditsArrivalStore.getState();
  if (state.arrival?.handoffId !== evidence.handoffId) return;
  const previous = state.evidence;
  if (
    previous?.handoffId === evidence.handoffId &&
    previous.final === evidence.final &&
    previous.addedCredits === evidence.addedCredits &&
    previous.balanceCredits === evidence.balanceCredits
  )
    return;
  useAiCreditsArrivalStore.setState({ evidence });
}

/**
 * Read the balance for the visible record: immediately, then at
 * {@link AI_CREDITS_ARRIVAL_READ_OFFSETS_MS}, one request at a time. Ends
 * early only on a reliable positive increase, organization funding, or a
 * positive balance with no baseline to compare. A stale or unchanged balance
 * keeps reading; at the end the best valid fallback stands.
 *
 * The budget is spent once per hand-off. Reads keep running while the account
 * is rechecked, but nothing they find shows until the same session returns.
 */
function startBalanceRun(
  handoffId: string,
  scope: WorkScope,
  baseline: PersonalReading | null,
): void {
  cancelBalanceRun();
  const run: BalanceRun = {
    handoffId,
    sessionGeneration,
    cancelled: false,
    timer: null,
  };
  balanceRun = run;
  const load = aiCreditsConfirmationBalanceLoader();
  const isLive = (): boolean =>
    !run.cancelled &&
    balanceRun === run &&
    isCurrentSession(run.sessionGeneration) &&
    useAiCreditsArrivalStore.getState().arrival?.handoffId === handoffId;

  let attempts = 0;
  let firstStartedAt: number | null = null;
  // The contract identifies a grant minted during a read, but has no grant
  // id. Retain one adjustment; repeated grant reports are ambiguous rather
  // than evidence of multiple grants to accumulate.
  let grantedSinceBaseline = 0;
  let grantReported = baseline?.reportedGrant ?? false;
  let grantAmbiguous = false;
  let bestBalance: number | null = null;

  const finish = (
    addedCredits: number | null,
    balanceCredits: number | null,
  ): void => {
    if (!isLive()) return;
    const evidence: AiCreditsArrivalEvidence = {
      handoffId,
      final: true,
      addedCredits,
      balanceCredits,
    };
    if (balanceRun === run) balanceRun = null;
    if (!useAiCreditsArrivalStore.getState().accountReady) {
      // Shown only if the recheck returns the same session.
      heldEvidence = evidence;
      heldGeneration = run.sessionGeneration;
      return;
    }
    publishEvidence(evidence);
  };

  const attempt = async (): Promise<void> => {
    if (!isLive()) return;
    if (load === null) {
      finish(null, null);
      return;
    }
    firstStartedAt ??= Date.now();
    attempts++;
    const deadline = readDeadline(AI_CREDITS_ARRIVAL_READ_TIMEOUT_MS);
    const read = await Promise.race([
      readAiCreditsConfirmationBalance(load, scope),
      deadline.promise,
    ]);
    deadline.cancel();
    if (!isLive()) return;
    if (read === null) {
      // Do not stack a request on a hung one: end with what is known.
      finish(null, bestBalance);
      return;
    }
    if (read.outcome === 'definitive') {
      // Organization funding: say only that credits are available.
      finish(null, null);
      return;
    }
    const response = read.response;
    const reading = personalReading(response);
    if (response !== null && reading !== null) {
      const granted = dripGranted(response);
      if (granted === null) grantAmbiguous = true;
      else if (response.balance?.dailyDripOutcome === 'granted') {
        if (grantReported) grantAmbiguous = true;
        else grantedSinceBaseline = granted;
        grantReported = true;
      }
      if (reading.credits > 0) bestBalance = reading.credits;
      if (baseline === null) {
        if (reading.credits > 0) {
          finish(null, reading.credits);
          return;
        }
      } else if (
        !grantAmbiguous &&
        reading.source === baseline.source &&
        reading.email === baseline.email
      ) {
        const added =
          Math.round(
            (reading.credits - baseline.credits - grantedSinceBaseline) * 100,
          ) / 100;
        if (added > 0 && reading.credits > 0) {
          finish(added, reading.credits);
          return;
        }
      }
    }
    if (attempts >= AI_CREDITS_ARRIVAL_READ_OFFSETS_MS.length) {
      finish(null, bestBalance);
      return;
    }
    const offset = AI_CREDITS_ARRIVAL_READ_OFFSETS_MS[attempts] ?? 0;
    const wait = Math.max(
      0,
      (firstStartedAt ?? Date.now()) + offset - Date.now(),
    );
    run.timer = setTimeout((): void => {
      run.timer = null;
      void attempt();
    }, wait);
  };

  useAiCreditsArrivalStore.setState({
    evidence: {
      handoffId,
      final: false,
      addedCredits: null,
      balanceCredits: null,
    },
  });
  void attempt();
}

function commitArrival(entry: QueuedArrival): boolean {
  if (!isCurrentSession(entry.sessionGeneration)) return false;
  if (sessionAccountKey !== entry.arrival.accountId) return false;
  // Initiation order survives dismissal and does not depend on which return
  // completed first. A superseded hand-off can never publish again.
  if (entry.seq !== handoffSeq) return false;
  if (seenHandoffIds.has(entry.arrival.handoffId)) return false;
  // A record from an older hand-off cannot replace a newer one.
  if (
    useAiCreditsArrivalStore.getState().arrival !== null &&
    entry.seq < visibleSeq
  )
    return false;
  seenHandoffIds.add(entry.arrival.handoffId);
  visibleSeq = entry.seq;
  heldEvidence = null;
  useAiCreditsArrivalStore.setState({
    arrival: entry.arrival,
    evidence: null,
    routed: false,
  });
  startBalanceRun(entry.arrival.handoffId, entry.arrival.scope, entry.baseline);
  return true;
}

/**
 * A browser billing hand-off from a chat banner, from the Get
 * credits click to the first covered return. Every method is inert once the
 * hand-off is cancelled, recorded, or its account session ends.
 */
export interface AiCreditsArrivalHandoff {
  readonly handoffId: string;
  /** Whether it can still record (not cancelled, same account session). */
  isLive(): boolean;
  /**
   * Call right before the external open. A baseline still loading then is
   * no longer known to precede the purchase, so it becomes unknown.
   */
  markExternalOpen(): void;
  /** The browser opened. Only a retained hand-off may record. */
  retain(): void;
  /**
   * The first covered completion. Records the arrival (or queues it while
   * the account is rechecked) and ends the hand-off. Call before
   * `announceAiCreditsChanged()`.
   */
  recordCovered(): boolean;
  cancel(): void;
}

let handoffCounter = 0;

/**
 * Start tracking a hand-off for a chat's work scope, reading the baseline
 * balance at once without waiting for it. Null for a scope with no chat, or
 * when this build cannot read the account.
 */
export function beginAiCreditsArrivalHandoff(
  scope: AiCreditsScopeRequest | undefined,
  origin: AiCreditsArrivalOrigin,
): AiCreditsArrivalHandoff | null {
  if (
    scope?.kind !== 'work' ||
    scope.chatId === undefined ||
    scope.chatId === ''
  )
    return null;
  const workScope: WorkScope = { ...scope };
  const chatId = scope.chatId;
  const generation = sessionGeneration;
  const seq = ++handoffSeq;
  const handoffId = `arrival-${Date.now().toString(36)}-${++handoffCounter}`;
  let cancelled = false;
  let retained = false;
  let externalOpened = false;
  let baseline: BaselineState = { kind: 'pending' };
  let accountId: string | null | undefined;
  let coveredWhileIdentifying = false;

  const isLive = (): boolean =>
    !cancelled && isCurrentSession(generation) && seq === handoffSeq;
  const record = (): boolean => {
    if (!isLive() || typeof accountId !== 'string') return false;
    cancelled = true;
    const entry: QueuedArrival = {
      arrival: { handoffId, accountId, chatId, scope: workScope, origin },
      baseline: baseline.kind === 'known' ? baseline.reading : null,
      seq,
      sessionGeneration: generation,
    };
    if (!useAiCreditsArrivalStore.getState().accountReady) {
      if (queued === null || queued.seq < seq) queued = entry;
      return false;
    }
    return commitArrival(entry);
  };

  // Identity: the established session when there is one, else the saved
  // account, which must still be this session when it answers.
  if (
    sessionAccountKey !== undefined &&
    useAiCreditsArrivalStore.getState().accountReady
  ) {
    accountId = sessionAccountKey;
  } else {
    const loadAccount = window.api?.loadCanopyCloudAccount;
    if (typeof loadAccount !== 'function') return null;
    identifyingHandoffs.add(handoffId);
    void loadAccount().then(
      (account): void => {
        identifyingHandoffs.delete(handoffId);
        if (!isLive()) return;
        const key =
          account.read !== undefined && account.read !== 'ok'
            ? null
            : cloudAccountIdentityKey(account);
        if (key === null) {
          cancelled = true;
          return;
        }
        if (sessionAccountKey === undefined) sessionAccountKey = key;
        if (sessionAccountKey !== key) {
          cancelled = true;
          return;
        }
        accountId = key;
        if (coveredWhileIdentifying) record();
      },
      (): void => {
        identifyingHandoffs.delete(handoffId);
        cancelled = true;
      },
    );
  }

  const load = aiCreditsConfirmationBalanceLoader();
  if (load === null) {
    baseline = { kind: 'unknown' };
  } else {
    void readAiCreditsConfirmationBalance(load, workScope).then(
      (read): void => {
        if (!isLive() || baseline.kind !== 'pending') return;
        const reading = personalReading(read.response);
        baseline =
          reading === null || externalOpened
            ? { kind: 'unknown' }
            : { kind: 'known', reading };
      },
    );
  }

  return {
    handoffId,
    isLive,
    markExternalOpen(): void {
      if (!isLive()) return;
      externalOpened = true;
      if (baseline.kind === 'pending') baseline = { kind: 'unknown' };
    },
    retain(): void {
      if (isLive()) retained = true;
    },
    recordCovered(): boolean {
      if (!isLive() || !retained) return false;
      if (accountId === undefined) {
        // Identity is still being read; record once it matches.
        coveredWhileIdentifying = true;
        return false;
      }
      return record();
    },
    cancel(): void {
      cancelled = true;
      identifyingHandoffs.delete(handoffId);
    },
  };
}

/**
 * Clear one record: dismissal, or a credit action the user took from it.
 * Naming the hand-off means a late clear cannot remove a newer record.
 */
export function clearAiCreditsArrival(handoffId: string): void {
  if (useAiCreditsArrivalStore.getState().arrival?.handoffId !== handoffId)
    return;
  cancelBalanceRun();
  heldEvidence = null;
  useAiCreditsArrivalStore.setState({
    arrival: null,
    evidence: null,
    routed: false,
  });
}

/**
 * The banner routed this record's chat through credits. The record leaves
 * the notice for the card; its evidence and any running read stay. Naming
 * the hand-off means a late mark cannot route a newer record.
 */
export function markAiCreditsArrivalRouted(handoffId: string): void {
  const state = useAiCreditsArrivalStore.getState();
  if (state.arrival?.handoffId !== handoffId || state.routed) return;
  useAiCreditsArrivalStore.setState({ routed: true });
}

/** Retire this chat's confirmation before a user action, even while hidden. */
export function clearAiCreditsArrivalForChat(target: ChatBannerTarget): void {
  const { arrival } = useAiCreditsArrivalStore.getState();
  if (arrivalMatchesChat(arrival, target)) {
    clearAiCreditsArrival(arrival.handoffId);
  }
  if (queued !== null && arrivalMatchesChat(queued.arrival, target)) {
    queued = null;
  }
}

/** Hide account-bound state while identity is rechecked. */
export function suspendAiCreditsArrivalAccount(): void {
  // Without an originating identity, an async answer cannot prove it still
  // belongs to the click's account after a notification. Reject it, even if
  // the eventual answer happens to name the newly signed-in account.
  if (sessionAccountKey === undefined && identifyingHandoffs.size > 0) {
    sessionGeneration++;
    identifyingHandoffs.clear();
  }
  useAiCreditsArrivalStore.setState({ accountReady: false });
}

/**
 * Bring records in line with the saved account. The same account restores
 * the record, any queued record, and any answer read meanwhile. Sign-out
 * (`null`), an unreadable account, and a switch end the session: records,
 * reads, pending hand-offs, and seen ids all go.
 */
export function reconcileAiCreditsArrivalAccount(
  accountKey: string | null,
): void {
  const hadSession = sessionAccountKey !== undefined;
  if (sessionAccountKey !== accountKey) {
    sessionAccountKey = accountKey;
    if (hadSession || accountKey === null) {
      sessionGeneration++;
      identifyingHandoffs.clear();
      seenHandoffIds.clear();
      queued = null;
      heldEvidence = null;
      visibleSeq = 0;
      cancelBalanceRun();
      useAiCreditsArrivalStore.setState({
        accountReady: true,
        arrival: null,
        evidence: null,
        routed: false,
      });
      return;
    }
  }
  useAiCreditsArrivalStore.setState({ accountReady: true });
  const held = heldEvidence;
  heldEvidence = null;
  if (held !== null && isCurrentSession(heldGeneration)) publishEvidence(held);
  const next = queued;
  queued = null;
  if (next !== null) commitArrival(next);
}

/** Whether an account change has anything here to reconcile. */
export function hasAiCreditsArrivalSession(): boolean {
  return sessionAccountKey !== undefined || identifyingHandoffs.size > 0;
}

function arrivalMatchesChat(
  arrival: AiCreditsArrival | null,
  target: ChatBannerTarget | null,
): arrival is AiCreditsArrival {
  return (
    target !== null &&
    arrival !== null &&
    arrival.chatId === target.chatId &&
    arrival.scope.projectId === target.projectId &&
    (arrival.scope.worktreeId ?? '') === target.worktreeId
  );
}

/**
 * The unrouted record the notice shows for this complete work identity, or
 * null. A routed record belongs to the card.
 *
 * Only the banner that started the hand-off sees its record: the usage-limit
 * banner marks any record it sees routed and routes the chat, so a No billing
 * source record in the same chat must stay invisible to it, and vice versa.
 */
export function selectAiCreditsArrivalForChat(
  state: AiCreditsArrivalState,
  target: ChatBannerTarget | null,
  origin: AiCreditsArrivalOrigin | readonly AiCreditsArrivalOrigin[],
): AiCreditsArrival | null {
  const origins: readonly AiCreditsArrivalOrigin[] =
    typeof origin === 'string' ? [origin] : origin;
  return state.accountReady &&
    !state.routed &&
    state.arrival !== null &&
    origins.includes(state.arrival.origin) &&
    arrivalMatchesChat(state.arrival, target)
    ? state.arrival
    : null;
}

/** The routed record the card shows for this work identity, or null. */
export function selectRoutedAiCreditsArrivalForChat(
  state: AiCreditsArrivalState,
  target: ChatBannerTarget | null,
): AiCreditsArrival | null {
  return state.accountReady &&
    state.routed &&
    arrivalMatchesChat(state.arrival, target)
    ? state.arrival
    : null;
}

/** The final evidence for exactly this record, or null while reading. */
export function selectAiCreditsArrivalEvidence(
  state: AiCreditsArrivalState,
  handoffId: string | undefined,
): AiCreditsArrivalEvidence | null {
  const { evidence } = state;
  return state.accountReady &&
    evidence !== null &&
    evidence.final &&
    evidence.handoffId === handoffId
    ? evidence
    : null;
}

/** Test-only: resets module state between Jest cases. */
export function resetAiCreditsArrivalForTests(): void {
  cancelBalanceRun();
  sessionAccountKey = undefined;
  sessionGeneration++;
  identifyingHandoffs.clear();
  seenHandoffIds.clear();
  queued = null;
  heldEvidence = null;
  visibleSeq = 0;
  useAiCreditsArrivalStore.setState({
    accountReady: true,
    arrival: null,
    evidence: null,
    routed: false,
  });
}
