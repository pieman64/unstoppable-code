import { useCallback, type JSX, type MouseEvent } from 'react';
import { CheckIcon, CopyIcon } from '../icons/AppIcons';
import { CopyButton } from './CopyButton';
import { NoticeButton } from './Notice';
import { useCopyToClipboard } from './copy-to-clipboard';

/** How long the `Copied` confirmation stays before the label returns. */
export const COPY_LINK_CONFIRMATION_MS = 2000;

/** Glyph size inside a notice action, matching its 13px label. */
const NOTICE_GLYPH_PX = 14;

/**
 * Where the control sits. `button` is the quiet ghost button of a dialog
 * footer; `notice` is the standard notice/toast action (`NoticeButton`), for
 * surfaces where Copy link sits beside other notice actions such as Open.
 */
export type CopyLinkButtonVariant = 'button' | 'notice';

export interface CopyLinkButtonProps {
  /** The link to write to the clipboard. */
  url: string;
  /** Host surface; picks the shared treatment. Defaults to `button`. */
  variant?: CopyLinkButtonVariant;
  /** Placement in the host. The treatment is not the caller's. */
  className?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
  /** Fires after a successful copy. */
  onCopy?: () => void;
  /** Host clipboard writer; defaults to the browser clipboard. */
  write?: (text: string) => Promise<boolean>;
}

/**
 * Copy link as a notice action: the same `NoticeButton` a toast's other
 * actions use, with the copy glyph swapping to a check while `Copied` shows.
 */
function NoticeCopyLinkButton({
  url,
  className,
  dataTestId,
  onCopy,
  write,
}: Omit<CopyLinkButtonProps, 'variant'>): JSX.Element {
  const { copied, copy } = useCopyToClipboard({
    copiedDurationMs: COPY_LINK_CONFIRMATION_MS,
    onCopy,
    ...(write !== undefined ? { write } : {}),
  });

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      event.preventDefault();
      void copy(url);
    },
    [copy, url],
  );

  const glyph = copied ? (
    <CheckIcon width={NOTICE_GLYPH_PX} height={NOTICE_GLYPH_PX} />
  ) : (
    <CopyIcon width={NOTICE_GLYPH_PX} height={NOTICE_GLYPH_PX} />
  );

  return (
    <NoticeButton
      icon={glyph}
      data-testid={dataTestId}
      onClick={handleClick}
      {...(className !== undefined ? { className } : {})}
    >
      {copied ? 'Copied' : 'Copy link'}
    </NoticeButton>
  );
}

/**
 * The one Copy link control. Every share surface uses it: the share dialog
 * footer and the desktop and web share toasts. It fixes the treatment in one
 * place (copy icon plus `Copy link`, then a check plus `Copied` for two
 * seconds), so restyling it restyles every share surface at once. Toasts use
 * the `notice` variant so Copy link matches the toast's other actions. A link
 * is only ever copied by a click on this button, never automatically.
 */
export function CopyLinkButton({
  url,
  variant = 'button',
  className,
  dataTestId,
  onCopy,
  write,
}: CopyLinkButtonProps): JSX.Element {
  if (variant === 'notice') {
    return (
      <NoticeCopyLinkButton
        url={url}
        {...(className !== undefined ? { className } : {})}
        {...(dataTestId !== undefined ? { dataTestId } : {})}
        {...(onCopy !== undefined ? { onCopy } : {})}
        {...(write !== undefined ? { write } : {})}
      />
    );
  }
  return (
    <CopyButton
      value={url}
      label="Copy link"
      copiedLabel="Copied"
      ariaLabel="Copy link"
      title="Copy link"
      variant="ghost"
      size="sm"
      copiedDurationMs={COPY_LINK_CONFIRMATION_MS}
      {...(className !== undefined ? { className } : {})}
      {...(dataTestId !== undefined ? { dataTestId } : {})}
      {...(onCopy !== undefined ? { onCopy } : {})}
      {...(write !== undefined ? { write } : {})}
    />
  );
}
