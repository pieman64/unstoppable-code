'use client';

import type { JSX } from 'react';
import { Notice, NoticeButton } from './Notice';

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

/**
 * The one-time offer to turn on notifications after a background task
 * finishes (CAN-4005). A floating card in the host's notification corner with
 * exactly two choices and no close control, timer, or Escape dismissal: the
 * host records either answer. It announces politely and never takes focus.
 *
 * Pure display: the host decides when to show it and owns persistence.
 */
export function NotificationOfferNotice({
  busyAction,
  saveFailed,
  retryAction = null,
  onEnable,
  onDismiss,
  testId = 'notification-offer-notice',
}: NotificationOfferNoticeProps): JSX.Element {
  const busy = busyAction !== null;
  return (
    <div
      data-testid={testId}
      className="pointer-events-auto rounded-2xl bg-quaternary shadow-xl"
    >
      <Notice
        shape="toast"
        surface="none"
        titleLayout="stacked"
        actionsPlacement="below"
        title="A task finished while you were away"
        detail={
          saveFailed ? (
            <span data-testid={`${testId}-save-error`}>
              Couldn&apos;t save your choice. Try again.
            </span>
          ) : undefined
        }
        actions={
          <>
            <NoticeButton
              variant="secondary"
              disabled={busy || retryAction === 'enable'}
              aria-busy={busyAction === 'dismiss'}
              onClick={onDismiss}
              data-testid={`${testId}-dismiss`}
            >
              {busyAction === 'dismiss'
                ? 'Saving…'
                : retryAction === 'dismiss'
                  ? 'Try again'
                  : 'Not now'}
            </NoticeButton>
            <NoticeButton
              variant="primary"
              disabled={busy || retryAction === 'dismiss'}
              aria-busy={busyAction === 'enable'}
              onClick={onEnable}
              data-testid={`${testId}-enable`}
            >
              {busyAction === 'enable'
                ? 'Turning on…'
                : retryAction === 'enable'
                  ? 'Try again'
                  : 'Turn on notifications'}
            </NoticeButton>
          </>
        }
      >
        Turn on notifications to hear when a run finishes or needs you.
      </Notice>
    </div>
  );
}
