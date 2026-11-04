import { memo, type JSX } from 'react';
import type { QueuedMessageWaitingReason } from '@canopy/protocol/portal';
import { Tooltip } from '../Tooltip';

/**
 * Copy for each host-reported reason a queued message is waiting. Product
 * copy, not conversation content: it describes what will happen, never the
 * turn or steering internals behind it.
 */
export const QUEUED_MESSAGE_WAITING_REASON_COPY: Readonly<
  Record<QueuedMessageWaitingReason, string>
> = {
  steer_unavailable: 'Sends as soon as the agent can take it.',
  background_work:
    'Sends when background work finishes, so your new settings can apply. Run now sends it without them.',
};

export type QueuedMessageReasonProps =
  | {
      /** Free-text reason supplied by the caller, rendered as given. */
      readonly reason: string;
      readonly waitingReason?: never;
    }
  | {
      /** Host-reported reason; the unit maps it to its copy. */
      readonly waitingReason: QueuedMessageWaitingReason;
      /** Compact queue rows keep the full explanation in their tooltip. */
      readonly layout?: 'stack' | 'inline';
      readonly reason?: never;
    };

/** The label and reason share one readable size and ink. */
export const QUEUED_MESSAGE_LABEL_CLASS = 'mb-1 text-xs fg-secondary';
const REASON_CLASS = QUEUED_MESSAGE_LABEL_CLASS;

export const QueuedMessageReason = memo(function QueuedMessageReason(
  props: QueuedMessageReasonProps,
): JSX.Element {
  if (props.waitingReason !== undefined) {
    if (props.layout === 'inline') {
      const text = QUEUED_MESSAGE_WAITING_REASON_COPY[props.waitingReason];
      return (
        <Tooltip label={text} allowShrink>
          <span
            className="min-w-0 truncate text-xs fg-tertiary"
            data-testid="queued-message-waiting-reason"
            data-waiting-reason={props.waitingReason}
          >
            {text}
          </span>
        </Tooltip>
      );
    }
    return (
      <div
        className={REASON_CLASS}
        data-testid="queued-message-waiting-reason"
        data-waiting-reason={props.waitingReason}
      >
        {QUEUED_MESSAGE_WAITING_REASON_COPY[props.waitingReason]}
      </div>
    );
  }
  return <div className={REASON_CLASS}>{props.reason}</div>;
});
