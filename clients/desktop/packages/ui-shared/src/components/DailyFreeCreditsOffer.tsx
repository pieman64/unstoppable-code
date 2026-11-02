import type { JSX } from 'react';
import {
  dailyFreeCreditsAmountSentence,
  dailyFreeCreditsTerms,
  type DailyFreeCreditsTerm,
} from './dailyFreeCredits';

export interface DailyFreeCreditsOfferProps {
  readonly term: DailyFreeCreditsTerm;
  /** Preserve the consumer's number formatter; null means an unknown cap. */
  readonly formattedCap: string | null;
  readonly lead?: string;
  /** Omit when the surrounding surface does not show identity terms. */
  readonly isGuest?: boolean;
  readonly dataTestId?: string;
}

/** The grant passage shared by recovery and settings, independent of host state. */
export function DailyFreeCreditsOffer({
  term,
  formattedCap,
  lead,
  isGuest,
  dataTestId,
}: DailyFreeCreditsOfferProps): JSX.Element {
  const sentences = [
    lead,
    dailyFreeCreditsAmountSentence(term, formattedCap),
    isGuest === undefined ? undefined : dailyFreeCreditsTerms({ isGuest }),
  ];
  return (
    <span data-testid={dataTestId}>
      {sentences.filter((sentence) => sentence !== undefined).join(' ')}
    </span>
  );
}
