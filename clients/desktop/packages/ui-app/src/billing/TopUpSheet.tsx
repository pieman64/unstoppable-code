'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import {
  buildDesktopBillingDeepLink,
  type BillingTopUpIntent,
} from '@canopy/protocol/billing';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import {
  DialogModal,
  MODEL_LIBRARY_UNLOCK_COPY,
} from '@canopy/ui-shared/components';
import { formatCredits } from '@canopy/ui-shared/lib';
import type { BillingClient } from '@canopy/app-core';
import { PaymentMethodCapture } from './PaymentMethodCapture';
import {
  TOP_UP_ERROR,
  TopUpCheckout,
  type TopUpAuthentication,
  type TopUpCheckoutDeps,
  type TopUpCheckoutState,
} from '@canopy/app-state/billing';

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

import {
  BILLING_TOP_UP_MAX_USD as AI_CREDIT_TOP_UP_MAX_USD,
  BILLING_TOP_UP_MIN_USD as AI_CREDIT_TOP_UP_MIN_USD,
  computeTopUpChargeBreakdown,
} from '@canopy/protocol/billing';
import { getBrowserStripe } from './stripe-browser';
import type { BillingPaymentMethodSummary as PaymentMethodSummary } from '@canopy/protocol/billing';

export interface TopUpSheetProps {
  readonly billing: BillingClient;
  readonly contextKey: string;
  readonly feePercent: number;
  readonly appName: string;
  readonly deepLinkScheme: string;
  /** Omit for the personal wallet; present for an org credit pool. */
  orgId?: string;
  /** Stripe publishable key, or `null` when Stripe is unconfigured. */
  publishableKey: string | null;
  /** Mint a SetupIntent for the correct (account vs org) surface. */
  createSetupIntent: () => Promise<{ clientSecret: string }>;
  /** Confirm the saved card for the correct (account vs org) surface. */
  confirmPaymentMethod: (
    setupIntentId: string,
  ) => Promise<PaymentMethodSummary>;
  /**
   * The owner's effective per-credit SALE price (USD), used to preview
   * "you'll receive ~N credits". Omit when unknown; the dialog falls back to
   * the free list price.
   */
  creditPriceUsd?: number;
  /** Prefix for test ids — `''` (account) or `'team-'` (org). */
  testIdPrefix?: string;
  /**
   * Why the dialog opened. It may preselect an amount and change the copy; it
   * never submits a payment, which only the pay button does.
   */
  intent?: BillingTopUpIntent;
  /** The owner's model-library access, refetched. Unlock checkouts only. */
  fetchAccess?: () => Promise<ModelLibraryAccess | undefined>;
  /** Bumped when something suggests the owner's state moved; a hint only. */
  refreshSignal?: number;
  /** The server confirmed the payment: refresh the balance and ledger. */
  onPaid: () => void;
  /** The refetched access answered `unlocked`. */
  onUnlocked?: () => void;
  /** Payment, credits, and any requested library access are confirmed. */
  onComplete?: () => void;
  onClose: () => void;
}

const AMOUNT_CHIPS_USD: readonly number[] = [5, 20, 50, 100];

const AUTHENTICATION_ERROR =
  'Your bank did not confirm the payment. Check its status before trying again.';
const PROCESSING_COPY = 'Your payment is processing. This can take a minute.';
const CONFIRMING_COPY = 'Payment received. Confirming access…';
const ACCESS_DELAYED_COPY =
  "Payment received. Access is taking longer than usual to update. You won't be charged again.";
const PAID_COPY = 'Payment received.';

// Shown in each breakdown value cell before the entered amount is valid. The
// breakdown box renders unconditionally (with these placeholders) so the
// dialog's height stays fixed as the amount crosses the valid/invalid
// threshold — an appearing/disappearing box made the dialog jump while typing.
const BREAKDOWN_PLACEHOLDER = '—';

/** Free / no-plan list price, the fallback when no effective price is known. */
const FREE_LIST_CREDIT_PRICE_USD = 0.6;

const SECONDARY_BUTTON_CLASS =
  'rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:opacity-50';
const PRIMARY_BUTTON_CLASS =
  'rounded-md bg-accent px-3 py-2 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * One dialog's state and callbacks. Reopening the same account/owner restores
 * its unresolved payment identity; closing fences the abandoned callbacks.
 */
