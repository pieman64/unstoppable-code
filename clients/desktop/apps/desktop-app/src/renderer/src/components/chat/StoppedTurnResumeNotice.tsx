import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';

export interface StoppedTurnResumeNoticeProps {
  /** Continues the stopped turn in the same provider session. */
  onResume: () => void;
  /** Failure text from the last resume attempt; the action stays available. */
  error?: string;
}

/**
 * The explicit Resume offer for a turn the user stopped (CAN-3137).
 *
 * Resume continues the same provider session with a hidden continuation, so
 * the partial response stays in place and the original message is not sent a
 * second time. Nothing resumes automatically: sending a new message instead
 * retires the offer, and the store refuses a second dispatch while one is in
 * flight.
 */
export function StoppedTurnResumeNotice({
  onResume,
  error,
}: StoppedTurnResumeNoticeProps): JSX.Element {
  return (
    <Notice
      intent={error ? 'attention' : 'neutral'}
      title="Turn stopped"
      data-testid="stopped-turn-resume"
      {...(error ? { detail: error } : {})}
      actions={
        <NoticeButton
          variant="primary"
          onClick={onResume}
          data-testid="stopped-turn-resume-button"
        >
          Resume
        </NoticeButton>
      }
    >
      Resume to continue where the agent left off.
    </Notice>
  );
}
