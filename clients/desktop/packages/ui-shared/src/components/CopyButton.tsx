import { useCallback, type JSX, type MouseEvent } from 'react';
import { CheckIcon } from '../icons/CheckIcon';
import { CopyIcon } from '../icons/CopyIcon';
import { Button, type ButtonSize, type ButtonVariant } from './Button';
import { Tooltip } from './Tooltip';
import { CopyStatusRegion, useAnnouncedCopy } from './copy-feedback';

export { copyTextToClipboard } from './copy-to-clipboard';

/** Glyph size per button size, matching the icon-only buttons elsewhere. */
const GLYPH_PX: Record<ButtonSize, number> = {
  sm: 14,
  md: 16,
  lg: 18,
  compact: 14,
  field: 14,
};

export interface CopyButtonProps {
  /** Text to write to the clipboard. */
  value: string;
  /** Accessible name when not in the copied state. */
  ariaLabel?: string;
  /** Referenced accessible name when not in the copied state. */
  ariaLabelledBy?: string;
  /** Tooltip when not in the copied state. */
  title?: string;
  /** Button treatment. Defaults to the quiet ghost button. */
  variant?: ButtonVariant;
  /** Button size; the glyph follows it. Defaults to the small button. */
  size?: ButtonSize;
  /** Optional label. With one, this is a labeled button; without, icon-only. */
  label?: string;
  /** Label and accessible name while the copied confirmation shows. */
  copiedLabel?: string;
  /** Placement in the host. The button's look is not the caller's. */
  className?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
  /** Fires after a successful copy. */
  onCopy?: () => void;
  /** Number of milliseconds the copied confirmation remains visible. */
  copiedDurationMs?: number;
  /** Host clipboard writer; defaults to the browser clipboard. */
  write?: (text: string) => Promise<boolean>;
}

/**
 * Copy-to-clipboard as the shared {@link Button}. The caller picks a variant
 * and size like any other action; the copy behavior and the timed copied
 * confirmation come from {@link useCopyToClipboard}.
 */
export function CopyButton(props: CopyButtonProps): JSX.Element {
  return <CopyButtonControl key={props.value} {...props} />;
}

function CopyButtonControl({
  value,
  ariaLabel = 'Copy to clipboard',
  ariaLabelledBy,
  title = 'Copy to clipboard',
  variant = 'ghost',
  size = 'sm',
  label,
  copiedLabel = 'Copied',
  className,
  dataTestId,
  onCopy,
  copiedDurationMs,
  write,
}: CopyButtonProps): JSX.Element {
  const { copied, failed, announcement, copy } = useAnnouncedCopy({
    failureAnnouncement: "Couldn't copy to the clipboard",
    copiedDurationMs,
    onCopy,
    ...(write !== undefined ? { write } : {}),
  });

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      event.preventDefault();
      void copy(value);
    },
    [copy, value],
  );

  const glyphPx = GLYPH_PX[size];
  const glyph = copied ? (
    <CheckIcon width={glyphPx} height={glyphPx} aria-hidden="true" />
  ) : (
    <CopyIcon width={glyphPx} height={glyphPx} />
  );
  const name = copied ? copiedLabel : ariaLabel;

  return (
    <Tooltip label={copied ? copiedLabel : title}>
      {label === undefined ? (
        <Button
          iconOnly
          variant={variant}
          size={size}
          className={className}
          data-testid={dataTestId}
          onClick={handleClick}
          aria-label={name}
          aria-labelledby={copied ? undefined : ariaLabelledBy}
        >
          {glyph}
        </Button>
      ) : (
        <Button
          variant={variant}
          size={size}
          className={className}
          data-testid={dataTestId}
          onClick={handleClick}
          aria-label={name}
          aria-labelledby={copied ? undefined : ariaLabelledBy}
        >
          {glyph}
          <span>{copied ? copiedLabel : label}</span>
        </Button>
      )}
      {(copied || failed) && <CopyStatusRegion announcement={announcement} />}
    </Tooltip>
  );
}
