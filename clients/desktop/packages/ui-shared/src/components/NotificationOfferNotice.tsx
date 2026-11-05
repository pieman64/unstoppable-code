'use client';

import type { JSX } from 'react';
import { SuggestionCard, type SuggestionCardProps } from './SuggestionCard';

/** Which offer action is in flight, or `null` when idle. */
export type NotificationOfferNoticeBusyAction = 'enable' | 'dismiss' | null;

export interface NotificationOfferNoticeProps {
  /** The action whose answer is being saved; disables both choices. */
  busyAction: NotificationOfferNoticeBusyAction;
  /** The last answer could not be saved; the choices stay available to retry. */
  saveFailed: boolean;
  /** Retry the original choice after a failed save; the other stays disabled. */
  retryAction?: NotificationOfferNoticeBusyAction;
  onEnable: () => void;
  onDismiss: () => void;
  testId?: string;
}

/** The notification offer's card, for hosts that render it in a shared corner. */
export function notificationOfferCardProps({
  busyAction,
  saveFailed,
  retryAction = null,
  onEnable,
  onDismiss,
  testId = 'notification-offer-notice',
}: NotificationOfferNoticeProps): SuggestionCardProps {
  const busy = busyAction !== null;
  return {
    testId,
    title: 'A task finished while you were away',
    body: 'Turn on notifications to hear when a run finishes or needs you.',
    ...(saveFailed
      ? {
          detail: {
            text: "Couldn't save your choice. Try again.",
            testId: `${testId}-save-error`,
          },
        }
      : {}),
    secondaryAction: {
      label: retryAction === 'dismiss' ? 'Try again' : 'Not now',
      busyLabel: 'Saving…',
      disabled: busy || retryAction === 'enable',
      busy: busyAction === 'dismiss',
      onClick: onDismiss,
      testId: `${testId}-dismiss`,
    },
    primaryAction: {
      label: retryAction === 'enable' ? 'Try again' : 'Turn on notifications',
      busyLabel: 'Turning on…',
      disabled: busy || retryAction === 'dismiss',
      busy: busyAction === 'enable',
      onClick: onEnable,
      testId: `${testId}-enable`,
    },
  };
}

/**
 * The one-time offer to turn on notifications after a background task
 * finishes (CAN-4005). A floating card in the host's notification corner with
 * exactly two choices and no close control, timer, or Escape dismissal: the
 * host records either answer. It announces politely and never takes focus.
 *
 * Pure display: the host decides when to show it and owns persistence. The
 * card itself is the shared `SuggestionCard` (CAN-4343).
 */
export function NotificationOfferNotice(
  props: NotificationOfferNoticeProps,
): JSX.Element {
  return <SuggestionCard {...notificationOfferCardProps(props)} />;
}
