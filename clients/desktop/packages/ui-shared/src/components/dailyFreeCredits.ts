/**
 * CAN-5214 — the free daily credit grant's name and terms, shared by every
 * surface that offers or toggles it.
 *
 * Desktop writes the product term as `AI Credits`; web Billing and the web
 * recovery notice write `AI credits`. Callers pass the casing they use. The
 * total-wallet label stays `AI Credits` everywhere and is not built here,
 * because a balance can include purchased credits.
 */
export type DailyFreeCreditsTerm = 'AI Credits' | 'AI credits';

/** `free daily AI Credits`, for use mid-sentence. */
export function dailyFreeCreditsName(term: DailyFreeCreditsTerm): string {
  return `free daily ${term}`;
}

/** `Free daily AI Credits`, for toggle labels and sentence starts. */
export function dailyFreeCreditsTitle(term: DailyFreeCreditsTerm): string {
  return `Free daily ${term}`;
}

/** The action that opts in to the grant. */
export function dailyFreeCreditsTurnOnAction(
  term: DailyFreeCreditsTerm,
): string {
  return `Turn on ${dailyFreeCreditsName(term)}`;
}

/** The accessible name of a switch that toggles the grant. */
export function dailyFreeCreditsToggleLabel(
  term: DailyFreeCreditsTerm,
): string {
  return `Toggle ${dailyFreeCreditsName(term)}`;
}

/**
 * The daily cap a surface may display, or `null`.
 *
 * Only a finite amount above zero names a number; anything else falls back to
 * the amount-less sentence instead of a default or a wallet balance.
 */
export function displayableDailyFreeCreditsCap(
  capCredits: number | null | undefined,
): number | null {
  return typeof capCredits === 'number' &&
    Number.isFinite(capCredits) &&
    capCredits > 0
    ? capCredits
    : null;
}

/**
 * `Get 25 free AI Credits every day.`, or `Get free AI Credits every day.`
 * when the cap is unknown. The amount arrives formatted, so each host keeps
 * its own number formatting.
 */
export function dailyFreeCreditsAmountSentence(
  term: DailyFreeCreditsTerm,
  formattedCap: string | null,
): string {
  return formattedCap === null
    ? `Get free ${term} every day.`
    : `Get ${formattedCap} free ${term} every day.`;
}

/**
 * What opting in costs. A guest needs no account either; a signed-in account
 * already has one.
 */
function dailyFreeCreditsCost({
  isGuest,
}: {
  readonly isGuest: boolean;
}): string {
  return isGuest ? 'No card or account needed.' : 'No card needed.';
}

/** What opting in costs and how to undo it. */
export function dailyFreeCreditsTerms({
  isGuest,
}: {
  readonly isGuest: boolean;
}): string {
  return `${dailyFreeCreditsCost({ isGuest })} Turn it off any time in Settings.`;
}

/**
 * `Get 25 free every day, no card needed.`, the hint that follows
 * `You're out of AI Credits.` in the same sentence run and describes the
 * opt-in button when that button is one of several choices. Without a cap it
 * names the credits: `Get free AI Credits every day, no card needed.`
 */
export function dailyFreeCreditsActionHint(
  term: DailyFreeCreditsTerm,
  formattedCap: string | null,
  { isGuest }: { readonly isGuest: boolean },
): string {
  const amount =
    formattedCap === null
      ? `Get free ${term} every day`
      : `Get ${formattedCap} free every day`;
  const cost = isGuest ? 'no card or account needed.' : 'no card needed.';
  return `${amount}, ${cost}`;
}

/**
 * The saved line for an opt-in that granted nothing today, with the purchase
 * suffix only where buying is possible.
 */
export function dailyFreeCreditsStartTomorrow(
  term: DailyFreeCreditsTerm,
  { canBuy }: { readonly canBuy: boolean },
): string {
  return `Your ${dailyFreeCreditsName(term)} start tomorrow.${
    canBuy ? ' You can also buy credits now.' : ''
  }`;
}