function useTopUpCheckout({
  billing,
  contextKey,
  publishableKey,
  intent,
  fetchAccess,
  onPaid,
  onUnlocked,
}: Pick<
  TopUpSheetProps,
  | 'billing'
  | 'contextKey'
  | 'orgId'
  | 'publishableKey'
  | 'intent'
  | 'fetchAccess'
  | 'onPaid'
  | 'onUnlocked'
>): { checkout: TopUpCheckout; state: TopUpCheckoutState } {
  const reason = intent?.reason ?? 'credits';
  const source = intent?.source;
  const deps = useMemo(
    (): TopUpCheckoutDeps => ({
      contextKey,
      reason,
      ...(source === undefined ? {} : { source }),
      topUp: (input) => billing.topUp(input),
      authenticate: async (clientSecret): Promise<TopUpAuthentication> => {
        const stripe =
          publishableKey === null
            ? null
            : await getBrowserStripe(publishableKey);
        if (!stripe) return { ok: false, message: TOP_UP_ERROR };
        const result = await stripe.confirmCardPayment(clientSecret);
        return result.error
          ? {
              ok: false,
              message: result.error.message ?? AUTHENTICATION_ERROR,
            }
          : { ok: true };
      },
      ...(reason === 'unlock_models' && fetchAccess ? { fetchAccess } : {}),
      newRequestId: () => crypto.randomUUID(),
      attemptStorage: {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
        removeItem: (key) => window.sessionStorage.removeItem(key),
      },
      wait,
      onPaid,
      ...(onUnlocked ? { onUnlocked } : {}),
    }),
    [
      billing,
      contextKey,
      fetchAccess,
      onPaid,
      onUnlocked,
      publishableKey,
      reason,
      source,
    ],
  );
  // One checkout for this dialog's life, with an owner-bound attempt journal.
  const [checkout] = useState(() => new TopUpCheckout(deps));
  useEffect(() => {
    checkout.setDeps(deps);
  }, [checkout, deps]);
  useEffect(() => (): void => checkout.close(), [checkout]);
  const state = useSyncExternalStore(
    checkout.subscribe,
    checkout.getState,
    checkout.getState,
  );
  return { checkout, state };
}

/**
 * The AI credits checkout: the amount, the card when one is missing, and what
 * happened to the payment. Shared by the billing pages' "Buy credits" button
 * and by the chat composer's model unlock, which differ only in the intent
 * they open it with.
 */
