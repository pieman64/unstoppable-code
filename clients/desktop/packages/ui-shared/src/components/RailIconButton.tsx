import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import type { AppIcon } from '../icons/AppIcons';
import { Tooltip } from './Tooltip';

/**
 * `neutral` brightens from tertiary to primary under the pointer. `section`
 * rests in a section header's own quaternary ink, so its controls read as one
 * line with the label and chevron beside them. `secondary` keeps its ink and
 * lets only the surface respond, for the account row's feedback and settings
 * actions. `warning` and `destructive` name the action.
 */
export type RailIconButtonTone =
  | 'neutral'
  | 'section'
  | 'secondary'
  | 'warning'
  | 'destructive';
export type RailIconButtonSize = 'compact' | 'row';

export interface RailIconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  icon: AppIcon;
  /** App glyph size. Defaults to 16px; optical exceptions can override. */
  iconSize?: number;
  iconClassName?: string;
  /** Compact is 24px; row matches the canonical 32px sidebar item height. */
  size?: RailIconButtonSize;
  /** Reveal the control only when its `group/sidebar-item` header is hovered. */
  revealOnItemHover?: boolean;
  /** Preserve an accessible touch target on coarse-pointer layouts. */
  coarsePointerTarget?: boolean;
  /**
   * Keep a 44px minimum height on every pointer, not only coarse ones, for a
   * header laid out for touch.
   */
  touchTarget?: boolean;
  /** Opt into a tone-specific hover surface; the default is icon-only hover. */
  hoverSurface?: boolean;
  tone?: RailIconButtonTone;
  /** Visible tooltip text. Defaults to `title`, then `aria-label`. */
  tooltipLabel?: ReactNode;
}

const TONE_CLASS_NAMES: Record<RailIconButtonTone, string> = {
  neutral: 'fg-tertiary hover:bg-subtle hover:fg-primary',
  section: 'fg-quaternary hover:bg-subtle hover:fg-primary',
  secondary: 'fg-secondary hover:bg-subtle',
  warning: 'fg-warning hover:bg-warning-subtle hover:fg-warning',
  destructive: 'fg-tertiary hover:bg-destructive-subtle hover:fg-destructive',
};

/** Without a hover surface only the ink answers the pointer. */
const QUIET_TONE_CLASS_NAMES: Record<RailIconButtonTone, string> = {
  neutral: 'fg-tertiary hover:fg-primary',
  section: 'fg-quaternary hover:fg-primary',
  secondary: 'fg-secondary',
  warning: 'fg-tertiary hover:fg-primary',
  destructive: 'fg-tertiary hover:fg-primary',
};

/** Canonical compact icon action for sidebar and rail item headers. */
export const RailIconButton = forwardRef<
  HTMLButtonElement,
  RailIconButtonProps
>(function RailIconButton(
  {
    revealOnItemHover = false,
    coarsePointerTarget = false,
    touchTarget = false,
    hoverSurface = false,
    tone = 'neutral',
    size = 'compact',
    icon: Icon,
    iconSize = 16,
    iconClassName,
    tooltipLabel,
    title,
    'aria-label': ariaLabel,
    type = 'button',
    className = '',
    ...props
  },
  ref,
): JSX.Element {
  const resolvedTooltipLabel = tooltipLabel ?? title ?? ariaLabel;
  const revealClassName =
    'inline-flex opacity-0 pointer-events-none transition-opacity group-hover/sidebar-item:opacity-100 group-hover/sidebar-item:pointer-events-auto group-focus-within/sidebar-item:opacity-100 group-focus-within/sidebar-item:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:pointer-events-auto';
  const revealControlClassName = revealOnItemHover
    ? 'opacity-0 group-hover/sidebar-item:opacity-100 group-focus-within/sidebar-item:opacity-100 focus:opacity-100 pointer-coarse:opacity-100'
    : '';
  const sizeClassName =
    size === 'row' ? 'h-8 w-8 rounded-row' : 'h-6 w-6 rounded-md';
  const hoverClassName = hoverSurface
    ? TONE_CLASS_NAMES[tone]
    : QUIET_TONE_CLASS_NAMES[tone];

  const control = (
    <Tooltip
      label={resolvedTooltipLabel}
      disabled={resolvedTooltipLabel == null || resolvedTooltipLabel === ''}
    >
      <button
        ref={ref}
        type={type}
        aria-label={ariaLabel}
        className={`focus-ring inline-flex shrink-0 items-center justify-center border-0 bg-transparent transition-[color,background-color,opacity] disabled:cursor-not-allowed disabled:opacity-30 ${sizeClassName} ${hoverClassName} ${revealControlClassName} ${
          coarsePointerTarget
            ? 'pointer-coarse:min-h-11 pointer-coarse:min-w-11'
            : ''
        }${touchTarget ? ' min-h-11' : ''} ${className}`}
        {...props}
      >
        <Icon size={iconSize} className={iconClassName} />
      </button>
    </Tooltip>
  );

  // Tooltip owns an `inline-flex` wrapper. Keep conditional display on a
  // separate ancestor: Tailwind emits `.inline-flex` after `.hidden`, so
  // applying both utilities to Tooltip's wrapper makes the control visible at
  // rest regardless of the row's hover state.
  return (
    <span className={revealOnItemHover ? revealClassName : 'inline-flex'}>
      {control}
    </span>
  );
});

RailIconButton.displayName = 'RailIconButton';
