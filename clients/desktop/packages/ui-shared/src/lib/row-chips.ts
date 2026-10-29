import {
  OPERATIONAL_STATUS_COLORS,
  type OperationalStatus,
} from './operational-status-colors';

/**
 * The two chip shapes that sit in a pipeline run row (and any other compact
 * activity row): a read-only STATUS BADGE and a clickable ACTION CHIP. Every
 * chip in the row composes one of these two builders so the row cannot drift
 * back into a mix of paddings, radii, and border utilities.
 *
 * Status badges tint with the `*-subtle` surface, matching ink, and a
 * hairline `ring` on a `line-*` role (the theme-token check reserves the
 * intent names for surfaces). Action chips never tint: they sit on the
 * shared {@link SECONDARY_SURFACE_CLASS} and differ by ink only. Neither
 * uses a `border-<color>` utility, which the unlayered base border rule
 * paints over (CAN-2734).
 */

/**
 * One physical-pixel inset edge for tinted notices and rows: the width comes
 * from `--border-hairline` (1px, 0.5px on Retina) so it matches the house
 * hairline, and it is a ring rather than a border because `border-<color>`
 * utilities are inert under the unlayered base border rule (CAN-2734).
 * Pair it with a `ring-line-*` or `ring-status-*` colour.
 */
export const HAIRLINE_INSET_RING_CLASS =
  'ring-[length:var(--border-hairline)] ring-inset';

/** 20px pill, 3xs label, 12px icons. */
export const STATUS_BADGE_BASE_CLASS =
  'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-3xs font-medium ring-[length:var(--border-hairline)]';

/**
 * Operational statuses map onto the app-wide status vocabulary; `warning`
 * is the theme attention intent (input required, stale advisor) and
 * `neutral` is the quiet informational chip.
 */
export type StatusBadgeTone = OperationalStatus | 'warning' | 'neutral';

export interface StatusBadgeClassNameOptions {
  /**
   * Reduced-emphasis colour set for a completed row: quiet tint, quiet ink,
   * and a quieter ring. Geometry is unchanged.
   */
  readonly muted?: boolean;
}

function statusBadgeTint(tone: StatusBadgeTone, muted: boolean): string {
  switch (tone) {
    case 'warning':
      return muted
        ? 'bg-warning-subtle fg-warning/70 ring-line-attention/20'
        : 'bg-warning-subtle fg-warning ring-line-attention/30';
    case 'neutral':
      return muted
        ? 'bg-subtle fg-secondary/70 ring-line-secondary'
        : 'bg-subtle fg-secondary ring-line-secondary';
    default: {
      const colors = OPERATIONAL_STATUS_COLORS[tone];
      return muted
        ? `${colors.backgroundQuiet} ${colors.foregroundQuiet} ${colors.ringQuiet}`
        : `${colors.backgroundSubtle} ${colors.foreground} ${colors.ring}`;
    }
  }
}

/**
 * Full class string for a status badge: shared geometry plus the tone's
 * tint, ink, and ring.
 */
export function statusBadgeClassName(
  tone: StatusBadgeTone,
  options: StatusBadgeClassNameOptions = {},
): string {
  return `${STATUS_BADGE_BASE_CLASS} ${statusBadgeTint(tone, options.muted === true)}`;
}

/**
 * The resting shell of the house secondary control surface: quaternary
 * fill, `shadow-sm` elevation, and a 0.5px `line-secondary` hairline. The
 * hairline is what keeps the shell reading as a raised control in dark mode,
 * where the black shadow vanishes against a near-black base. Only split
 * controls whose segments hover independently (the header `Open in` pill)
 * use this on its own; everything else takes {@link SECONDARY_SURFACE_CLASS}.
 */
export const SECONDARY_SURFACE_SHELL_CLASS =
  'bg-quaternary shadow-sm ring-[length:var(--border-hairline)] ring-line-secondary';

/**
 * The secondary surface's hover: a `--bg-subtle` gradient overlay rather
 * than a background swap, so the quaternary token stays the single source
 * of the base colour.
 */
export const SECONDARY_SURFACE_HOVER_CLASS =
  'hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]';

/**
 * The house SECONDARY CONTROL SURFACE: the quaternary shell, `shadow-sm`
 * elevation, and 0.5px `line-secondary` hairline of the worktree header
 * `Open in` pill, with the `--bg-subtle` overlay on hover. Every secondary
 * button, action chip, and split control composes this exact string; it
 * carries no ink, so callers add one `fg-*` role from
 * {@link secondaryToneClassName}.
 */
export const SECONDARY_SURFACE_CLASS = `${SECONDARY_SURFACE_SHELL_CLASS} ${SECONDARY_SURFACE_HOVER_CLASS}`;

/**
 * The 28px labelled secondary button used by Marketplace cards (`Add`) and
 * by any control that must read as the same thing, such as the empty
 * Collections tab's `Add collection`. Composes {@link SECONDARY_SURFACE_CLASS}
 * with the card recipe's radius, inset, and 12px label so the two never
 * drift apart.
 */
export const SECONDARY_ACTION_BUTTON_CLASS = `focus-ring inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-xs font-medium fg-primary transition pointer-coarse:h-11 ${SECONDARY_SURFACE_CLASS}`;

/**
 * The 28px square icon-only sibling of {@link SECONDARY_ACTION_BUTTON_CLASS}
 * (the header `Open in` app segment, a detail page's Share). Same shell, no
 * inset, centred glyph.
 */
export const SECONDARY_ICON_BUTTON_CLASS = `focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md fg-primary transition pointer-coarse:h-11 pointer-coarse:w-11 ${SECONDARY_SURFACE_CLASS}`;

/**
 * Ink tones for a control on {@link SECONDARY_SURFACE_CLASS}. The tone never
 * changes the surface: a warning Retry, a destructive Start over, and an
 * accent git action are all the same quaternary shell with different text.
 */
export type SecondaryTone = 'neutral' | 'warning' | 'destructive' | 'accent';

const SECONDARY_TONE_INK: Record<SecondaryTone, string> = {
  neutral: 'fg-primary',
  warning: 'fg-warning',
  destructive: 'fg-destructive',
  accent: 'fg-accent',
};

/** The single `fg-*` role a secondary control paints for `tone`. */
export function secondaryToneClassName(tone: SecondaryTone): string {
  return SECONDARY_TONE_INK[tone];
}

/**
 * 24px rounded-md button, 2xs label. Geometry only: the ring width, shadow,
 * and hover come from {@link SECONDARY_SURFACE_CLASS}.
 */
export const ACTION_CHIP_BASE_CLASS =
  'focus-ring inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-2xs font-medium transition';

export type ActionChipTone = Exclude<SecondaryTone, 'accent'>;

/**
 * Full class string for an action chip: shared geometry plus the house
 * secondary surface plus the tone's ink. Disabled treatment is the caller's.
 */
export function actionChipClassName(tone: ActionChipTone): string {
  return `${ACTION_CHIP_BASE_CLASS} ${SECONDARY_SURFACE_CLASS} ${secondaryToneClassName(tone)}`;
}
