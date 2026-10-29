'use client';

import type { JSX } from 'react';
import { Notice, NoticeButton } from './Notice';

export interface AutomationOfferNoticeProps {
  onCreate: () => void;
  onDismiss: () => void;
  testId?: string;
}

/**
 * The offer to turn a repeated task into an automation (CAN-4009). A floating
 * card in the host's notification corner, like the notification offer, with
 * exactly two choices and no close control, timer, or Escape dismissal: the
 * host records either answer. It announces politely and never takes focus.
 *
 * Pure display: the host decides when to show it and owns persistence.
 */
export function AutomationOfferNotice({
  onCreate,
  onDismiss,
  testId = 'automation-offer-notice',
}: AutomationOfferNoticeProps): JSX.Element {
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
        title="Turn this into an automation?"
        actions={
          <>
            <NoticeButton
              variant="secondary"
              onClick={onDismiss}
              data-testid={`${testId}-dismiss`}
            >
              Not now
            </NoticeButton>
            <NoticeButton
              variant="primary"
              onClick={onCreate}
              data-testid={`${testId}-create`}
            >
              Create automation
            </NoticeButton>
          </>
        }
      >
        You&apos;ve run a similar task before. Make it an automation to run it
        on a schedule.
      </Notice>
    </div>
  );
}
