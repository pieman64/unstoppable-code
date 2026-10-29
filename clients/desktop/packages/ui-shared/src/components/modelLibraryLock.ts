import type { ModelLibraryAccess } from '@canopy/protocol/models';

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
 * they can use before opening one. A purchase-only lock has no label: those
 * rows keep their usual credits tag.
 */
export function modelLibraryUnlockLabel(
  access: ModelLibraryAccess | undefined,
): string | undefined {
  return access === 'needs_sign_in' || access === 'needs_sign_in_then_purchase'
    ? MODEL_LIBRARY_UNLOCK_COPY.signInAction
    : undefined;
}

/**
 * Recovery copy. "Advanced models", never "every model": provider, policy, and
 * funding restrictions still apply after a purchase. Nothing here promises the
 * unlock is permanent, because a lost chargeback can revoke it.
 */
export const MODEL_LIBRARY_UNLOCK_COPY = {
  title: 'Unlock advanced models',
  purchaseBody: 'Purchase AI Credits to unlock advanced models.',
  guestBody: 'Sign in, then purchase AI Credits.',
  purchaseAction: 'Purchase AI Credits',
  signInAction: 'Sign in',
  dismissAction: 'Not now',
  confirmed: 'Advanced models are unlocked.',
  selectionFailed: 'Your model could not be selected. Try selecting it again.',
  retrySelection: 'Retry model selection',
  waitingInBrowser:
    "Finish in your browser. We'll check when your payment completes.",
  proxyRefusalTitle: 'This model needs an AI Credit purchase',
  proxyRefusalBody:
    'Purchase AI Credits to unlock advanced models, then send your message again.',
} as const;
