import type { JSX } from 'react';

export type ResizeRailLine = 'vertical' | 'horizontal';

export interface ResizeRailIndicatorProps {
  /** A resize is in progress: the line holds its thick accent look. */
  readonly active: boolean;
  /** The line's own direction: vertical for a handle that resizes columns. */
  readonly line?: ResizeRailLine;
}

// The line's box is always the 2px thick line, so it sits on a whole pixel in
// its 8px handle; at rest the stylesheet scales it to half. A 1px box would
// sit on a half pixel, which Chromium snaps once the box is transformed.
const LINE_SHAPE_CLASS_NAMES: Record<ResizeRailLine, string> = {
  vertical: 'my-2 w-0.5',
  horizontal: 'mx-2 h-0.5',
};

/**
 * The visible line inside a resize handle: a quiet 1px hairline at rest that
 * doubles into the accent on the handle's hover (the enclosing `group`) and
 * while dragging. Every resizable divider, on desktop and web, draws this one
 * line. It changes thickness by `scale` on the compositor, never by `width`;
 * the scaled geometry lives with the scrollbar's in `canopy-tokens-core.css`.
 */
export function ResizeRailIndicator({
  active,
  line = 'vertical',
}: ResizeRailIndicatorProps): JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-resize-rail-indicator={line}
      data-active={active ? 'true' : undefined}
      className={`${LINE_SHAPE_CLASS_NAMES[line]} rounded-full transition-[scale,background-color] ${
        active ? 'bg-accent/80' : 'bg-line-base/70 group-hover:bg-accent/60'
      }`}
    />
  );
}
