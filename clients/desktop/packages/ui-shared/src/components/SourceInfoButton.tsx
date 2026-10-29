import type { JSX, MouseEvent } from 'react';
import { InfoIcon } from '../icons/InfoIcon';
import { Tooltip } from './Tooltip';

export interface SourceInfoButtonProps {
  onClick: () => void;
  /** Accessible label — caller supplies the entry label. */
  ariaLabel: string;
  /** Native tooltip. Defaults to "Source info". */
  title?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

/**
 * Info-icon button revealed on hover/focus inside an entry row (Scripts,
 * Hooks, …). Pure display: parent owns the modal/popover dispatch.
 */
export function SourceInfoButton({
  onClick,
  ariaLabel,
  title = 'Source info',
  dataTestId,
}: SourceInfoButtonProps): JSX.Element {
  return (
    <Tooltip label={title}>
      <button
        type="button"
        data-testid={dataTestId}
        onClick={(event: MouseEvent<HTMLButtonElement>): void => {
          event.stopPropagation();
          onClick();
        }}
        className="focus-ring shrink-0 rounded p-0.5 fg-secondary opacity-0 transition hover:fg-primary/80 focus:opacity-100 group-hover:opacity-100"
        aria-label={ariaLabel}
      >
        <InfoIcon />
      </button>
    </Tooltip>
  );
}
