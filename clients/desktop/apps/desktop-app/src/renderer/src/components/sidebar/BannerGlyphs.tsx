import { type JSX } from 'react';
import {
  AppIconBase,
  type AppIconBaseProps,
} from '@canopy/ui-shared/icons/AppIcons';

/**
 * Stroke-width tuning knob for the app-local banner glyphs below. The app's
 * Material Symbols (weight 300) draw 1.5-unit strokes on a 24px grid. These
 * custom glyphs were tuned 0.05 heavier than their neighbours (1.8 against
 * the previous 1.75 icon weight), so they keep that offset at 1.55; raise it
 * for a bolder look.
 */
export const BANNER_GLYPH_STROKE_WIDTH = 1.55;

type BannerGlyphProps = AppIconBaseProps & {
  /** Overrides {@link BANNER_GLYPH_STROKE_WIDTH} for one-off tuning. */
  strokeWidth?: number;
};

/**
 * App-local glyphs for the sidebar footer banners. Rendered through
 * {@link AppIconBase} — the same root the generated glyphs in the update
 * banner and sidebar nav use — as stroke art (`fill="none"`), so the only
 * variable left between them is the stroke width knob above.
 */
export function GiftIcon({
  strokeWidth = BANNER_GLYPH_STROKE_WIDTH,
  ...props
}: BannerGlyphProps): JSX.Element {
  return (
    <AppIconBase {...props} fill="none">
      <path
        d="M12 4V20M4 12H20M8 16C9.64819 14.9363 10.9156 13.6374 12 12M12 12C13.0844 13.6374 14.3518 14.9363 16 16M12 12V10.6667M12 12H10.6667C9.19391 12 8 10.8061 8 9.33333C8 8.59695 8.59695 8 9.33333 8C10.8061 8 12 9.19391 12 10.6667M12 12H13.3333C14.8061 12 16 10.8061 16 9.33333C16 8.59695 15.403 8 14.6667 8C13.1939 8 12 9.19391 12 10.6667M7 20H17C18.6569 20 20 18.6569 20 17V7C20 5.34315 18.6569 4 17 4H7C5.34315 4 4 5.34315 4 7V17C4 18.6569 5.34315 20 7 20Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </AppIconBase>
  );
}

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
