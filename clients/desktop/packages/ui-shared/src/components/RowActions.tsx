/**
 * Hover-revealed row actions for list-style rows.
 *
 * `RowActionTray` is absolutely positioned and only reveals on row hover (and
 * optionally focus); its destructive tone is hover-only and its focus ring is
 * opt-in. It backs sidebar, attachment, and similar compact rows.
 *
 * See `./TableActions.tsx` for the always-visible, right-aligned
 * `TableActionButton` / `TableActionsCell` used inside data-table `<td>`s,
 * whose destructive tone is an *armed* filled state for two-step deletes. The
 * two are deliberately separate rather than one overloaded control.
 */
import type { JSX, ReactNode } from 'react';
import { Tooltip } from './Tooltip';

export interface RowActionTrayProps {
  readonly children: ReactNode;
  readonly testId?: string;
  /** Reveal keyboard-focused actions in addition to the default row hover. */
  readonly revealOnFocus?: boolean;
  /** Keep replacement controls visible after their trigger unmounts. */
  readonly forceVisible?: boolean;
}

/**
 * Absolutely positioned row actions whose contents can change without
 * affecting the surrounding row's layout.
 */
export function RowActionTray({
  children,
  testId,
  revealOnFocus = false,
  forceVisible = false,
}: RowActionTrayProps): JSX.Element {
  const visibilityClasses = forceVisible
    ? 'pointer-events-auto opacity-100'
    : `pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100${
        revealOnFocus
          ? ' focus-within:pointer-events-auto focus-within:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
          : ''
      }`;

  return (
    <div
      className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-card px-0.5 py-0.5 shadow-sm transition-opacity ${visibilityClasses}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export interface RowActionButtonProps {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly focusRing?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
}

/** Icon-only row action. `label` supplies its accessible name and tooltip. */
export function RowActionButton({
  label,
  destructive = false,
  disabled = false,
  focusRing = false,
  onClick,
  children,
  testId,
}: RowActionButtonProps): JSX.Element {
  const interactionClasses = destructive
    ? 'fg-secondary hover:bg-destructive-subtle hover:fg-destructive'
    : 'fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary';

  return (
    <Tooltip label={label}>
      <button
        type="button"
        disabled={disabled}
        onClick={(event): void => {
          event.stopPropagation();
          onClick();
        }}
        className={`${focusRing ? 'focus-ring ' : ''}rounded p-1 disabled:opacity-50 ${interactionClasses}`}
        aria-label={label}
        data-testid={testId}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export interface InlineDeleteConfirmProps {
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly deleting: boolean;
  readonly disabled?: boolean;
  /**
   * Confirm-button label. Defaults to `Delete?`; archive-retention surfaces
   * can supply `Archive?` when deletion archives the container.
   */
  readonly confirmLabel?: string;
  readonly confirmTestId?: string;
  readonly cancelTestId?: string;
  readonly focusRing?: boolean;
  readonly autoFocusConfirm?: boolean;
}

/** Compact confirmation controls intended to replace a row's action tray. */
export function InlineDeleteConfirm({
  onConfirm,
  onCancel,
  deleting,
  disabled = false,
  confirmLabel = 'Delete?',
  confirmTestId,
  cancelTestId,
  focusRing = false,
  autoFocusConfirm = false,
}: InlineDeleteConfirmProps): JSX.Element {
  const focusClass = focusRing ? 'focus-ring ' : '';

  return (
    <span className="flex items-center gap-0.5">
      <button
        type="button"
        autoFocus={autoFocusConfirm}
        onClick={(event): void => {
          event.stopPropagation();
          onConfirm();
        }}
        disabled={deleting || disabled}
        className={`${focusClass}rounded px-1.5 py-0.5 text-3xs font-medium fg-destructive hover:bg-destructive-subtle disabled:opacity-50`}
        data-testid={confirmTestId}
      >
        {deleting ? '...' : confirmLabel}
      </button>
      <button
        type="button"
        onClick={(event): void => {
          event.stopPropagation();
          onCancel();
        }}
        className={`${focusClass}rounded px-1 py-0.5 text-3xs fg-secondary hover:fg-primary`}
        data-testid={cancelTestId}
      >
        No
      </button>
    </span>
  );
}
