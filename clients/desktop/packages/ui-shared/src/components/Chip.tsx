import type { JSX, ReactNode } from 'react';
import { CloseIcon, type AppIcon } from '../icons/AppIcons';

/** A state a gallery or lab can force so every look is visible at once. */
export type ChipForcedState = 'hover' | 'pressed' | 'remove-hover';

export interface ChipProps {
  /** The label. Plain text also names the remove button. */
  children: ReactNode;
  /** Optional leading glyph, drawn at 14px. */
  icon?: AppIcon;
  /** Makes the chip an action (open the file, switch the mode). */
  onClick?: () => void;
  /** Adds a trailing remove button. */
  onRemove?: () => void;
  /**
   * Accessible name for the remove button. Defaults to `Remove <label>` when
   * the label is plain text.
   */
  removeLabel?: string;
  disabled?: boolean;
  title?: string;
  /** Placement only: margin, max width, flex participation. */
  className?: string;
  /** Draws the hover or pressed look without the pointer, for galleries. */
  forcedState?: ChipForcedState;
  'data-testid'?: string;
  /** Test id for the remove button. */
  removeTestId?: string;
}

const ROOT_CLASS =
  'inline-flex h-6 min-w-0 max-w-full shrink-0 select-none items-center gap-1 rounded-md bg-subtle text-xs fg-primary';
// Hover is instant (no color transition) and a press dims and shrinks the
// chip, like `Button`. Both follow the chip's own action button, never the
// whole chip: a bare `hover:` would also light the chip while the pointer is
// on the remove button, hiding that button's hover, and a bare `active:`
// would press the whole chip when only remove is pressed. The forced variants
// draw the same looks for galleries. Tailwind's `scale-*` sets the CSS
// `scale` property, so the transition names it.
const INTERACTIVE_CLASS =
  'transition-[opacity,transform,scale] duration-150 has-[[data-chip-main]:hover]:bg-muted has-[[data-chip-main]:active]:scale-97 has-[[data-chip-main]:active]:opacity-70 data-[forced-state=hover]:bg-muted data-[forced-state=pressed]:scale-97 data-[forced-state=pressed]:bg-muted data-[forced-state=pressed]:opacity-70';
// Disabled, the chip stays the click target, so a click is swallowed rather
// than handed to a clickable row behind it, like a disabled `Button`.
const DISABLED_CLASS = 'cursor-not-allowed opacity-40';
const MAIN_CLASS =
  'focus-ring inline-flex h-full min-w-0 items-center gap-1 rounded-md text-left';
// On a coarse pointer the 18px remove button reaches a 30px hit area.
const REMOVE_CLASS =
  "relative before:absolute before:content-[''] pointer-coarse:before:-inset-1.5 focus-ring inline-flex size-4.5 shrink-0 items-center justify-center rounded-sm fg-tertiary hover:bg-muted hover:fg-primary data-[forced-state=hover]:bg-muted data-[forced-state=hover]:fg-primary";

/**
 * A token the user can act on: an attached file, a composer mode, a
 * calendar event. Not a marker: a word that only shows a state is a
 * `Badge`. Optional leading icon, optional remove button.
 */
export function Chip({
  children,
  icon: Icon,
  onClick,
  onRemove,
  removeLabel,
  disabled = false,
  title,
  className,
  forcedState,
  'data-testid': testId,
  removeTestId,
}: ChipProps): JSX.Element {
  const interactive = onClick !== undefined || onRemove !== undefined;
  // The padding sits on the action button when there is one, so the whole
  // chip up to the remove button is its hit area.
  const startPadding = Icon ? 'pl-1.5' : 'pl-2';
  const endPadding = onRemove ? 'pr-1' : 'pr-2';
  const rootClass = [
    ROOT_CLASS,
    onClick ? '' : startPadding,
    onClick || onRemove ? '' : endPadding,
    onRemove ? 'pr-0.5' : '',
    onClick && !disabled ? INTERACTIVE_CLASS : '',
    interactive && disabled ? DISABLED_CLASS : '',
    className ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  const content = (
    <>
      {Icon ? (
        <Icon size={14} className="shrink-0 fg-secondary" aria-hidden />
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
  const name =
    removeLabel ??
    (typeof children === 'string' ? `Remove ${children}` : 'Remove');
  return (
    <span
      data-chip=""
      data-forced-state={
        forcedState === 'remove-hover' ? undefined : forcedState
      }
      data-testid={testId}
      title={title}
      className={rootClass}
    >
      {onClick ? (
        <button
          type="button"
          data-chip-main=""
          className={`${MAIN_CLASS} ${startPadding} ${endPadding}`}
          onClick={onClick}
          disabled={disabled}
        >
          {content}
        </button>
      ) : (
        content
      )}
      {onRemove ? (
        <button
          type="button"
          aria-label={name}
          data-testid={removeTestId}
          data-forced-state={
            forcedState === 'remove-hover' ? 'hover' : undefined
          }
          className={REMOVE_CLASS}
          onClick={onRemove}
          disabled={disabled}
        >
          <CloseIcon size={12} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
