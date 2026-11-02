import type { JSX } from 'react';
import { AI_CREDITS_STOP_COPY } from './aiCreditsPurchaseCopy';

export interface AiCreditsStopLineProps {
  readonly dataTestId?: string;
}

/**
 * The transcript's record of a message nothing could pay for (CAN-5160):
 * plain text, no panel and no action. Every transcript renders it, desktop
 * and replayed, so the payment choice lives only in the composer's banner.
 *
 * No live region: the composer banner announces the same stop, and a second
 * announcement from the transcript would repeat it.
 */
export function AiCreditsStopLine({
  dataTestId = 'chat-ai-credits-stop-line',
}: AiCreditsStopLineProps): JSX.Element {
  return (
    <p data-testid={dataTestId} className="py-1 text-xs fg-tertiary">
      {AI_CREDITS_STOP_COPY}
    </p>
  );
}
