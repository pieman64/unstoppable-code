import type { CSSProperties } from 'react';

/**
 * Classes for the one-line composer. On one line the box is a flex row and
 * the toolbar steps aside (`ChatComposerToolbar inline`), so the leading +,
 * the rail, the editor and the trailing cluster are ordered 1–4 in it.
 */
export const ONE_LINE_COMPOSER_CLASS_NAMES = {
  /**
   * Added to the composer shell while it is on one line. Items sit on the
   * bottom edge (every item is 32px tall, so at rest this is the same as
   * centring): while the box shrinks from the full layout, + and send stay
   * put instead of sliding down through the taller box.
   */
  box: 'flex items-end gap-2 p-2',
  /**
   * Added to the composer shell in the full layout. Content stacks from the
   * bottom edge: while the box grows out of the capsule, the toolbar row
   * holds + and send where the capsule had them and the text is revealed
   * above, instead of the toolbar being clipped away and dropping back in.
   */
  expandedBox: 'flex flex-col justify-end',
  /** The editor's outer box: the stretching third item of the row. */
  editor: 'order-3 min-w-0 flex-1',
  /**
   * The editor's scroll container: one 20px text line centred in the 32px
   * control height, clipped rather than scrolled (a second line opens the
   * full layout). The placeholder stays on that line and ends in an ellipsis
   * when the capsule is too narrow, instead of wrapping into a clipped half
   * line.
   */
  editorContainer:
    'max-h-8 min-h-8 cursor-text overflow-hidden px-1 py-1.5 [&_[data-slate-placeholder]]:truncate',
  /** The leading + slot: first item of the row. */
  leading: 'order-1',
} as const;

/**
 * The one-line box is a capsule: its corner radius is half its 48px height
 * (8px padding around the 32px controls), so the ends are full semicircles.
 */
export const ONE_LINE_COMPOSER_BOX_STYLE: CSSProperties = {
  borderRadius: 24,
};
