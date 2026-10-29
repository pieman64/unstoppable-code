import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type JSX,
} from 'react';
import {
  SECONDARY_SURFACE_CLASS,
  SECONDARY_SURFACE_HOVER_CLASS,
} from '../lib/row-chips';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'ghost-overlay'
  | 'ghost-accent'
  | 'warning'
  | 'destructive';

export type ButtonSize = 'sm' | 'md' | 'lg' | 'control' | 'compact';

interface ButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual treatment for the button. */
  variant?: ButtonVariant;
  /**
   * Visible control height, at or below the 36px app maximum. `sm`, `md`
   * and `lg` are the 14px-label pill. `control` is the 28px rounded
   * rectangle with a 13px label: the house secondary control geometry of the
   * header `Open in` and notice actions, for actions that sit inside a
   * settings row, a section header, or a dense panel. `compact` is the 28px
   * capsule with that same 13px label: the Settings actions.
   */
  size?: ButtonSize;
  /**
   * Let the enclosing `group/checklist` row act as the button: the row's
   * hover paints the variant's hover look, and an overlay covering the row
   * (its 8px radius) takes the click, so the button is positioned by the row
   * rather than itself and does not press-scale. The checklist action's
   * stretched primary CTA.
   */
  fillRow?: boolean;
}

export type ButtonProps = ButtonBaseProps &
  (
    | {
        /** Render a circular icon-only button. */
        iconOnly: true;
        /** Accessible name required for icon-only controls. */
        'aria-label': string;
      }
    | {
        iconOnly?: false;
      }
  );

// An `aria-disabled` button stays in the tab order so it can announce a busy
// state (Connecting…); it keeps its variant surface and reads as unavailable
// at 60% under a not-allowed cursor.
const BASE_CLASS_NAME =
  "focus-ring relative inline-flex max-h-9 shrink-0 select-none items-center justify-center gap-1.5 font-medium transition-[opacity,transform] duration-150 before:absolute before:inset-x-0 before:content-[''] active:scale-97 disabled:pointer-events-none disabled:bg-[var(--bg-disabled)] disabled:text-[var(--fg-disabled)] disabled:opacity-100 disabled:shadow-none aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

const VARIANT_CLASS_NAMES: Record<ButtonVariant, string> = {
  primary:
    'bg-accent fg-emphasis hover:bg-[color-mix(in_srgb,var(--bg-accent),#000_12%)]',
  // The house secondary control surface shared with action chips and the
  // header `Open in` split control; only the ink is added here.
  secondary: `${SECONDARY_SURFACE_CLASS} fg-primary`,
  outline: 'border bg-base fg-primary hover:bg-secondary active:bg-muted',
  ghost: 'bg-transparent fg-secondary hover:bg-secondary hover:fg-primary',
  // Ghost for a control on a raised or hovered surface (a card's row): the
  // translucent hover layers over whatever is beneath, where `ghost`'s
  // opaque fill would punch a hole in it.
  'ghost-overlay':
    'bg-transparent fg-secondary hover:bg-subtle hover:fg-primary',
  'ghost-accent':
    'bg-transparent fg-accent hover:bg-accent-subtle hover:fg-accent',
  warning:
    'bg-warning-subtle fg-warning hover:bg-warning-subtle/80 active:bg-warning-subtle',
  destructive: 'bg-destructive fg-emphasis hover:bg-destructive-hover',
};

// Shape and label size belong to the size, so the pill and the control
// rectangle never carry each other's radius or type.
const SIZE_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'h-7 rounded-full text-s pointer-coarse:before:-inset-y-2',
  md: 'h-8 rounded-full text-s pointer-coarse:before:-inset-y-1.5',
  lg: 'h-9 rounded-full text-s pointer-coarse:before:-inset-y-1',
  control: 'h-7 rounded-md text-xs pointer-coarse:before:-inset-y-2',
  compact: 'h-7 rounded-full text-xs pointer-coarse:before:-inset-y-2',
};

const LABEL_SIZE_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'px-2.5',
  md: 'px-3',
  lg: 'px-4',
  control: 'px-2.5',
  compact: 'px-3',
};

const ICON_ONLY_SIZE_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'w-7 px-0 pointer-coarse:before:-inset-x-2',
  md: 'w-8 px-0 pointer-coarse:before:-inset-x-1.5',
  lg: 'w-9 px-0 pointer-coarse:before:-inset-x-1',
  control: 'w-7 px-0 pointer-coarse:before:-inset-x-2',
  compact: 'w-7 px-0 pointer-coarse:before:-inset-x-2',
};

// The overlay replaces the coarse-pointer `before:` hit area; `static` and the
// press scale are inline because Tailwind emits `relative` after `static`.
const FILL_ROW_CLASS_NAME =
  "before:hidden after:absolute after:inset-0 after:rounded-lg after:content-['']";
const FILL_ROW_STYLE: CSSProperties = {
  position: 'static',
  transform: 'none',
  scale: 'none',
};

/** Each variant's hover look, painted by the `group/checklist` row's hover. */
const FILL_ROW_HOVER_CLASS_NAMES: Record<ButtonVariant, string> = {
  primary:
    'group-hover/checklist:bg-[color-mix(in_srgb,var(--bg-accent),#000_12%)]',
  secondary: SECONDARY_SURFACE_HOVER_CLASS.replace(
    'hover:',
    'group-hover/checklist:',
  ),
  outline: 'group-hover/checklist:bg-secondary',
  ghost: 'group-hover/checklist:bg-secondary group-hover/checklist:fg-primary',
  'ghost-overlay':
    'group-hover/checklist:bg-subtle group-hover/checklist:fg-primary',
  'ghost-accent':
    'group-hover/checklist:bg-accent-subtle group-hover/checklist:fg-accent',
  warning: 'group-hover/checklist:bg-warning-subtle/80',
  destructive: 'group-hover/checklist:bg-destructive-hover',
};

/**
 * Button styling for elements that must NOT be a `<button>`.
 *
 * A primary navigation rendered as a `<button onClick={navigate}>` loses
 * middle-click, cmd/ctrl-click to open in a new tab, right-click to copy the
 * link, and the browser's status-bar URL preview. An `<a href>` carrying this
 * class keeps all of that while staying pixel-identical to {@link Button}, so
 * the two never drift.
 */
export function buttonClassName({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  className = '',
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  className?: string;
} = {}): string {
  return `${BASE_CLASS_NAME} ${VARIANT_CLASS_NAMES[variant]} ${SIZE_CLASS_NAMES[size]} ${iconOnly ? ICON_ONLY_SIZE_CLASS_NAMES[size] : LABEL_SIZE_CLASS_NAMES[size]} ${className}`;
}

/**
 * Canonical action button shared by desktop and web.
 *
 * Navigation rows, tabs, disclosure controls, and switch tracks should keep
 * their purpose-built semantics instead of using this action primitive.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'secondary',
      size = 'md',
      iconOnly = false,
      fillRow = false,
      type = 'button',
      className = '',
      style,
      ...props
    },
    ref,
  ): JSX.Element {
    return (
      <button
        ref={ref}
        type={type}
        className={buttonClassName({
          variant,
          size,
          iconOnly,
          className: fillRow
            ? `${FILL_ROW_CLASS_NAME} ${FILL_ROW_HOVER_CLASS_NAMES[variant]} ${className}`
            : className,
        })}
        style={fillRow ? { ...FILL_ROW_STYLE, ...style } : style}
        {...props}
      />
    );
  },
);

Button.displayName = 'Button';
