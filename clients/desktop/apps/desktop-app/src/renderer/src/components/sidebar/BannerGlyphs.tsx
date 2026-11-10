import { type JSX } from 'react';
import {
  AppIconBase,
  type AppIconBaseProps,
} from '@canopy/ui-shared/icons/AppIcons';

/**
 * Stroke-width tuning knob for the app-local banner glyph below. The app's
 * Material Symbols (weight 300) draw 1.5-unit strokes on a 24px grid. This
 * custom glyph was tuned 0.05 heavier than its neighbours (1.8 against
 * the previous 1.75 icon weight), so it keeps that offset at 1.55; raise it
 * for a bolder look.
 */
export const BANNER_GLYPH_STROKE_WIDTH = 1.55;

type BannerGlyphProps = AppIconBaseProps & {
  /** Overrides {@link BANNER_GLYPH_STROKE_WIDTH} for one-off tuning. */
  strokeWidth?: number;
};

/**
 * App-local glyph for the dev-build sidebar footer banner. Rendered through
 * {@link AppIconBase} — the same root the generated glyphs in the update
 * banner and sidebar nav use — as stroke art (`fill="none"`), so the only
 * variable left between them is the stroke width knob above.
 */
export function DevBannerIcon({
  strokeWidth = BANNER_GLYPH_STROKE_WIDTH,
  ...props
}: BannerGlyphProps): JSX.Element {
  return (
    <AppIconBase {...props} fill="none">
      <path
        d="M16 3C16 8.15877 8 8.15877 8 3C8 5.01555 8.03109 7.57229 6.72525 8.97068C5.59443 10.1816 4 11.3431 4 13V17C4 18.6569 5.34315 20 7 20H17C18.6569 20 20 18.6569 20 17V13C20 11.3431 18.4056 10.1816 17.2748 8.97068C15.9689 7.57229 16 5.01555 16 3Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 16H20M10 12H14"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 7V20" stroke="currentColor" strokeWidth={strokeWidth} />
    </AppIconBase>
  );
}
