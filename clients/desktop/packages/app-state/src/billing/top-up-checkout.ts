// ---------------------------------------------------------------------------
// One top-up checkout, from the amount to confirmed model-library access.
//
// Kept apart from the dialog and from Stripe on purpose: this is the open /
// intent / attempt state, and the dialog is only what draws it. Everything it
// needs from the outside (the charge request, Stripe authentication, the
// owner-scoped access read) arrives through the host's billing adapter.
//
// Three facts stay separate here because the server reports them separately:
// the payment settled, the credits arrived, and the owner's model library is
// unlocked. A settled payment is never reported as an unlock, and a slow
// refresh is never a reason to offer the pay button again.
// ---------------------------------------------------------------------------

import type {
  BillingTopUpResponse,
  ModelLibraryUnlockSource,
} from '@canopy/protocol/billing';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import { BILLING_NO_SAVED_CARD_CODE as NO_SAVED_CARD_CODE } from '@canopy/protocol/billing';
import {
  BILLING_TOP_UP_MIN_USD,
  BILLING_TOP_UP_MAX_USD,
  isBillingRequestId,
  isModelLibraryUnlockSource,
} from '@canopy/protocol/billing';
import { createStore } from 'zustand/vanilla';

export type TopUpCheckoutStatus =
  /** Choosing an amount; the pay button is live. */
  | 'editing'
  | 'submitting'
  /** The owner has no saved card; the card form replaces the amount. */
  | 'needs_card'
  /** The card issuer asked for authentication. */
  | 'authenticating'
  /** The provider accepted the payment and has not settled it yet. */
  | 'processing'
  /** Payment settled; reading the owner's access. */
  | 'confirming_access'
  /** Payment settled; access had not updated within the bounded poll. */
  | 'access_delayed'
  | 'confirming_credits'
  | 'credits_delayed'
  | 'complete';

export interface TopUpCheckoutState {
  readonly status: TopUpCheckoutStatus;
  readonly error: string | null;
  /** The server confirmed the payment settled. */
  readonly paid: boolean;
  readonly creditsAvailable: boolean;
  /** The owner-scoped refetch answered `unlocked` after this payment. */
  readonly unlocked: boolean;
  /** What the server charged, once it has said. */
  readonly totalChargeUsd: number | null;
}

export interface TopUpChargeInput {
  readonly amountUsd: number;
  readonly requestId: string;
  readonly source?: ModelLibraryUnlockSource;
}

export type TopUpAuthentication =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface TopUpCheckoutDeps {
  readonly contextKey?: string;
  readonly reason: 'credits' | 'unlock_models';
  readonly source?: ModelLibraryUnlockSource;
  /** Owner/account-bound journal; stores no provider or card secrets. */
  readonly attemptStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Charge the owner this checkout was opened for. */
  readonly topUp: (input: TopUpChargeInput) => Promise<BillingTopUpResponse>;
  /** Complete issuer authentication for a payment that asked for it. */
  readonly authenticate: (clientSecret: string) => Promise<TopUpAuthentication>;
  /** The owner's access, refetched; `undefined` when it cannot be read. */
  readonly fetchAccess?: () => Promise<ModelLibraryAccess | undefined>;
  readonly newRequestId: () => string;
  readonly wait: (ms: number) => Promise<void>;
  /** The server confirmed the payment. Fires once. */
  readonly onPaid?: () => void;
  /** The refetch answered `unlocked`. Fires once. */
  readonly onUnlocked?: () => void;
}

/** How many times access is read after a settled payment before stopping. */
export const TOP_UP_ACCESS_POLL_ATTEMPTS = 6;
export const TOP_UP_ACCESS_POLL_INTERVAL_MS = 1500;

export const TOP_UP_ERROR = 'Unable to complete purchase.';
/**
 * A charge the card issuer refused (HTTP 402). Local copy: the route's own
 * decline text is never shown.
 */
export const BILLING_CARD_DECLINED_ERROR =
  'The card was declined. Use a different card or contact the card issuer.';
const INCOMPLETE_ERROR = 'The payment did not complete. Try again.';

const INITIAL_STATE: TopUpCheckoutState = {
  status: 'editing',
  error: null,
  paid: false,
  creditsAvailable: false,
  unlocked: false,
  totalChargeUsd: null,
};

type TopUpFailure =
  | { readonly kind: 'missing_card' }
  /** No charge was made and the attempt is spent: the next try is a new one. */
  | { readonly kind: 'final'; readonly message: string }
  /** The outcome is unknown: the next try must repeat the same attempt. */
  | { readonly kind: 'unknown'; readonly message: string };

function readStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null;
  }
  return typeof error.status === 'number' ? error.status : null;
}

