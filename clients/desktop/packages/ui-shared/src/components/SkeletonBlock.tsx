import type { JSX } from 'react';

/**
 * `bar` holds a line of text; `circle` a person's avatar; `square` an
 * organization logo or tile; `toggle` a switch at the end of a setting row.
 */
export type SkeletonBlockShape = 'bar' | 'circle' | 'square' | 'toggle';

/** A bar's height, named for the text it stands in for. */
export type SkeletonBarHeight = 'meta' | 'label' | 'text' | 'title' | 'value';

/** A bar's width, as a fraction of its container. */
export type SkeletonBarWidth =
  | '1/5'
  | '1/4'
  | '1/3'
  | '2/5'
  | '1/2'
  | '3/5'
  | '2/3'
  | '3/4'
  | '5/6'
  | 'full';

const SHAPE_CLASS: Record<Exclude<SkeletonBlockShape, 'bar'>, string> = {
  circle: 'size-8 shrink-0 rounded-full',
  square: 'size-8 shrink-0 rounded-md',
  toggle: 'h-5 w-9 shrink-0 rounded-full',
};

const BAR_HEIGHT_CLASS: Record<SkeletonBarHeight, string> = {
  meta: 'h-2',
  label: 'h-2.5',
  text: 'h-3',
  title: 'h-3.5',
  value: 'h-5',
};

const BAR_WIDTH_CLASS: Record<SkeletonBarWidth, string> = {
  '1/5': 'w-1/5',
  '1/4': 'w-1/4',
  '1/3': 'w-1/3',
  '2/5': 'w-2/5',
  '1/2': 'w-1/2',
  '3/5': 'w-3/5',
  '2/3': 'w-2/3',
  '3/4': 'w-3/4',
  '5/6': 'w-5/6',
  full: 'w-full',
};

/**
 * The fill and motion every block skeleton shares: the muted surface, and a
 * slow shade that stops under reduced motion. It starts at full fill, so a
 * placeholder that remounts on navigation never fades in.
 */
export const SKELETON_BLOCK_CLASS =
  'block bg-muted animate-pulse motion-reduce:animate-none';

export interface SkeletonBlockProps {
  readonly shape?: SkeletonBlockShape;
  /** A bar's height. Ignored by the other shapes, which own their size. */
  readonly height?: SkeletonBarHeight;
  /** A bar's width. Ignored by the other shapes, which own their size. */
  readonly width?: SkeletonBarWidth;
  /** Placement only: margin and flex participation. */
  readonly className?: string;
}

/**
 * A block that holds the place of content that has not arrived. It carries
 * no text and is hidden from assistive technology; the skeleton around it
 * owns the `role="status"` announcement.
 */
export function SkeletonBlock({
  shape = 'bar',
  height = 'text',
  width = 'full',
  className = '',
}: SkeletonBlockProps): JSX.Element {
  const geometry =
    shape === 'bar'
      ? `rounded-sm ${BAR_HEIGHT_CLASS[height]} ${BAR_WIDTH_CLASS[width]}`
      : SHAPE_CLASS[shape];
  return (
    <span
      aria-hidden="true"
      className={`${SKELETON_BLOCK_CLASS} ${geometry} ${className}`}
    />
  );
}
