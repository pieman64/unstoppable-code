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
import { KbdChip } from './KbdChip';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'ghost-overlay'
  | 'ghost-quiet'
  | 'ghost-accent'
  | 'ghost-destructive'
  | 'warning'
  | 'destructive';

/**
 * Inline accent text for an action inside a sentence, with no capsule. It is
 * kept out of `ButtonVariant` so a wrapper that forwards a capsule variant
 * with a `size` stays valid; `variant="link"` takes only the link props.
 */
export type ButtonLinkVariant = 'link';

export type ButtonSize = 'sm' | 'md' | 'lg' | 'control' | 'compact';

interface CapsuleButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual treatment for the button. */
  variant?: ButtonVariant;
  /**
   * Visible control height, at or below the 36px app maximum. `sm`, `md`
   * and `lg` are the 14px-label pill. `compact` is the 28px capsule with a
   * 13px label: Settings, dialog, section-header and dense-panel actions.
   * `control` (the 28px rounded rectangle) is deprecated: use `compact`.
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

type CapsuleButtonProps = CapsuleButtonBaseProps &
  (
    | {
        /** Render a circular icon-only button. */
        iconOnly: true;
        /** Accessible name required for icon-only controls. */
        'aria-label': string;
        /** An icon-only control names its shortcut in its tooltip instead. */
        shortcut?: undefined;
      }
    | {
        iconOnly?: false;
        /**
         * The keys that perform this action (`formatShortcut(id)`: `⌘P`,
         * `Ctrl P`), drawn inside the button after its label as one filled
         * chip. A labelled button carries its shortcut here rather than in a
         * tooltip.
         */
        shortcut?: string;
      }
  );

/**
 * An action inside a sentence: inline accent text that takes the size of the
 * copy around it. The capsule-only props do not apply, so they are not
 * accepted.
 */
interface LinkButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant: ButtonLinkVariant;
  size?: undefined;
  iconOnly?: false;
  shortcut?: undefined;
  fillRow?: undefined;
}

export type ButtonProps = CapsuleButtonProps | LinkButtonProps;

// An `aria-disabled` button stays in the tab order so it can announce a busy
// state (Connecting…); it keeps its variant surface and reads as unavailable
// at 60% under a not-allowed cursor.
// A `disabled` button stays the click target, so a click on it is swallowed
// rather than handed to a clickable row behind it (no `pointer-events-none`).
// Its look ignores hover and press instead: Tailwind sorts `disabled:` after
// `hover:` and `active:`, so each disabled class below outranks the hover or
// press class for the same property.
const BASE_CLASS_NAME =
  "focus-ring inline-flex max-h-9 shrink-0 select-none items-center justify-center gap-1.5 font-medium transition-[opacity,transform] duration-150 before:absolute before:inset-x-0 before:content-[''] active:scale-97 disabled:scale-100 disabled:cursor-not-allowed disabled:text-[var(--fg-disabled)] disabled:opacity-100 disabled:shadow-none aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

// Disabled, a filled variant swaps its fill for the disabled fill. The ghost
// variants (transparent at rest) keep no fill: a disabled ghost reads as a
// dimmed icon or label, never a grey disc, and their hover fill is reset.
const DISABLED_FILL_CLASS_NAME = 'disabled:bg-[var(--bg-disabled)]';
const DISABLED_NO_FILL_CLASS_NAME = 'disabled:bg-transparent';

const VARIANT_CLASS_NAMES: Record<ButtonVariant, string> = {
  primary: `bg-accent fg-emphasis hover:bg-[color-mix(in_srgb,var(--bg-accent),#000_12%)] ${DISABLED_FILL_CLASS_NAME}`,
  // The house secondary control surface shared with action chips and the
  // header `Open in` split control; only the ink is added here.
  secondary: `${SECONDARY_SURFACE_CLASS} fg-primary ${DISABLED_FILL_CLASS_NAME} disabled:[background-image:none]`,
  outline: `border bg-base fg-primary hover:bg-secondary active:bg-muted ${DISABLED_FILL_CLASS_NAME}`,
  ghost: `bg-transparent fg-secondary hover:bg-secondary hover:fg-primary ${DISABLED_NO_FILL_CLASS_NAME}`,
  // Ghost for a control on a raised or hovered surface (a card's row): the
  // translucent hover layers over whatever is beneath, where `ghost`'s
  // opaque fill would punch a hole in it.
  'ghost-overlay': `bg-transparent fg-secondary hover:bg-subtle hover:fg-primary ${DISABLED_NO_FILL_CLASS_NAME}`,
  // A ghost a step quieter at rest, for actions that repeat on every row of
  // a list (a chat reply's Copy, Fork, "•••"); hover and focus bring the
  // full ink back.
  // Disabled, it keeps no fill: a quiet action that can't run now reads as
  // a dimmed icon, not a grey disc. Open (a menu) or pressed (a toggle), it
  // takes the full ink, and its small icons draw a 1.5px visible stroke.
  'ghost-quiet': `canopy-small-icon-stroke bg-transparent fg-tertiary hover:bg-subtle hover:fg-primary focus-visible:fg-primary aria-expanded:bg-subtle aria-expanded:fg-primary aria-pressed:fg-primary disabled:opacity-40 ${DISABLED_NO_FILL_CLASS_NAME}`,
  'ghost-accent': `bg-transparent fg-accent hover:bg-accent-subtle hover:fg-accent ${DISABLED_NO_FILL_CLASS_NAME}`,
  // A quiet destructive action beside other actions (Delete next to Edit),
  // where the filled `destructive` would outweigh the primary choice.
  'ghost-destructive': `bg-transparent fg-destructive hover:bg-destructive-subtle hover:fg-destructive ${DISABLED_NO_FILL_CLASS_NAME}`,
  warning: `bg-warning-subtle fg-warning hover:bg-warning-subtle/80 active:bg-warning-subtle ${DISABLED_FILL_CLASS_NAME}`,
  destructive: `bg-destructive fg-emphasis hover:bg-destructive-hover ${DISABLED_FILL_CLASS_NAME}`,
};

