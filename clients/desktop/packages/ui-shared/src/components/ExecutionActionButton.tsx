import type {
  AriaAttributes,
  JSX,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from 'react';
import {
  actionChipClassName,
  SECONDARY_ACTION_BUTTON_CLASS,
} from '../lib/row-chips';
import { Tooltip } from './Tooltip';

export type ExecutionActionButtonVariant =
  | 'default'
  | 'primary'
  | 'warning'
  | 'destructive'
  | 'destructive-chip'
  | 'ghost'
  | 'text'
  | 'ghost-destructive';

export interface ExecutionActionButtonProps extends Pick<
  AriaAttributes,
  'aria-describedby' | 'aria-haspopup'
> {
  /** Visible label. Pass an empty string to render an icon-only button. */
  label: ReactNode;
  /** Icon glyph rendered to the left of the label. */
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Test ID hook for automation. */
  dataTestId?: string;
  /** Optional `data-state` hook for hosts that expose a CTA state. */
  dataState?: string;
  /** Accessible label — required when the visible label is empty so the
   * button still announces meaningfully. */
  ariaLabel: string;
  variant?: ExecutionActionButtonVariant;
  /**
   * Detail actions retain a 44px touch target on coarse pointers, and a
   * `default` detail action is the 28px labeled secondary button so it
   * matches the Share beside it.
   */
  placement?: 'row' | 'detail';
  /**
   * Inside a `@container/topbar` narrower than 640px, drop the label and
   * collapse the `primary` shell to a 28px square so the status region keeps
   * its room; the icon, accessible name, and tooltip carry the meaning. The
   * other variants keep their chip geometry.
   */
  iconOnlyWhenNarrow?: boolean;
  className?: string;
  labelClassName?: string;
  /** Draws the label in the shimmer that marks work in progress. */
  shimmer?: boolean;
  /** Hover/focus help shown in the shared rich tooltip (never a native title). */
  title?: string;
  /**
   * Whether keydown events stop at the button. Defaults to `true` for the
   * execution rows this was built for, where a row-level key handler must
   * not fire from a focused action. Pass `false` inside a detail page or
   * dialog that closes on a document-level Escape listener, or the focused
   * action swallows that shortcut.
   */
  stopKeyDownPropagation?: boolean;
}

/**
 * Geometry is variant-specific rather than shared. `default`, `warning`, and
 * `destructive-chip` are the standardized pipeline-row ACTION CHIP
 * (`h-6 rounded-md px-2.5 text-2xs`) on the house secondary surface
 * (`SECONDARY_SURFACE_CLASS`: quaternary shell, shadow, hairline ring) in its
 * neutral, warning, and destructive inks — the tone never changes the shell;
 * see `actionChipClassName` in `@canopy/ui-shared/lib`. `primary` and
 * `destructive` carry their own desktop-exact treatment: the shared
 * Launch action (`h-7 bg-accent px-2.5`, no border) and the
 * borderless rose Stop caption (`px-2 py-0.5`, no border and no persistent
 * fill, mirroring shared `RunningProcessCard`). `ghost` is the Launch
 * frame (height, corners, padding and type) with no fill, for a quiet
 * top-bar action beside Launch and `Open in`. Each variant is a complete
 * class string so a new variant never inherits the wrong shape.
 */
/**
 * The primary shell around its padding slot, so the resting class string keeps
 * its established token order (`h-7 rounded-md bg-accent px-2.5 text-xs …`,
 * which callers' tests pin as a substring) while the narrow-top-bar collapse
 * swaps only the padding.
 */
const PRIMARY_SHELL_HEAD =
  'focus-ring inline-flex items-center gap-1.5 whitespace-nowrap transition-colors h-7 rounded-md bg-accent';
const PRIMARY_SHELL_TAIL =
  'text-xs font-normal fg-emphasis hover:bg-[color-mix(in_srgb,var(--bg-accent),#000_12%)]';
const PRIMARY_PADDING_CLASS = 'px-2.5';
const PRIMARY_COLLAPSE_CLASS =
  'w-7 px-0 @[640px]/topbar:w-auto @[640px]/topbar:px-2.5';
const COLLAPSED_LABEL_CLASS = 'hidden @[640px]/topbar:inline';

function primaryClassName(collapses: boolean): string {
  return `${PRIMARY_SHELL_HEAD} ${collapses ? PRIMARY_COLLAPSE_CLASS : PRIMARY_PADDING_CLASS} ${PRIMARY_SHELL_TAIL}`;
}

const VARIANT_CLASSES: Record<ExecutionActionButtonVariant, string> = {
  default: actionChipClassName('neutral'),
  warning: actionChipClassName('warning'),
  'destructive-chip': actionChipClassName('destructive'),
  primary: primaryClassName(false),
  ghost:
    'focus-ring inline-flex items-center gap-1.5 whitespace-nowrap transition-colors h-7 rounded-md px-2.5 text-xs font-normal fg-secondary hover:bg-subtle hover:fg-primary',
  text: 'focus-ring inline-flex items-center gap-1.5 whitespace-nowrap transition-colors h-7 rounded-md px-2.5 text-xs font-normal fg-tertiary hover:fg-primary',
  'ghost-destructive':
    'focus-ring inline-flex items-center gap-1.5 whitespace-nowrap transition-colors h-7 rounded-md px-2.5 text-xs font-normal fg-destructive hover:bg-destructive-subtle',
  destructive:
    'focus-ring inline-flex items-center gap-1.5 whitespace-nowrap transition-colors rounded-md px-2 py-0.5 text-2xs font-medium fg-destructive hover:bg-destructive-subtle',
};

/**
 * Small chrome-light button used for run/rerun/retry/stop and similar
 * execution-row actions. Pure display: parent owns the dispatch. The visible
 * geometry comes entirely from {@link VARIANT_CLASSES}; the wrapper adds only
 * centering and the disabled treatment so each variant matches its
 * reference exactly.
 */
export function ExecutionActionButton({
  label,
  'aria-describedby': describedBy,
  'aria-haspopup': hasPopup,
  icon,
  onClick,
  disabled = false,
  dataTestId,
  dataState,
  ariaLabel,
  variant = 'default',
  placement = 'row',
  iconOnlyWhenNarrow = false,
  className = '',
  labelClassName = '',
  shimmer = false,
  title,
  stopKeyDownPropagation = true,
}: ExecutionActionButtonProps): JSX.Element {
  const collapses = iconOnlyWhenNarrow && variant === 'primary';
  const variantClassName = collapses
    ? primaryClassName(true)
    : placement === 'detail' && variant === 'default'
      ? `${SECONDARY_ACTION_BUTTON_CLASS} gap-1.5 whitespace-nowrap`
      : VARIANT_CLASSES[variant];
  return (
    <Tooltip label={title} disabled={title === undefined}>
      <button
        type="button"
        disabled={disabled}
        data-testid={dataTestId}
        data-state={dataState}
        data-execution-action-button="true"
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-haspopup={hasPopup}
        onClick={(event: MouseEvent<HTMLButtonElement>): void => {
          event.stopPropagation();
          onClick();
        }}
        onKeyDown={
          stopKeyDownPropagation
            ? (event: KeyboardEvent<HTMLButtonElement>): void => {
                event.stopPropagation();
              }
            : undefined
        }
        // Never a window drag handle: the top bar is a drag region and the
        // class is inert everywhere else, including the web.
        className={`electron-no-drag justify-center disabled:cursor-not-allowed disabled:opacity-50 ${variantClassName} ${placement === 'detail' ? 'pointer-coarse:min-h-11 pointer-coarse:min-w-11' : ''} ${className}`}
      >
        {icon}
        {label ? (
          <span
            data-execution-action-label
            className={`${collapses ? COLLAPSED_LABEL_CLASS : labelClassName}${shimmer ? ' canopy-text-shimmer' : ''}`}
          >
            {label}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}
