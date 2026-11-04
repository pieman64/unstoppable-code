/**
 * CAN-4764 — the in-chat out-of-credits recovery copy, shared by the desktop
 * no-billing-source banner and the web cloud credit recovery notice. Each
 * host keeps choosing which arm applies; only the words live here.
 *
 * The credit term's casing differs per host on purpose ("AI Credits" on
 * desktop, "AI credits" on web; see `dailyFreeCredits.ts`), so each string
 * keeps the casing its host shows today.
 */

/** A recovery notice's state (the title) and what follows it on the line. */
export interface CreditsRecoveryCopy {
  readonly title: string;
  readonly message: string;
}

/**
 * Copy for an org member whose org carries the credit-pool capability but has no
 * spendable headroom right now. They cannot buy credits themselves, so every
 * banner shows this instead of a purchase CTA.
 */
export const CONTACT_ORG_ADMIN_COPY =
  'Contact your org admin to increase your spend quota.';

/** The title while a queued message waits on credits. */
export const MESSAGE_QUEUED_TITLE = 'Message queued';

/** The message while a queued message waits on credits. */
export const QUEUED_MESSAGE_RETAINED_COPY =
  'Your queued message is still saved. Add credits, then click Try again.';

/** The web recovery notice's title. */
export const OUT_OF_CREDITS_TITLE = "You're out of AI credits";

/** What happened to the user's message, so they know nothing was lost. */
export function retainedMessageCopy(
  origin: 'composer' | 'queue' | 'create',
): string {
  if (origin === 'queue') {
    return QUEUED_MESSAGE_RETAINED_COPY;
  }
  if (origin === 'create') {
    return 'Nothing was sent. Add credits, then try again.';
  }
  return 'Your message is still in the composer. Add credits, then send it again.';
}

/**
 * When the wallet next refills on its own, as a line in local time, or `null`
 * without a valid refill time.
 */
export function creditsReplenishmentCopy(
  replenishment: {
    readonly kind: 'daily' | 'monthly';
    readonly at: string;
  } | null,
): string | null {
  if (replenishment === null) return null;
  const at = new Date(replenishment.at);
  if (!Number.isFinite(at.getTime())) return null;
  const localTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
  return replenishment.kind === 'daily'
    ? `Daily credits refill ${localTime}.`
    : `Monthly credits renew ${localTime}.`;
}

/** The organization's model policy allows nothing the user can run. */
export const POLICY_ONLY_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'No model available',
  message: `Your organization's model policy doesn't allow any model you can run right now, so ask your organization admin to allow a model you can use.`,
};

/** The organization only allows models paid for with AI Credits. */
export function creditsOnlyDeadEndCopy(appName: string): CreditsRecoveryCopy {
  return {
    title: 'AI Credits required',
    message: `Your organization only allows models that require ${appName} AI Credits.`,
  };
}

/** Every model the organization allows needs a billing source. */
export const POLICY_BILLING_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'No model available',
  message: `Your organization's allowed models all need a billing source you don't have yet.`,
};

/** No available model can be paid for. */
export const DISPATCH_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'No billing source',
  message: 'No available model can be paid for right now.',
};

/** A turn already failed because AI Credits didn't cover it. */
export function failedTurnCopy(appName: string): CreditsRecoveryCopy {
  return {
    title: 'Message not sent',
    message: `Your ${appName} AI Credits didn't cover that message.`,
  };
}

/** Before sending: no provider sign-in and no AI Credits to fall back on. */
export function notSignedInCopy({
  appName,
  providerLabel,
}: {
  readonly appName: string;
  readonly providerLabel: string;
}): CreditsRecoveryCopy {
  return {
    title: `Not signed in to ${providerLabel}`,
    message: `You have no ${appName} AI Credits to cover this chat either.`,
  };
}
