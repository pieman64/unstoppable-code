import type { JSX } from 'react';
import { RefreshSpinnerIcon } from '../icons/AppIcons';
import { HeaderActionButton } from './HeaderActionButton';

export interface RefreshButtonProps {
  /** Click handler. */
  onClick: () => void;
  /** When true the icon spins and the button is disabled. */
  busy?: boolean;
  /** Disable the button independent of `busy`. */
  disabled?: boolean;
  /** Accessible label. Defaults to "Refresh". */
  ariaLabel?: string;
  /** Native tooltip. Defaults to the accessible label. */
  title?: string;
  /** Icon glyph size in pixels. Defaults to 14. */
  size?: number;
  /** Optional tailwind color class applied to the icon. */
  iconClassName?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

/**
 * Pure refresh button used in section headers (Summary, PR, etc.). Renders
 * the shared {@link RefreshSpinnerIcon}, which spins while `busy` is true.
 */
export function RefreshButton({
  onClick,
  busy = false,
  disabled = false,
  ariaLabel = 'Refresh',
  title,
  size = 16,
  iconClassName,
  dataTestId,
}: RefreshButtonProps): JSX.Element {
  return (
    <HeaderActionButton
      iconOnly
      data-testid={dataTestId}
      onClick={onClick}
      disabled={disabled || busy}
      quietWhenDisabled
      aria-label={busy ? `${ariaLabel} (in progress)` : ariaLabel}
      title={title ?? ariaLabel}
    >
      <RefreshSpinnerIcon
        spinning={busy}
        size={size}
        className={iconClassName}
      />
    </HeaderActionButton>
  );
}
