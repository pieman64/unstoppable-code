/**
 * Discrete vertical density steps for the chat composer's Slate editor. As the
 * containing panel gets shorter the composer selects a smaller step, from a
 * comfortable ~4-row default down to a single scrolling row (`minimal`). The
 * top inset stays fixed so density changes never pull text toward the edge;
 * container height, bottom padding, and editable min-height vary by step.
 */
export type ComposerDensity = 'comfortable' | 'cozy' | 'compact' | 'minimal';

// Touch screens get 16px text: iOS Safari zooms the page into a focused
// editor set smaller than 16px.
const EDITABLE_TEXT_CLASS_NAME =
  'whitespace-pre-wrap break-words bg-transparent text-s pointer-coarse:text-m leading-5 fg-primary outline-none';

export const COMPOSER_DENSITY_CLASS_NAMES: Record<
  ComposerDensity,
  { container: string; editable: string }
> = {
  comfortable: {
    container: 'min-h-26 max-h-50 cursor-text overflow-y-auto px-4 pt-3.5 pb-2',
    editable: `min-h-20 ${EDITABLE_TEXT_CLASS_NAME}`,
  },
  cozy: {
    container: 'min-h-18 max-h-40 cursor-text overflow-y-auto px-4 pt-3.5 pb-2',
    editable: `min-h-13 ${EDITABLE_TEXT_CLASS_NAME}`,
  },
  compact: {
    container:
      'min-h-12 max-h-30 cursor-text overflow-y-auto px-4 pt-3.5 pb-1.5',
    editable: `min-h-8 ${EDITABLE_TEXT_CLASS_NAME}`,
  },
  minimal: {
    container: 'min-h-7 max-h-16 cursor-text overflow-y-auto px-4 pt-3.5 pb-5',
    editable: `min-h-5 ${EDITABLE_TEXT_CLASS_NAME}`,
  },
};
