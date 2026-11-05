import { useEffect, useMemo } from 'react';
import { automationOfferCardProps } from '@canopy/ui-shared/components';
import {
  useSuggestionCornerOffer,
  type SuggestionCornerModel,
} from '@canopy/ui-app/suggestions';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { answerRepeatTaskOffer } from '@/lib/repeat-task-automation/offer';
import { useRepeatTaskOfferStore } from '@/lib/repeat-task-automation/offerStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/**
 * Desktop producer for the repeated-task automation offer (CAN-4009,
 * CAN-4343). Offers the current account's pending offer to the shared
 * suggestion corner. A refused offer is dropped unanswered: its task stays
 * unresolved and is offered again on its next repeat, the natural retry.
 * Not now resolves this task; Don't show again also retires the category,
 * and the committed dismissal clears recorded history.
 */
export function RepeatTaskOfferProducer(): null {
  const offer = useRepeatTaskOfferStore((state) => state.offer);
  const accountEpoch = useWorkspaceContextStore((state) => state.accountEpoch);
  const show = offer !== null && offer.accountEpoch === accountEpoch;

  const entryId = show ? offer.entryId : null;
  const model = useMemo(
    (): SuggestionCornerModel | null =>
      entryId !== null
        ? {
            suggestionId: 'repeat-task-automation',
            itemKey: entryId,
            presentable: true,
            card: automationOfferCardProps({
              onCreate: () => {
                answerRepeatTaskOffer('create');
              },
              onDismiss: () => {
                answerRepeatTaskOffer('dismiss');
              },
              testId: 'repeat-task-automation-offer',
            }),
            permanentDismiss: {
              testId: 'repeat-task-automation-offer-dismiss-forever',
              onDismissed: () => {
                answerRepeatTaskOffer('dismiss');
              },
            },
          }
        : null,
    [entryId],
  );
  const claim = useSuggestionCornerOffer('repeat-task-automation', model);

  useEffect(() => {
    if (show && claim.status === 'refused') {
      useRepeatTaskOfferStore.setState({ offer: null });
    }
  }, [show, claim.status]);

  useCurrentUiStateReporter(
    'repeatTaskAutomationOffer.banner',
    show && claim.status === 'active' ? { open: true } : null,
  );
  return null;
}
