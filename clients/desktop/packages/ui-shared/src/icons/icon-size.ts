/**
 * The icon scale (docs/design/icons.md#sizes). Pass a step name as an
 * AppIcons `size` instead of a number, width, height, or size class. This map
 * is the one place the names live: renaming a step is one edit here.
 *
 * - `xs`, 12px: badge glyphs and small chevrons.
 * - `sm`, 14px: the default; icons in buttons, menus, rows, and text.
 * - `md`, 16px: a compact icon control's true 16px glyph (the modal close).
 * - `lg`, 18px.
 * - `xl`, 20px: the regular Lucide size; toolbars and navigation.
 * - `2xl`, 24px.
 *
 * Empty-state and hero art (32px, 40px) is not on the scale: `EmptyState`
 * owns it through its `artSize` prop.
 *
 * `scripts/lib/legacy-icons.mjs` mirrors these pixel values as
 * `ICON_SCALE_PX`; keep the two in step.
 */
export const ICON_SIZE_PX = Object.freeze({
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
});

export type IconSize = keyof typeof ICON_SIZE_PX;

/** The default size of every app icon. */
export const DEFAULT_ICON_SIZE: IconSize = 'sm';

const ICON_SIZE_NAMES: ReadonlySet<string> = new Set(Object.keys(ICON_SIZE_PX));

export function isIconSize(value: unknown): value is IconSize {
  return typeof value === 'string' && ICON_SIZE_NAMES.has(value);
}

// Lucide artwork snaps to 14px and 20px (AppIconBase and app-icons.css), and
// a menu row's icon slot draws it at 14px. Steps at those two sizes keep that
// behavior, so `sm` and `xl` render exactly like the numbers 14 and 20 did;
// every other step opts out of the snapping to draw its own size.
const LUCIDE_TIER_PX: ReadonlySet<number> = new Set([14, 20]);

/** The pixel size and exact-size flag a step resolves to. */
export function resolveIconSize(size: IconSize): {
  px: number;
  exactSize: boolean;
} {
  const px = ICON_SIZE_PX[size];
  return { px, exactSize: !LUCIDE_TIER_PX.has(px) };
}
