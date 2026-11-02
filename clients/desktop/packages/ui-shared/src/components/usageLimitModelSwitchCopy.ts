/**
 * The words a usage-limit notice uses when the chat's model can't run on AI
 * Credits, so every host explains the gate and the way past it the same way:
 * name the model, offer the default credits model, or wait for the reset.
 *
 * Titles carry no full stop; sentences do. The purchase action keeps its
 * shared label (`AI_CREDITS_PURCHASE_LABEL`); the model names go in the
 * message instead.
 */

/** The action that moves the chat onto the credits model. */
export function usageLimitModelSwitchActionLabel(
  targetModelLabel: string,
): string {
  return `Continue on ${targetModelLabel}`;
}

export interface UsageLimitModelSwitchMessageInput {
  /** The chat's current model, which can't run on AI Credits. */
  readonly modelLabel: string;
  /** The credits model to offer; omitted when it can't run on AI Credits either. */
  readonly targetModelLabel?: string;
  /** A preformatted balance, for example `1,234`. */
  readonly creditsLeft?: string;
  /** When the quota resets, for example `8:14 PM`. */
  readonly resetsLabel?: string;
  /** When a scheduled resume runs, for example `Tue 9:00 AM`. */
  readonly scheduledForLabel?: string;
}

function notRoutableSentence(modelLabel: string): string {
  return `${modelLabel} can't run on AI Credits.`;
}

function waitClause(resetsLabel: string | undefined): string {
  return resetsLabel
    ? `wait until ${resetsLabel}`
    : 'wait for your quota to reset';
}

/** The notice message when credits could continue the chat on another model. */
export function usageLimitModelSwitchMessage({
  modelLabel,
  targetModelLabel,
  creditsLeft,
  resetsLabel,
  scheduledForLabel,
}: UsageLimitModelSwitchMessageInput): string {
  const gate = notRoutableSentence(modelLabel);
  const credits = creditsLeft
    ? `with your AI Credits (${creditsLeft} left)`
    : 'with your AI Credits';
  if (scheduledForLabel) {
    const resumes = `This chat resumes automatically at ${scheduledForLabel}.`;
    const next = targetModelLabel
      ? `Continue on ${targetModelLabel} ${credits} to keep going now.`
      : 'Choose a model that can run on AI Credits to keep going now.';
    return `${resumes} ${gate} ${next}`;
  }
  const next = targetModelLabel
    ? `Continue on ${targetModelLabel} ${credits}, or ${waitClause(resetsLabel)}.`
    : `Choose a model that can, or ${waitClause(resetsLabel)}.`;
  return `${gate} ${next}`;
}

export interface UsageLimitModelSwitchPurchaseMessageInput {
  readonly modelLabel: string;
  readonly targetModelLabel?: string;
  readonly resetsLabel?: string;
  readonly scheduledForLabel?: string;
}

/** The notice message when the user has no AI Credits to continue with yet. */
export function usageLimitModelSwitchPurchaseMessage({
  modelLabel,
  targetModelLabel,
  resetsLabel,
  scheduledForLabel,
}: UsageLimitModelSwitchPurchaseMessageInput): string {
  const buy = targetModelLabel
    ? `Get AI Credits to continue on ${targetModelLabel}`
    : 'Get AI Credits and choose a model that can';
  if (scheduledForLabel) {
    const buyNow = targetModelLabel
      ? buy
      : 'Get AI Credits and choose a model that can run on them';
    return `This chat resumes automatically at ${scheduledForLabel}. ${notRoutableSentence(modelLabel)} ${buyNow} to keep going now.`;
  }
  const wait = resetsLabel
    ? `wait for your quota to reset around ${resetsLabel}`
    : 'wait for your quota to reset';
  return `${notRoutableSentence(modelLabel)} ${buy}, or ${wait}.`;
}

export interface UsageLimitModelSwitchFailureDetailInput {
  readonly targetModelLabel: string;
  readonly resetsLabel?: string;
}

/** The detail line after the switch to the credits model failed. */
export function usageLimitModelSwitchFailureDetail({
  targetModelLabel,
  resetsLabel,
}: UsageLimitModelSwitchFailureDetailInput): string {
  const failed = `Couldn't switch to ${targetModelLabel}.`;
  return resetsLabel
    ? `${failed} Try again or wait until ${resetsLabel}.`
    : `${failed} Try again.`;
}
