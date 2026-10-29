import type { JSX } from 'react';
import { AutomationOfferNotice } from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { answerRepeatTaskOffer } from '@/lib/repeat-task-automation/offer';
import { useRepeatTaskOfferStore } from '@/lib/repeat-task-automation/offerStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/**
 * Desktop host for the repeated-task automation offer (CAN-4009). Shows the
 * shared card while an offer for the current account waits for an answer.
 */
export function RepeatTaskAutomationOfferBanner(): JSX.Element | null {
  const offer = useRepeatTaskOfferStore((state) => state.offer);
  const accountEpoch = useWorkspaceContextStore((state) => state.accountEpoch);
  const show = offer !== null && offer.accountEpoch === accountEpoch;
  useCurrentUiStateReporter(
    'repeatTaskAutomationOffer.banner',
    show ? { open: true } : null,
  );

  if (!show) return null;

  return (
    <AutomationOfferNotice
      onCreate={() => {
        answerRepeatTaskOffer('create');
      }}
      onDismiss={() => {
        answerRepeatTaskOffer('dismiss');
      }}
      testId="repeat-task-automation-offer"
    />
  );
}
