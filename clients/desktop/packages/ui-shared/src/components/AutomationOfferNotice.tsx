'use client';

import type { JSX } from 'react';
import { SuggestionCard, type SuggestionCardProps } from './SuggestionCard';

export interface AutomationOfferNoticeProps {
  onCreate: () => void;
  onDismiss: () => void;
  /** Don't show again: stops repeated-task offers for good (CAN-4343). */
  onDismissForever?: () => void;
  testId?: string;
}

/** The repeated-task offer's card, for hosts that render it in a shared corner. */
export function automationOfferCardProps({
  onCreate,
  onDismiss,
  onDismissForever,
  testId = 'automation-offer-notice',
}: AutomationOfferNoticeProps): SuggestionCardProps {
  return {
    testId,
    title: 'Turn this into an automation?',
    body: "You've run a similar task before. Make it an automation to run it on a schedule.",
    ...(onDismissForever
      ? {
          permanentDismiss: {
            label: 'Don’t show again',
            onClick: onDismissForever,
            testId: `${testId}-dismiss-forever`,
          },
        }
      : {}),
    secondaryAction: {
      label: 'Not now',
      onClick: onDismiss,
      testId: `${testId}-dismiss`,
    },
    primaryAction: {
      label: 'Create automation',
      onClick: onCreate,
      testId: `${testId}-create`,
    },
  };
}

/**
 * The offer to turn a repeated task into an automation (CAN-4009). A floating
 * card in the host's notification corner, like the notification offer, with
 * exactly two choices (and, from the host, an optional Don’t show again)
 * and no close control, timer, or Escape dismissal: the
 * host records either answer. It announces politely and never takes focus.
 *
 * Pure display: the host decides when to show it and owns persistence.
 */
export function AutomationOfferNotice(
  props: AutomationOfferNoticeProps,
): JSX.Element {
  return <SuggestionCard {...automationOfferCardProps(props)} />;
}