export function TopUpSheet({
  billing,
  contextKey,
  feePercent,
  appName,
  deepLinkScheme,
  orgId,
  publishableKey,
  createSetupIntent,
  confirmPaymentMethod,
  creditPriceUsd = FREE_LIST_CREDIT_PRICE_USD,
  testIdPrefix = '',
  intent,
  fetchAccess,
  refreshSignal,
  onPaid,
  onUnlocked,
  onComplete,
  onClose,
}: TopUpSheetProps): JSX.Element {
  const unlock = intent?.reason === 'unlock_models';

  const { checkout, state } = useTopUpCheckout({
    billing,
    contextKey,
    orgId,
    publishableKey,
    intent,
    fetchAccess,
    onPaid,
    onUnlocked,
  });
  const [value, setValue] = useState(String(intent?.amountUsd ?? 20));
  const customRef = useRef<HTMLInputElement | null>(null);
  const tid = (suffix: string): string => `${testIdPrefix}${suffix}`;

  useEffect(() => {
    if (refreshSignal !== undefined) checkout.refresh();
  }, [checkout, refreshSignal]);

  // Completion includes the webhook's credit grant, separately from settlement.
  const settledPlainPurchase = !unlock && state.status === 'complete';
  useEffect(() => {
    if (settledPlainPurchase) onClose();
  }, [onClose, settledPlainPurchase]);
  useEffect(() => {
    if (state.status === 'complete') onComplete?.();
  }, [onComplete, state.status]);

  const parsed = Number.parseFloat(value);
  const valid =
    Number.isFinite(parsed) &&
    parsed >= AI_CREDIT_TOP_UP_MIN_USD &&
    parsed <= AI_CREDIT_TOP_UP_MAX_USD;

  // Deterministic integer-cents breakdown, identical to the server's Stripe
  // math (`computeTopUpChargeBreakdown`), so the displayed total matches the
  // amount actually charged. Null until the entered base amount is valid.
  const breakdown = valid
    ? computeTopUpChargeBreakdown(Math.round(parsed * 100), feePercent)
    : null;

  // Estimated credits granted. The grant lands on the pre-fee BASE amount at
  // the owner's sale price, so preview off `breakdown.baseCents`, not the
  // fee-inclusive total. Approximate ("~") because the authoritative grant
  // happens on the Stripe webhook.
  const estimatedCredits =
    breakdown && creditPriceUsd > 0
      ? breakdown.baseCents / 100 / creditPriceUsd
      : null;

  const working =
    state.status === 'submitting' || state.status === 'authenticating';
  const total = breakdown ? formatUsd(breakdown.totalCents / 100) : null;
  const payLabel =
    total === null
      ? 'Buy credits'
      : unlock
        ? `Pay ${total} and unlock`
        : `Pay ${total}`;

  const close = useCallback((): void => {
    if (!working) {
      checkout.close();
      onClose();
    }
  }, [checkout, onClose, working]);

  const desktopReturnHref = useMemo((): string | null => {
    if (
      !state.unlocked ||
      intent?.source !== 'desktop' ||
      intent.requestId === undefined
    ) {
      return null;
    }
    try {
      return buildDesktopBillingDeepLink(
        {
          requestId: intent.requestId,
          ...(intent.modelId === undefined ? {} : { modelId: intent.modelId }),
          ...(intent.chatId === undefined ? {} : { chatId: intent.chatId }),
        },
        deepLinkScheme,
      );
    } catch {
      return null;
    }
  }, [deepLinkScheme, intent, state.unlocked]);

  const outcome =
    state.status === 'processing'
      ? PROCESSING_COPY
      : state.status === 'confirming_credits' ||
          state.status === 'credits_delayed'
        ? 'Payment received. Your AI credits are still processing. You won’t be charged again.'
        : state.status === 'confirming_access'
          ? CONFIRMING_COPY
          : state.status === 'access_delayed'
            ? ACCESS_DELAYED_COPY
            : state.status === 'complete'
              ? state.unlocked
                ? MODEL_LIBRARY_UNLOCK_COPY.confirmed
                : PAID_COPY
              : null;

  return (
    <DialogModal
      title={unlock ? MODEL_LIBRARY_UNLOCK_COPY.title : 'Buy AI credits'}
      subtitle={
        unlock
          ? MODEL_LIBRARY_UNLOCK_COPY.purchaseBody
          : `Enter an amount between $${AI_CREDIT_TOP_UP_MIN_USD} and $${AI_CREDIT_TOP_UP_MAX_USD}.`
      }
      maxWidth={state.status === 'needs_card' ? 'md' : 'sm'}
      dataTestId={tid('credits-top-up-modal')}
      onClose={close}
    >
      {state.status === 'needs_card' && publishableKey ? (
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-testid={tid('credits-top-up-card')}
        >
          <PaymentMethodCapture
            publishableKey={publishableKey}
            createSetupIntent={createSetupIntent}
            confirmPaymentMethod={confirmPaymentMethod}
            submitLabel={
              total === null ? undefined : `Save card and pay ${total}`
            }
            onCancel={() => checkout.cancelCard()}
            onSaved={() => checkout.cardSaved()}
          />
        </div>
      ) : outcome !== null ? (
        <div className="flex flex-col gap-4 p-5">
          <p
            className="text-s fg-primary"
            role="status"
            data-testid={tid('credits-top-up-outcome')}
          >
            {outcome}
          </p>
          {state.error ? (
            <p role="alert" className="text-xs fg-destructive">
              {state.error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            {state.status === 'processing' ||
            state.status === 'credits_delayed' ||
            state.status === 'access_delayed' ? (
              <button
                type="button"
                onClick={() => checkout.refresh()}
                data-testid={tid('credits-top-up-recheck')}
                className={SECONDARY_BUTTON_CLASS}
              >
                Check again
              </button>
            ) : null}
            {desktopReturnHref !== null ? (
              <a
                href={desktopReturnHref}
                data-testid={tid('credits-top-up-desktop-return')}
                className={PRIMARY_BUTTON_CLASS}
              >
                {`Back to ${appName}`}
              </a>
            ) : null}
            <button
              type="button"
              onClick={close}
              data-testid={tid('credits-top-up-done')}
              className={SECONDARY_BUTTON_CLASS}
            >
              {state.status === 'complete' ? 'Done' : 'Close'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-5">
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Amount"
          >
            {AMOUNT_CHIPS_USD.map((amount) => (
              <button
                key={amount}
                type="button"
                disabled={working}
                aria-pressed={valid && parsed === amount}
                onClick={() => setValue(String(amount))}
                data-testid={tid(`credits-top-up-amount-${amount}`)}
                className={`rounded-md border px-3 py-1.5 text-s font-medium transition-colors disabled:opacity-50 ${
                  valid && parsed === amount
                    ? 'bg-secondary fg-primary'
                    : 'fg-secondary hover:bg-secondary'
                }`}
              >
                {`$${amount}`}
              </button>
            ))}
            <button
              type="button"
              disabled={working}
              aria-pressed={
                !AMOUNT_CHIPS_USD.some((amount) => amount === parsed)
              }
              onClick={() => {
                customRef.current?.focus();
                customRef.current?.select();
              }}
              data-testid={tid('credits-top-up-amount-custom')}
              className={`rounded-md border px-3 py-1.5 text-s font-medium transition-colors disabled:opacity-50 ${
                AMOUNT_CHIPS_USD.some((amount) => amount === parsed)
                  ? 'fg-secondary hover:bg-secondary'
                  : 'bg-secondary fg-primary'
              }`}
            >
              Custom
            </button>
          </div>
          <label className="flex flex-col gap-1 text-s">
            <span className="fg-secondary">Amount (USD)</span>
            <div className="flex items-center rounded-md border px-3 py-2">
              <span className="mr-1 fg-secondary">$</span>
              <input
                ref={customRef}
                type="number"
                min={AI_CREDIT_TOP_UP_MIN_USD}
                max={AI_CREDIT_TOP_UP_MAX_USD}
                step="0.01"
                inputMode="decimal"
                value={value}
                disabled={working}
                onChange={(e) => setValue(e.target.value)}
                className="w-full bg-transparent fg-primary outline-none"
              />
            </div>
          </label>
          {state.error ? (
            <p className="text-xs fg-destructive" role="alert">
              {state.error}
            </p>
          ) : state.status === 'needs_card' ? (
            <p className="text-xs fg-destructive" role="alert">
              {TOP_UP_ERROR}
            </p>
          ) : null}
          <dl
            className="flex flex-col gap-1 rounded-md border bg-secondary/40 px-3 py-2 text-s"
            data-testid={tid('credits-top-up-breakdown')}
          >
            <div className="flex items-center justify-between">
              <dt className="fg-secondary">Credits</dt>
              <dd className="fg-primary">
                {breakdown
                  ? formatUsd(breakdown.baseCents / 100)
                  : BREAKDOWN_PLACEHOLDER}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="fg-secondary">Service fee ({feePercent}%)</dt>
              <dd className="fg-primary">
                {breakdown
                  ? formatUsd(breakdown.feeCents / 100)
                  : BREAKDOWN_PLACEHOLDER}
              </dd>
            </div>
            <div className="mt-1 flex items-center justify-between border-t pt-1 font-medium">
              <dt className="fg-primary">Total charged</dt>
              <dd
                className="fg-primary"
                data-testid={tid('credits-top-up-total')}
              >
                {total ?? BREAKDOWN_PLACEHOLDER}
              </dd>
            </div>
            <div className="mt-1 flex items-center justify-between border-t pt-1">
              <dt className="fg-secondary">You&apos;ll receive</dt>
              <dd
                className="fg-primary"
                data-testid={tid('credits-top-up-estimate')}
              >
                {estimatedCredits !== null
                  ? `~${formatCredits(estimatedCredits)} credits`
                  : BREAKDOWN_PLACEHOLDER}
              </dd>
            </div>
          </dl>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={working}
              onClick={close}
              className={SECONDARY_BUTTON_CLASS}
            >
              {unlock ? MODEL_LIBRARY_UNLOCK_COPY.dismissAction : 'Cancel'}
            </button>
            <button
              type="button"
              disabled={working || !valid || state.paid}
              onClick={() => checkout.submit(parsed)}
              data-testid={tid('credits-top-up-confirm')}
              className={PRIMARY_BUTTON_CLASS}
            >
              {state.status === 'authenticating'
                ? 'Confirming with your bank…'
                : working
                  ? 'Processing…'
                  : payLabel}
            </button>
          </div>
        </div>
      )}
    </DialogModal>
  );
}
