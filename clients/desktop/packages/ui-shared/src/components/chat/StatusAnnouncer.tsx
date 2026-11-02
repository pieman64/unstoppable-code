import { memo, useEffect, useState, type JSX } from 'react';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '../../lib/replay-privacy';

/**
 * One polite announcement. A new `id` announces again, even with the same
 * text, so a later identical message is still heard.
 */
export interface StatusAnnouncement {
  readonly id: number | string;
  readonly text: string;
}

/** How long an announcement stays in the region before it clears. */
export const STATUS_ANNOUNCEMENT_CLEAR_MS = 4_000;
/**
 * A screen reader may miss text that arrives in the same frame as its live
 * region or as the previous text clears, so the text lands a moment later.
 */
export const STATUS_ANNOUNCEMENT_DELAY_MS = 100;
/** How long one announcement occupies the region, from arrival to clear. */
export const STATUS_ANNOUNCEMENT_DURATION_MS =
  STATUS_ANNOUNCEMENT_DELAY_MS + STATUS_ANNOUNCEMENT_CLEAR_MS;

export interface StatusAnnouncerProps {
  readonly announcement: StatusAnnouncement | null;
  /**
   * How session replay treats the announced text: `mask` for user-authored
   * titles, `block` for conversation content such as commands and paths.
   */
  readonly privacy: 'mask' | 'block';
  readonly 'data-testid'?: string;
}

/**
 * A polite status region. It stays mounted and empty while idle so
 * assistive technology knows it before anything is said, takes each
 * announcement's text a moment after it arrives, and clears it after four
 * seconds. Hosts decide what to announce.
 */
export const StatusAnnouncer = memo(function StatusAnnouncer({
  announcement,
  privacy,
  'data-testid': testId,
}: StatusAnnouncerProps): JSX.Element {
  const [text, setText] = useState('');
  const id = announcement?.id;
  const nextText = announcement?.text;
  useEffect(() => {
    // Empty the region first, so repeating the last text is a change too;
    // a withdrawn announcement just clears.
    const reset = setTimeout(() => {
      setText('');
    }, 0);
    if (id === undefined || !nextText) {
      return (): void => {
        clearTimeout(reset);
      };
    }
    const show = setTimeout(() => {
      setText(nextText);
    }, STATUS_ANNOUNCEMENT_DELAY_MS);
    const clear = setTimeout(() => {
      setText('');
    }, STATUS_ANNOUNCEMENT_DURATION_MS);
    return (): void => {
      clearTimeout(reset);
      clearTimeout(show);
      clearTimeout(clear);
    };
  }, [id, nextText]);
  // Positioned so the visually hidden region stays inside its container
  // instead of escaping a scroller.
  return (
    <div className="relative">
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={`sr-only ${privacy === 'block' ? REPLAY_BLOCK_CLASS : REPLAY_MASK_CLASS}`}
        data-testid={testId}
      >
        {text}
      </div>
    </div>
  );
});
