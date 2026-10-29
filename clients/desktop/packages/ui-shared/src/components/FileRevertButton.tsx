import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import { RevertIcon } from '../icons/RevertIcon';

export interface FileRevertButtonProps {
  onClick: () => void;
  disabled?: boolean;
  /** Accessible label — caller supplies the file path. */
  ariaLabel: string;
  /** Test ID hook for automation. Defaults to `activity-file-revert`. */
  dataTestId?: string;
}

/**
 * Hover-revealed revert button rendered alongside an entry in Changed Files.
 * Pure display: the parent owns the actual revert dispatch.
 */
export function FileRevertButton({
  onClick,
  disabled = false,
  ariaLabel,
  dataTestId = 'activity-file-revert',
}: FileRevertButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="hidden shrink-0 rounded p-0.5 fg-secondary transition-colors hover:bg-fg-primary/[0.1] hover:fg-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:fg-secondary group-hover:inline-flex group-focus-within:inline-flex"
      aria-label={ariaLabel}
      data-testid={dataTestId}
      disabled={disabled}
      onClick={(event: MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        if (disabled) {
          return;
        }
        onClick();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation();
        }
      }}
    >
      <RevertIcon />
    </button>
  );
}
