import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';

/**
 * The Getting started chip, in the two forms the desktop checklist draws:
 *
 * - `option`: one answer in a wrapping group (a profile role). Text only,
 *   compact, with the check inline before the label when chosen.
 * - `tool`: a thing to connect or pick (a plugin, an AI harness). Carries a
 *   logo and reads at the 40px row height.
 * - `category`: a filter over the tool tiles (a profile role), one size down
 *   so a row of them reads as a control for the tiles below, not as more
 *   tiles.
 *
 * Selection is carried by the accent ring and tint. Weight stays constant in
 * both forms so toggling never reflows the group.
 */
export type OnboardingChoiceTileVariant = 'option' | 'tool' | 'category';

// Compact on a pointer; the 44px touch floor applies on coarse pointers.
const OPTION_BASE_CLASS =
  'focus-ring flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs ring-1 ring-inset transition-colors disabled:cursor-default pointer-coarse:min-h-11';
const TOOL_BASE_CLASS =
  'focus-ring flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ring-1 ring-inset transition-colors disabled:cursor-default pointer-coarse:min-h-11';
const CATEGORY_BASE_CLASS =
  'focus-ring flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs ring-1 ring-inset transition-colors disabled:cursor-default pointer-coarse:min-h-11';
const BASE_CLASS: Record<OnboardingChoiceTileVariant, string> = {
  option: OPTION_BASE_CLASS,
  tool: TOOL_BASE_CLASS,
  category: CATEGORY_BASE_CLASS,
};
const TILE_SELECTED_CLASS =
  'ring-line-accent bg-accent-subtle fg-primary hover:bg-accent-subtle/80';
const TILE_IDLE_CLASS =
  'ring-line-base bg-secondary fg-secondary hover:bg-subtle hover:fg-primary disabled:opacity-60';

/**
 * The tile's full class list, for hosts that render the same chip as a link
 * (a tool that opens its setup page) rather than a toggle button.
 */
export function onboardingChoiceTileClassName(
  selected: boolean,
  variant: OnboardingChoiceTileVariant = 'option',
): string {
  return `${BASE_CLASS[variant]} ${selected ? TILE_SELECTED_CLASS : TILE_IDLE_CLASS}`;
}

export interface OnboardingChoiceTileProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className'
> {
  selected: boolean;
  variant?: OnboardingChoiceTileVariant;
  /** Leading mark: the inline check on an option, a logo on a tool. */
  icon?: ReactNode;
  /** Trailing state, such as the connected check on a tool. */
  trailing?: ReactNode;
}

/** Toggle-button form of the chip; `aria-pressed` carries the selection. */
export function OnboardingChoiceTile({
  selected,
  variant = 'option',
  icon,
  trailing,
  children,
  type = 'button',
  ...props
}: OnboardingChoiceTileProps): JSX.Element {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={onboardingChoiceTileClassName(selected, variant)}
      {...props}
    >
      {icon ? (
        variant === 'tool' ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            {icon}
          </span>
        ) : (
          icon
        )
      ) : null}
      <span className="whitespace-nowrap">{children}</span>
      {trailing}
    </button>
  );
}

const SKELETON_LABEL_CLASS = {
  short: 'h-3 w-14 rounded bg-fg-primary/[0.06]',
  medium: 'h-3 w-16 rounded bg-fg-primary/[0.06]',
  long: 'h-3 w-20 rounded bg-fg-primary/[0.06]',
} as const;

/**
 * A `tool` tile's placeholder while the group's choices load: the same box
 * (40px row, ring, radius) with a logo and a label bar, so the real tiles
 * replace it in place instead of the group appearing from nothing.
 */
export function OnboardingChoiceTileSkeleton({
  labelLength = 'medium',
}: {
  /** Label bar length, so a row of placeholders reads as distinct tiles. */
  readonly labelLength?: keyof typeof SKELETON_LABEL_CLASS;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="onboarding-choice-tile-skeleton"
      className="flex min-h-10 items-center gap-2 rounded-lg bg-secondary px-3 py-2 ring-1 ring-inset ring-line-base pointer-coarse:min-h-11"
    >
      <span className="h-5 w-5 shrink-0 rounded bg-fg-primary/[0.06]" />
      <span className={SKELETON_LABEL_CLASS[labelLength]} />
    </span>
  );
}
