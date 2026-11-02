/**
 * The words every in-chat AI Credits purchase uses, from the first offer to
 * the checkout in the browser, so each path names the same step the same
 * way: the usage-limit and No billing source banners, the model picker's
 * billing toggle, the recovery dialog, and the advanced-model unlock.
 *
 * Titles carry no full stop; `Notice` and the hosts that join a title and
 * message add it.
 */

/** The purchase action on every surface. */
export const AI_CREDITS_PURCHASE_LABEL = 'Get AI Credits';

/** The re-read after checkout, on every surface. */
export const AI_CREDITS_CHECK_AGAIN_LABEL = 'Check again';

/**
 * While checkout is open in the browser, and after a Check again that found
 * nothing (`uncovered`) or could not read the balance (`checkFailed`).
 */
export const AI_CREDITS_HANDOFF_COPY = {
  waiting: {
    title: 'Finish checkout in your browser',
    message: 'Your credits show up here once the payment goes through.',
  },
  uncovered: {
    title: 'No credits yet',
    message: "If you've paid, they can take a minute to arrive.",
  },
  checkFailed: {
    title: "Couldn't check your balance",
    message: 'Try again in a moment.',
  },
} as const;

/** One copy entry as a single sentence pair, for hosts without a title slot. */
export function aiCreditsHandoffSentence(entry: {
  readonly title: string;
  readonly message: string;
}): string {
  return `${entry.title}. ${entry.message}`;
}

/**
 * What the transcript says where a message stopped because nothing could pay
 * for it. The composer's banner is where the user chooses how to pay, so the
 * transcript only explains the stop and offers no action of its own.
 */
export const AI_CREDITS_STOP_COPY =
  'Chat stopped. Choose how to pay for this message to keep going.';
