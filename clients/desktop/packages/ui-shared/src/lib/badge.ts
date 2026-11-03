/**
 * One vocabulary for small markers: a Badge (a state or label word), a Count
 * (a number), and a Dot (a meaning with no text).
 *
 * - Badge: an 18px capsule, 11px label at 450, tinted `-subtle` fill and the
 *   tone's strong ink. Six tones. Never bordered, never the accent, never
 *   uppercase or semibold.
 * - Count: plain `fg-quaternary` text next to a label, with proportional
 *   figures (DESIGN.md Typography: counts in a row are not tabular); a 16px
 *   tabular capsule on an icon, neutral, blue for unread, or orange for
 *   waiting on you. On an icon it caps at 99+.
 * - Badge `compact`: a 16px square tag at 10px for dense views only
 *   (diagrams, code views, schema tags such as PK or added).
 * - Dot: 6px, with five meanings only: unread (blue), waiting on you
 *   (orange), filter on (grey), connected or working (green), and offline or
 *   failed (red).
 *
 * Every marker composes these builders so the app cannot drift back into a
 * mix of heights, radii, rings and weights.
 */

export type BadgeTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'special';

export type BadgeSize = 'regular' | 'compact';

/** 18px capsule, 11px label at 450, 12px icons. */
export const BADGE_BASE_CLASS =
  'inline-flex h-4.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.75 text-2xs font-medium leading-none';

/**
 * 16px square tag, 10px label at 450, 10px icons. Dense views only:
 * diagrams, code views and schema tags (PK, FK, added, changed).
 */
export const BADGE_COMPACT_BASE_CLASS =
  'inline-flex h-4 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-sm px-1 text-3xs font-medium leading-none';

export const BADGE_BASE_CLASS_BY_SIZE: Readonly<Record<BadgeSize, string>> = {
  regular: BADGE_BASE_CLASS,
  compact: BADGE_COMPACT_BASE_CLASS,
};

/** Fill and ink per tone. Fills are the `-subtle` roles; inks the strong roles. */
export const BADGE_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-muted fg-secondary',
  info: 'bg-info-subtle fg-info',
  success: 'bg-success-subtle fg-success-strong',
  warning: 'bg-warning-subtle fg-warning-strong',
  danger: 'bg-destructive-subtle fg-destructive-strong',
  special: 'bg-special-subtle fg-special-strong',
};

/**
 * Quieter fill and ink for a badge on a completed or de-emphasised row.
 * Geometry is unchanged.
 */
export const BADGE_MUTED_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-subtle fg-tertiary',
  info: 'bg-info-subtle fg-info/70',
  success: 'bg-success-subtle fg-success-strong/70',
  warning: 'bg-warning-subtle fg-warning-strong/70',
  danger: 'bg-destructive-subtle fg-destructive-strong/70',
  special: 'bg-special-subtle fg-special-strong/70',
};

/** 12px leading glyph inside a badge. */
export const BADGE_ICON_CLASS = 'size-3 shrink-0';

/** Leading glyph class and drawn size per badge size. */
export const BADGE_ICON_BY_SIZE: Readonly<
  Record<BadgeSize, { readonly className: string; readonly px: number }>
> = {
  regular: { className: BADGE_ICON_CLASS, px: 12 },
  compact: { className: 'size-2.5 shrink-0', px: 10 },
};

export interface BadgeClassNameOptions {
  readonly muted?: boolean;
  /** Defaults to `regular`, the 18px capsule. */
  readonly size?: BadgeSize;
}

/** Full class string for a badge: shared geometry plus the tone's fill and ink. */
export function badgeClassName(
  tone: BadgeTone,
  options: BadgeClassNameOptions = {},
): string {
  const toneClass =
    options.muted === true
      ? BADGE_MUTED_TONE_CLASS[tone]
      : BADGE_TONE_CLASS[tone];
  return `${BADGE_BASE_CLASS_BY_SIZE[options.size ?? 'regular']} ${toneClass}`;
}

/** Largest number a count on an icon shows before it reads `99+`. */
export const BADGE_COUNT_CAP = 99;

/**
 * Text for a count on an icon: the number, or `99+` above the cap. Negative
 * and non-finite values read as 0; fractions round down.
 */
export function formatBadgeCount(
  value: number,
  cap: number = BADGE_COUNT_CAP,
): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  const whole = Math.floor(value);
  return whole > cap ? `${cap}+` : String(whole);
}

export type CountTone = 'neutral' | 'unread' | 'attention';

/** A count next to a label: plain quaternary ink at the label's size. */
export const LABEL_COUNT_CLASS = 'fg-quaternary';

/**
 * A count on an icon: 16px capsule, 10px label at 450. Tabular, because the
 * number changes in place.
 */
export const ICON_COUNT_BASE_CLASS =
  'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-3xs font-medium leading-none tabular-nums';

export const ICON_COUNT_TONE_CLASS: Readonly<Record<CountTone, string>> = {
  neutral: 'bg-quaternary fg-primary shadow-xs',
  unread: 'bg-fg-info fg-emphasis',
  attention: 'bg-fg-warning fg-emphasis',
};

export function iconCountClassName(tone: CountTone): string {
  return `${ICON_COUNT_BASE_CLASS} ${ICON_COUNT_TONE_CLASS[tone]}`;
}

/**
 * `success` is connected or working, `danger` offline or failed; both take
 * the solid status roles, never a raw hue.
 */
export type DotTone = 'unread' | 'attention' | 'filter' | 'success' | 'danger';

export const DOT_BASE_CLASS = 'inline-block size-1.5 shrink-0 rounded-full';

export const DOT_TONE_CLASS: Readonly<Record<DotTone, string>> = {
  unread: 'bg-fg-info',
  attention: 'bg-fg-warning',
  filter: 'bg-fg-quaternary',
  success: 'bg-fg-success-strong',
  danger: 'bg-fg-destructive-strong',
};

export function dotClassName(tone: DotTone): string {
  return `${DOT_BASE_CLASS} ${DOT_TONE_CLASS[tone]}`;
}
