import { BILLING_TOP_UP_MIN_USD } from '@canopy/protocol/billing';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import { formatCredits } from '../lib/billing-format';
import {
  AI_CREDITS_CHECK_AGAIN_LABEL,
  AI_CREDITS_HANDOFF_COPY,
  AI_CREDITS_PURCHASE_LABEL,
} from './aiCreditsPurchaseCopy';

/** An access value that still locks advanced models. */
export type LockedModelLibraryAccess = Exclude<ModelLibraryAccess, 'unlocked'>;

/**
 * Row hints for a library-locked model, shared so desktop, the Portal, and
 * cloud chats name the same remedy for the same access value.
 */
const MODEL_LIBRARY_UNLOCK_HINTS: Readonly<
  Record<LockedModelLibraryAccess, string>
> = {
  needs_sign_in: 'Unlock with sign-in',
  needs_sign_in_then_purchase: 'Unlock with sign-in and AI Credit purchase',
  needs_purchase: 'Unlock with AI Credit purchase',
};

/** The hint for a locked access value; `undefined` when nothing is locked. */
export function modelLibraryUnlockHint(
  access: ModelLibraryAccess | undefined,
): string | undefined {
  return access === undefined || access === 'unlocked'
    ? undefined
    : MODEL_LIBRARY_UNLOCK_HINTS[access];
}

/**
 * The visible remedy on a row that needs sign-in, so a guest sees which models
 * they can use before opening one. When a purchase follows sign-in the label
 * names both steps (CAN-5213). A purchase-only lock has no label: those rows
 * keep their usual credits tag.
 */
export function modelLibraryUnlockLabel(
  access: ModelLibraryAccess | undefined,
): string | undefined {
  switch (access) {
    case 'needs_sign_in':
      return MODEL_LIBRARY_UNLOCK_COPY.signInAction;
    case 'needs_sign_in_then_purchase':
      return MODEL_LIBRARY_UNLOCK_COPY.signInThenPurchaseLabel;
    default:
      return undefined;
  }
}

const PURCHASE_SCOPE_BODY = `Free daily credits don't unlock advanced models. Purchase some AI Credits (minimum $${BILLING_TOP_UP_MIN_USD}) to unlock Sonnet, Opus, Fable and more.`;

/**
 * Recovery copy. "Advanced models", never "every model": provider, policy, and
 * funding restrictions still apply after a purchase. Nothing here promises the
 * unlock is permanent, because a lost chargeback can revoke it.
 *
 * The purchase minimum comes from the checkout's own `BILLING_TOP_UP_MIN_USD`.
 * The model families named in `purchaseBody` are editorial and maintained by
 * hand, not generated from the catalog: review them when purchase eligibility
 * changes.
 */
export const MODEL_LIBRARY_UNLOCK_COPY = {
  title: 'Unlock advanced models',
  purchaseBody: `${PURCHASE_SCOPE_BODY} We'll switch to your selected model once the purchase is complete.`,
  // Billing links and proxy recovery can open checkout without a pending model.
  purchaseBodyWithoutSelection: PURCHASE_SCOPE_BODY,
  guestBody: 'Sign in, then purchase AI Credits.',
  purchaseAction: AI_CREDITS_PURCHASE_LABEL,
  signInAction: 'Sign in',
  /** The row label when a purchase follows sign-in. */
  signInThenPurchaseLabel: 'Sign in and buy',
  dismissAction: 'Not now',
  confirmed: 'Advanced models are unlocked.',
  selectionFailed: 'Your model could not be selected. Try selecting it again.',
  retrySelection: 'Try again',
  waitingInBrowser: `${AI_CREDITS_HANDOFF_COPY.waiting.title}. We'll check when the payment goes through.`,
  pendingTitle: AI_CREDITS_HANDOFF_COPY.waiting.title,
  timedOutTitle: 'Automatic payment checks have stopped',
  timedOutBody: `Your purchase may still be in progress. ${AI_CREDITS_CHECK_AGAIN_LABEL} once it's complete.`,
  newPurchaseHelp: "Starting a new purchase won't cancel the previous one.",
  dismissHelp:
    "Dismissing this notice stops tracking this purchase. It won't cancel your purchase.",
  checkNowAction: AI_CREDITS_CHECK_AGAIN_LABEL,
  checkingAction: 'Checking…',
  newPurchaseAction: 'Start a new purchase',
  dismissPaymentAction: 'Dismiss payment notice',
  proxyRefusalTitle: 'This model needs an AI Credit purchase',
  proxyRefusalBody:
    'Purchase AI Credits to unlock advanced models, then send your message again.',
  /**
   * The in-chat confirmation after a confirmed unlock (CAN-5027). The number
   * is the refreshed available balance, never the amount purchased or
   * charged; without a usable balance the notice says `confirmed` instead.
   */
  confirmedCredits: (credits: number): string =>
    `Your ${formatCredits(credits)} AI Credits are now available.`,
  /** Only while the chat's current model is the one the unlock was for. */
  confirmedModelSelected: (modelLabel: string): string =>
    `${modelLabel} is selected for this chat.`,
  dismissConfirmation: 'Dismiss unlock confirmation',
} as const;

/**
 * The purchase dialog title: names the model being unlocked, or falls back to
 * the generic title when no display label is known.
 */
export function modelLibraryUnlockTitle(modelLabel?: string): string {
  const label = modelLabel?.trim();
  return label ? `Unlock ${label}` : MODEL_LIBRARY_UNLOCK_COPY.title;
}

/**
 * The recovery dialog's line while checkout is open in the browser. Says that
 * Close does not cancel, and names the model only when the host knows it; an
 * unknown model gets the generic unlock rather than a raw ID.
 */
export function modelLibraryWaitingInBrowserBody(modelLabel?: string): string {
  return modelLabel === undefined
    ? `${AI_CREDITS_HANDOFF_COPY.waiting.title}. Closing this dialog won't cancel your purchase. We'll unlock advanced models once the payment goes through.`
    : `${AI_CREDITS_HANDOFF_COPY.waiting.title}. Closing this dialog won't cancel your purchase. We'll switch to ${modelLabel} in the chat where you started the purchase once the payment goes through.`;
}

/** The composer notice's line while the purchase is pending. */
export function modelLibraryPendingBody(modelLabel?: string): string {
  return modelLabel === undefined
    ? "We'll unlock advanced models once the payment goes through."
    : `We'll switch to ${modelLabel} once the payment goes through.`;
}
