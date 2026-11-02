import { formatCredits } from '../lib/billing-format';
import { MODEL_LIBRARY_UNLOCK_COPY } from './modelLibraryLock';

/**
 * Copy for the arrival confirmation in the usage-limit banner (CAN-5160).
 *
 * A balance observation is all the browser hand-off can see, so the title
 * names an observed increase, never a charge or a purchase receipt.
 */
export const AI_CREDITS_ARRIVAL_COPY = {
  /** No usable personal balance, or funding this chat does not identify. */
  available: 'AI Credits are available for this chat.',
  added: (credits: string): string => `${credits} AI Credits added.`,
  balance: (credits: string): string => `Balance: ${credits} credits.`,
  dismiss: 'Dismiss AI Credits notice',
} as const;

export interface AiCreditsArrivalEvidence {
  /** The observed personal balance increase since the hand-off began. */
  readonly addedCredits?: number | null;
  /** The current personal balance, when it is usable for this chat. */
  readonly balanceCredits?: number | null;
}

/** Rounds to ledger display precision; `null` unless it shows as positive. */
function displayablePositive(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  if (rounded <= 0 || formatCredits(rounded) === '0') return null;
  return rounded;
}

/**
 * The arrival title. A delta is stated only when it shows as a nonzero
 * amount; the balance follows it only when it reads differently. Without a
 * delta the balance alone is named, and with neither the notice says only
 * that credits are available.
 */
export function aiCreditsArrivalTitle({
  addedCredits,
  balanceCredits,
}: AiCreditsArrivalEvidence): string {
  const added = displayablePositive(addedCredits);
  const balance = displayablePositive(balanceCredits);
  if (added !== null) {
    const addedLabel = formatCredits(added);
    const lead = AI_CREDITS_ARRIVAL_COPY.added(addedLabel);
    if (balance === null) return lead;
    const balanceLabel = formatCredits(balance);
    return balanceLabel === addedLabel
      ? lead
      : `${lead} ${AI_CREDITS_ARRIVAL_COPY.balance(balanceLabel)}`;
  }
  if (balance !== null)
    return MODEL_LIBRARY_UNLOCK_COPY.confirmedCredits(balance);
  return AI_CREDITS_ARRIVAL_COPY.available;
}
