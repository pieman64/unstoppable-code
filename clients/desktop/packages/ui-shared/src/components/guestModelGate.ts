import {
  dailyFreeCreditsName,
  dailyFreeCreditsTitle,
} from './dailyFreeCredits';
import { MODEL_LIBRARY_UNLOCK_COPY } from './modelLibraryLock';

/**
 * The reassurance clause guest-facing sign-in prompts close on: nothing
 * already built is at risk. Shared so the desktop prompts and the guest model
 * gate on every host say it the same way.
 */
export const GUEST_WORK_PRESERVED_COPY =
  'Your guest work comes with you, nothing is lost.';

/** The guest model gate's dismiss label: a declined offer, not a cancel. */
export const GUEST_MODEL_GATE_DISMISS_COPY = 'Not now';

/**
 * How the guest reaches the gate's fallback model.
 *
 * `now` — the model is usable as things stand.
 * `daily-credits` — the guest declined free daily AI Credits, and the fallback
 * action turns them on before selecting the model.
 */
export type GuestModelFallbackAccess = 'now' | 'daily-credits';

/**
 * CAN-5211 — the guest gate's status lines for the `daily-credits` fallback.
 * The saved-state lines are shown only once the preference save succeeded,
 * and none of them promises when credits arrive.
 */
const GRANT_NAME = dailyFreeCreditsName('AI Credits');
const GRANT_TITLE = dailyFreeCreditsTitle('AI Credits');

export const GUEST_MODEL_GATE_DAILY_CREDITS_COPY = {
  saveFailed: `Couldn't turn on ${GRANT_NAME}. Try again.`,
  saveUncertain: `Couldn't confirm whether ${GRANT_NAME} are on. Check again.`,
  savedRefreshFailed: `${GRANT_TITLE} are on, but we couldn't check your balance. Try again.`,
  savedNoCoverage: `${GRANT_TITLE} are on, but no credits are available right now.`,
  recheckAction: 'Check again',
} as const;

export interface GuestModelGateCopyInput {
  /** Display label of the gated model the guest picked. */
  readonly modelLabel: string;
  /** Product name, resolved by the host at call time. */
  readonly appName: string;
  /** Defaults to `needs_sign_in`. */
  readonly access?: 'needs_sign_in' | 'needs_sign_in_then_purchase';
  /**
   * Allowlist label of a guest model the host can select right now.
   *
   * Pass it only when the host also renders a working action for it: the
   * body's "right now" sentence and the fallback action are derived from this
   * one value so neither can appear without the other.
   */
  readonly fallbackLabel?: string;
  /** How the fallback is reached. Defaults to `now`; ignored without a label. */
  readonly fallbackAccess?: GuestModelFallbackAccess;
}

export interface GuestModelGateCopy {
  readonly title: string;
  readonly body: string;
  readonly signInAction: string;
  /** Present exactly when a fallback label was supplied. */
  readonly fallbackAction?: string;
  readonly dismissAction: string;
}

/**
 * CAN-4703 — copy for the guest model gate.
 *
 * The plain gate says the account is free and, when the host can select one,
 * names the guest model available right now. The purchase variant names both
 * requirements up front, because signing in alone does not unlock that model,
 * and its action leads with the purchase: hosts route it through sign-in
 * straight to checkout. It may still offer the free alternative.
 *
 * "Free" describes the account and the guest-allowed model. It never claims
 * the gated model is free to run. A `daily-credits` fallback says the guest
 * model runs on free daily AI Credits instead of claiming it works right now.
 */
export function guestModelGateCopy({
  modelLabel,
  appName,
  access = 'needs_sign_in',
  fallbackLabel,
  fallbackAccess = 'now',
}: GuestModelGateCopyInput): GuestModelGateCopy {
  // The sentence and the action come from one value, so neither can appear
  // without the other.
  const fallback =
    fallbackLabel === undefined
      ? undefined
      : fallbackAccess === 'daily-credits'
        ? {
            sentence: `As a guest you can use ${fallbackLabel} with ${GRANT_NAME}.`,
            action: `Use ${fallbackLabel} with ${GRANT_NAME}`,
          }
        : {
            sentence: `As a guest you can use ${fallbackLabel} right now.`,
            action: `Use ${fallbackLabel} (free)`,
          };
  const withFallback =
    fallback === undefined ? {} : { fallbackAction: fallback.action };
  const fallbackSentence = fallback?.sentence;

  if (access === 'needs_sign_in_then_purchase') {
    const requirement = `Using ${modelLabel} requires a free ${appName} account and a purchase of AI Credits.`;
    return {
      title: MODEL_LIBRARY_UNLOCK_COPY.title,
      body:
        fallbackSentence === undefined
          ? requirement
          : `${requirement} ${fallbackSentence}`,
      signInAction: MODEL_LIBRARY_UNLOCK_COPY.purchaseAction,
      ...withFallback,
      dismissAction: MODEL_LIBRARY_UNLOCK_COPY.dismissAction,
    };
  }

  const accountSentence = `${modelLabel} needs a free ${appName} account.`;
  return {
    title: `Sign in free to use ${modelLabel}`,
    body:
      fallbackSentence === undefined
        ? `${accountSentence} ${GUEST_WORK_PRESERVED_COPY}`
        : `${accountSentence} ${fallbackSentence}`,
    signInAction: `Sign in to use ${modelLabel}`,
    ...withFallback,
    dismissAction: GUEST_MODEL_GATE_DISMISS_COPY,
  };
}
