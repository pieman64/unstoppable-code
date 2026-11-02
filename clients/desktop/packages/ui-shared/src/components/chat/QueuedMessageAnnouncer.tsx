import { memo, type JSX } from 'react';
import {
  STATUS_ANNOUNCEMENT_CLEAR_MS,
  STATUS_ANNOUNCEMENT_DELAY_MS,
  StatusAnnouncer,
} from './StatusAnnouncer';

/**
 * One polite announcement about the queue. A new `id` announces again, even
 * with the same text, so a later identical send is still heard.
 */
export interface QueuedMessageAnnouncement {
  readonly id: number;
  readonly text: string;
}

/** How long an announcement stays in the region before it clears. */
export const QUEUED_MESSAGE_ANNOUNCEMENT_CLEAR_MS =
  STATUS_ANNOUNCEMENT_CLEAR_MS;
/**
 * A screen reader may miss text that arrives in the same frame as its live
 * region or as the previous text clears, so the text lands a moment later.
 */
export const QUEUED_MESSAGE_ANNOUNCEMENT_DELAY_MS =
  STATUS_ANNOUNCEMENT_DELAY_MS;

/**
 * The queue's polite status region (see `StatusAnnouncer`). Hosts decide
 * what to announce; the setup clock is never announced.
 */
export const QueuedMessageAnnouncer = memo(function QueuedMessageAnnouncer({
  announcement,
}: {
  readonly announcement: QueuedMessageAnnouncement | null;
}): JSX.Element {
  return (
    <StatusAnnouncer
      announcement={announcement}
      privacy="mask"
      data-testid="queued-message-announcer"
    />
  );
});