/**
 * The route's `{ error }` text. Settings API errors keep it out of their
 * message, as the log-only `serverDetail`; the top-up route sends its
 * `no_saved_card` code there.
 */
function readServerDetail(error: unknown): string | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('serverDetail' in error)
  ) {
    return null;
  }
  return typeof error.serverDetail === 'string' ? error.serverDetail : null;
}

/**
 * What a rejected charge request means for the attempt. Only a response the
 * server actually gave is final; a network failure or a 5xx may have reached
 * the provider, so it keeps its request id and the retry cannot charge twice.
 */
export function classifyTopUpError(error: unknown): TopUpFailure {
  const status = readStatus(error);
  // The `no_saved_card` code arrives as the route's `{ error }` text: the
  // log-only `serverDetail` on settings API errors, the message on others.
  // It is matched, never shown.
  const code =
    readServerDetail(error) ??
    (error instanceof Error ? error.message : undefined);
  if (status === 409 && code === NO_SAVED_CARD_CODE) {
    return { kind: 'missing_card' };
  }
  if (status !== null && status >= 400 && status < 500 && status !== 409) {
    // Final, and shown with local copy: the route's text never reaches the UI.
    return {
      kind: 'final',
      message: status === 402 ? BILLING_CARD_DECLINED_ERROR : TOP_UP_ERROR,
    };
  }
  return { kind: 'unknown', message: TOP_UP_ERROR };
}

export class TopUpCheckout {
  private readonly store = createStore<TopUpCheckoutState>(() => ({
    ...INITIAL_STATE,
  }));
  private get state(): TopUpCheckoutState {
    return this.store.getState();
  }
  /** The payment attempt in hand: one request id for one amount. */
  private attempt: {
    amountCents: number;
    requestId: string;
    source?: ModelLibraryUnlockSource;
  } | null = null;
  private amountUsd: number | null = null;
  private busy = false;
  private closed = false;
  /** Bumped on close, so an answer still in flight finds nobody to tell. */
  private generation = 0;

  constructor(private deps: TopUpCheckoutDeps) {
    this.restoreAttempt();
  }

  private get storageKey(): string | null {
    return this.deps.contextKey === undefined
      ? null
      : `billing-top-up-attempt:${this.deps.contextKey}`;
  }

