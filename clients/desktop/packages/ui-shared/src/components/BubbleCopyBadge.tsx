import { useCallback, type JSX, type MouseEvent } from 'react';
import { CheckIcon } from '../icons/CheckIcon';
import { CopyIcon } from '../icons/CopyIcon';
import {
  BUBBLE_ACTION_BADGE_CLASS,
  BUBBLE_ACTION_GLYPH_PX,
} from './bubble-badge';
import { CopyStatusRegion, useAnnouncedCopy } from './copy-feedback';
import { Tooltip } from './Tooltip';

/** The user bubble's copy badge name (CAN-5354). */
const USER_BUBBLE_COPY_LABEL = 'Copy your message';

export interface BubbleCopyBadgeProps {
  /** Plain text written to the clipboard. */
  copyText: string;
  /** Accessible name and tooltip before the copy lands. */
  label?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

/**
 * A message bubble's corner copy action. It shares the copy behavior with
 * `CopyButton` but keeps the bubble badge chrome, the same as the revert
 * badge beside it, instead of the app Button. Its name says whose words it
 * copies, apart from the reply's and plan's Copy actions, and a polite status
 * announces `Copied` (CAN-5354). The cluster reveals on focus-within, so
 * tabbing to the badge shows it.
 */
export function BubbleCopyBadge(props: BubbleCopyBadgeProps): JSX.Element {
  return <BubbleCopyBadgeControl key={props.copyText} {...props} />;
}

function BubbleCopyBadgeControl({
  copyText,
  label = USER_BUBBLE_COPY_LABEL,
  dataTestId,
}: BubbleCopyBadgeProps): JSX.Element {
  const { copied, announcement, copy } = useAnnouncedCopy();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      event.preventDefault();
      void copy(copyText, event.currentTarget.ownerDocument);
    },
    [copy, copyText],
  );
  const name = copied ? 'Copied' : label;
  return (
    <span className="relative inline-flex">
      <Tooltip label={name}>
        <button
          type="button"
          onClick={handleClick}
          className={BUBBLE_ACTION_BADGE_CLASS}
          aria-label={name}
          data-testid={dataTestId}
        >
          {copied ? (
            <CheckIcon
              width={BUBBLE_ACTION_GLYPH_PX}
              height={BUBBLE_ACTION_GLYPH_PX}
              aria-hidden="true"
            />
          ) : (
            <CopyIcon
              width={BUBBLE_ACTION_GLYPH_PX}
              height={BUBBLE_ACTION_GLYPH_PX}
            />
          )}
        </button>
      </Tooltip>
      {/* Mounted only around a copy, so a long transcript does not carry a
          status per prompt; it mounts empty and fills a beat later. */}
      {copied && <CopyStatusRegion announcement={announcement} />}
    </span>
  );
}