// The `link` variant: an action that reads as a text link inside a sentence
// (Retry, Open settings). It takes the size of the copy around it, so no
// height, padding, radius or label size applies, and it does not press-scale.
// Same ink as `ExternalTextLink`, so a link and a link action match.
const LINK_CLASS_NAME =
  'focus-ring rounded font-medium fg-accent hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:fg-disabled aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

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

// With a shortcut chip at the end, the end padding equals the chip's inset
// from the top and bottom ((height - 18px chip) / 2), so the chip's capsule
// stays concentric with the button's end cap.
const SHORTCUT_END_PADDING_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'pr-1.25',
  md: 'pr-1.75',
  lg: 'pr-2.25',
  control: 'pr-1.25',
  compact: 'pr-1.25',
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
  'ghost-quiet':
    'group-hover/checklist:bg-subtle group-hover/checklist:fg-primary',
  'ghost-accent':
    'group-hover/checklist:bg-accent-subtle group-hover/checklist:fg-accent',
  'ghost-destructive':
    'group-hover/checklist:bg-destructive-subtle group-hover/checklist:fg-destructive',
  warning: 'group-hover/checklist:bg-warning-subtle/80',
  destructive: 'group-hover/checklist:bg-destructive-hover',
};

// The button is the containing block for its `before:` hit area, so it is
// `relative` unless the caller's placement already positions it: Tailwind
// emits `.relative` after `.absolute`, so both on one element would silently
// drop the caller's `absolute`. An absolute, fixed or sticky button contains
// the hit area itself. A pseudo-element's position (`after:absolute`) is not
// the button's.
const CALLER_POSITIONS = new Set(['absolute', 'fixed', 'sticky']);
const PSEUDO_ELEMENT_VARIANTS = new Set(['before', 'after']);

function positionsItself(className: string): boolean {
  return className.split(/\s+/).some((token) => {
    const parts = token.split(':');
    const utility = (parts.pop() ?? '').replace(/^!|!$/g, '');
    return (
      CALLER_POSITIONS.has(utility) &&
      !parts.some((variant) => PSEUDO_ELEMENT_VARIANTS.has(variant))
    );
  });
}

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
  variant?: ButtonVariant | ButtonLinkVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  className?: string;
} = {}): string {
  if (variant === 'link') return `${LINK_CLASS_NAME} ${className}`;
  const position = positionsItself(className) ? '' : 'relative ';
  return `${position}${BASE_CLASS_NAME} ${VARIANT_CLASS_NAMES[variant]} ${SIZE_CLASS_NAMES[size]} ${iconOnly ? ICON_ONLY_SIZE_CLASS_NAMES[size] : LABEL_SIZE_CLASS_NAMES[size]} ${className}`;
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
      children,
      shortcut,
      ...props
    },
    ref,
  ): JSX.Element {
    const withShortcut = !iconOnly && shortcut !== undefined && shortcut !== '';
    const placementClassName = withShortcut
      ? `${SHORTCUT_END_PADDING_CLASS_NAMES[size]} ${className}`
      : className;
    return (
      <button
        ref={ref}
        type={type}
        className={buttonClassName({
          variant,
          size,
          iconOnly,
          className: fillRow
            ? `${FILL_ROW_CLASS_NAME} ${variant === 'link' ? '' : FILL_ROW_HOVER_CLASS_NAMES[variant]} ${placementClassName}`
            : placementClassName,
        })}
        style={fillRow ? { ...FILL_ROW_STYLE, ...style } : style}
        {...props}
      >
        {children}
        {withShortcut && <KbdChip shortcut={shortcut} />}
      </button>
    );
  },
);

Button.displayName = 'Button';