  private restoreAttempt(): void {
    const key = this.storageKey;
    if (key === null || !this.deps.attemptStorage) return;
    // A corrupt journal must not silently offer another payment. The owner
    // can reconcile in billing history before clearing the tab's storage.
    try {
      const saved = this.deps.attemptStorage.getItem(key);
      if (saved === null) return;
      const value: unknown = JSON.parse(saved);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('version' in value) ||
        value.version !== 1 ||
        !('amountCents' in value) ||
        typeof value.amountCents !== 'number' ||
        !Number.isInteger(value.amountCents) ||
        value.amountCents < BILLING_TOP_UP_MIN_USD * 100 ||
        value.amountCents > BILLING_TOP_UP_MAX_USD * 100 ||
        !('requestId' in value) ||
        !isBillingRequestId(value.requestId) ||
        ('source' in value && !isModelLibraryUnlockSource(value.source))
      )
        throw new Error('Invalid payment attempt');
      this.attempt = {
        amountCents: value.amountCents,
        requestId: value.requestId,
        ...('source' in value && isModelLibraryUnlockSource(value.source)
          ? { source: value.source }
          : {}),
      };
      this.amountUsd = value.amountCents / 100;
      this.set({ status: 'processing' });
    } catch {
      this.set({
        status: 'processing',
        error: 'Check billing history before starting another purchase.',
      });
    }
  }

  private clearStoredAttempt(): void {
    const key = this.storageKey;
    try {
      if (key !== null) this.deps.attemptStorage?.removeItem(key);
    } catch {
      // Retaining a reconciled journal can only cause another status read.
    }
  }

  private clearAttempt(): void {
    this.clearStoredAttempt();
    this.attempt = null;
  }

  /**
   * Swap in the host's current dependencies. A host re-renders with fresh
   * closures while one checkout lives; the attempt, and so its request id,
   * stays this checkout's own.
   */
  setDeps(deps: TopUpCheckoutDeps): void {
    const changedOwner = this.deps.contextKey !== deps.contextKey;
    const interruptedRead =
      this.closed &&
      !changedOwner &&
      this.attempt !== null &&
      this.state.status === 'submitting';
    if (changedOwner) {
      this.close();
      this.attempt = null;
      this.amountUsd = null;
      this.store.setState({ ...INITIAL_STATE }, true);
    }
    this.deps = deps;
    this.closed = false;
    if (changedOwner) this.restoreAttempt();
    // Effect replay invalidated the first read; reconcile its durable ID.
    else if (interruptedRead) this.set({ status: 'processing' });
  }

  readonly getState = (): TopUpCheckoutState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    return this.store.subscribe(listener);
  };

  /** Whether a request is out. The dialog must not close or resubmit then. */
  get inFlight(): boolean {
    return this.busy;
  }

  /**
   * Abandon this checkout. Nothing in flight may change its state or call
   * back afterwards; a payment the server already took still settles there
   * and is found by the next access or balance read.
   */
  close(): void {
    this.closed = true;
    this.generation += 1;
    this.busy = false;
  }

  /** Pay `amountUsd`. A second call while one is out does nothing. */
  submit(amountUsd: number): void {
    if (this.busy || this.state.paid || this.state.status !== 'editing') return;
    this.amountUsd = amountUsd;
    void this.run(this.charge(amountUsd, false));
  }

  /** The card form saved a card: repeat the attempt it interrupted. */
  cardSaved(): void {
    const { amountUsd } = this;
    if (
      this.busy ||
      this.state.paid ||
      this.state.status !== 'needs_card' ||
      amountUsd === null
    )
      return;
    void this.run(this.charge(amountUsd, false));
  }

  /** Leave the card form without saving, back to the amount. */
  cancelCard(): void {
    if (this.busy || this.state.status !== 'needs_card') return;
    this.set({ status: 'editing', error: null });
  }

  /**
   * Ask again about a payment the provider was still processing. Repeats the
   * same request id, which the server answers from the existing payment.
   */
  recheckPayment(): void {
    const { amountUsd } = this;
    if (this.busy || this.state.status !== 'processing' || amountUsd === null) {
      return;
    }
    void this.run(this.charge(amountUsd, false, true));
  }

  /** Read access again after the bounded poll gave up. Never charges. */
  recheckAccess(): void {
    if (this.busy || this.state.status !== 'access_delayed') return;
    void this.run(this.confirmAccess());
  }

  /**
   * Something outside (a realtime hint, a return to the tab) suggests the
   * owner's state moved. It is only a reason to read again.
   */
  refresh(): void {
    if (this.state.status === 'access_delayed') this.recheckAccess();
    else if (this.state.status === 'credits_delayed')
      void this.run(this.confirmCredits());
    else if (this.state.status === 'processing') this.recheckPayment();
  }

  private set(patch: Partial<TopUpCheckoutState>): void {
    this.store.setState(patch);
  }

  private async run(
    step: (alive: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (this.closed) return;
    const generation = this.generation;
    const alive = (): boolean => generation === this.generation;
    this.busy = true;
    try {
      await step(alive);
    } finally {
      if (alive()) this.busy = false;
    }
  }

  private requestIdFor(amountUsd: number): string {
    const amountCents = Math.round(amountUsd * 100);
    if (this.attempt === null || this.attempt.amountCents !== amountCents) {
      const attempt = {
        amountCents,
        requestId: this.deps.newRequestId(),
        ...(this.deps.source === undefined ? {} : { source: this.deps.source }),
      };
      this.attempt = attempt;
    }
    const key = this.storageKey;
    if (key !== null)
      this.deps.attemptStorage?.setItem(
        key,
        JSON.stringify({ version: 1, ...this.attempt }),
      );
    return this.attempt.requestId;
  }

  private charge(
    amountUsd: number,
    authenticated: boolean,
    rechecking = false,
  ): (alive: () => boolean) => Promise<void> {
    return async (alive) => {
      this.set({ status: 'submitting', error: null });
      let requestId: string;
      try {
        requestId = this.requestIdFor(amountUsd);
      } catch {
        this.set({ status: 'editing', error: TOP_UP_ERROR });
        return;
      }
      let response: BillingTopUpResponse;
      try {
        response = await this.deps.topUp({
          amountUsd,
          requestId,
          ...(this.attempt?.source === undefined
            ? {}
            : { source: this.attempt.source }),
        });
      } catch (error) {
        if (!alive()) return;
        const failure = classifyTopUpError(error);
        if (failure.kind === 'missing_card') {
          if (authenticated || rechecking) {
            this.set({
              status: 'processing',
              error: authenticated ? null : TOP_UP_ERROR,
            });
            return;
          }
          // This fresh request made no payment. Keep its ID for an explicit
          // save-and-pay in this form, but reopening must offer the pay button.
          this.clearStoredAttempt();
          this.set({ status: 'needs_card', error: null });
          return;
        }
        if (authenticated || (rechecking && readStatus(error) !== 402)) {
          // A refused status read cannot establish whether the earlier charge
          // settled. Keep the attempt until the provider reports a conclusive
          // outcome; retrying authorization must not create another payment.
          this.set({
            status: 'processing',
            error: authenticated ? null : failure.message,
          });
          return;
        }
        if (failure.kind === 'unknown') {
          this.set({ status: 'processing', error: failure.message });
          return;
        }
        this.clearAttempt();
        this.set({ status: 'editing', error: failure.message });
        return;
      }
      if (!alive()) return;
      await this.settle(response, amountUsd, authenticated, alive);
    };
  }

  private async settle(
    response: BillingTopUpResponse,
    amountUsd: number,
    authenticated: boolean,
    alive: () => boolean,
  ): Promise<void> {
    if (response.status === 'succeeded') {
      const firstSettlement = !this.state.paid;
      this.set({
        paid: true,
        totalChargeUsd: response.totalChargeUsd,
        creditsAvailable: response.creditsAvailable === true,
      });
      if (firstSettlement) this.deps.onPaid?.();
      if (this.deps.reason !== 'unlock_models' || !this.deps.fetchAccess) {
        if (this.state.creditsAvailable) {
          this.clearAttempt();
          this.set({ status: 'complete' });
        } else await this.confirmCredits()(alive);
        return;
      }
      await this.confirmAccess()(alive);
      return;
    }
    if (response.status === 'processing') {
      this.set({
        status: 'processing',
        totalChargeUsd: response.totalChargeUsd,
      });
      return;
    }
    if (
      !authenticated &&
      response.clientSecret !== undefined &&
      (response.status === 'requires_action' ||
        response.status === 'requires_confirmation')
    ) {
      this.set({ status: 'authenticating' });
      let result: TopUpAuthentication;
      try {
        result = await this.deps.authenticate(response.clientSecret);
      } catch {
        result = { ok: false, message: INCOMPLETE_ERROR };
      }
      if (!alive()) return;
      if (!result.ok) {
        // The issuer/browser response cannot prove no payment settled.
        // Keep the PaymentIntent and retrieve it before another charge.
        this.set({ status: 'processing', error: result.message });
        return;
      }
      // Same request id: the server reads the payment it already made.
      await this.charge(amountUsd, true)(alive);
      return;
    }
    if (
      response.status === 'requires_action' ||
      response.status === 'requires_confirmation' ||
      response.status === 'requires_capture'
    ) {
      this.set({ status: 'processing', error: INCOMPLETE_ERROR });
      return;
    }
    this.clearAttempt();
    this.set({ status: 'editing', error: INCOMPLETE_ERROR });
  }

  private confirmAccess(): (alive: () => boolean) => Promise<void> {
    return async (alive) => {
      const { fetchAccess } = this.deps;
      if (!fetchAccess) return;
      this.set({ status: 'confirming_access', error: null });
      for (let attempt = 0; attempt < TOP_UP_ACCESS_POLL_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await this.deps.wait(TOP_UP_ACCESS_POLL_INTERVAL_MS);
          if (!alive()) return;
        }
        let access: ModelLibraryAccess | undefined;
        try {
          access = await fetchAccess();
        } catch {
          access = undefined;
        }
        if (!alive()) return;
        if (access === 'unlocked') {
          const firstUnlock = !this.state.unlocked;
          this.set({ unlocked: true });
          if (firstUnlock) this.deps.onUnlocked?.();
          if (!alive()) return;
          if (this.state.creditsAvailable) {
            this.clearAttempt();
            this.set({ status: 'complete' });
          } else await this.confirmCredits()(alive);
          return;
        }
      }
      this.set({ status: 'access_delayed' });
    };
  }

  private confirmCredits(): (alive: () => boolean) => Promise<void> {
    return async (alive) => {
      if (this.amountUsd === null || this.attempt === null) return;
      this.set({ status: 'confirming_credits', error: null });
      for (let poll = 0; poll < TOP_UP_ACCESS_POLL_ATTEMPTS; poll++) {
        if (poll > 0) {
          await this.deps.wait(TOP_UP_ACCESS_POLL_INTERVAL_MS);
          if (!alive()) return;
        }
        try {
          const response = await this.deps.topUp({
            amountUsd: this.amountUsd,
            requestId: this.attempt.requestId,
            ...(this.attempt.source === undefined
              ? {}
              : { source: this.attempt.source }),
          });
          if (!alive()) return;
          if (
            response.status === 'succeeded' &&
            response.creditsAvailable === true
          ) {
            this.set({ creditsAvailable: true, status: 'complete' });
            this.clearAttempt();
            return;
          }
        } catch {
          if (!alive()) return;
        }
      }
      this.set({ status: 'credits_delayed' });
    };
  }
}
