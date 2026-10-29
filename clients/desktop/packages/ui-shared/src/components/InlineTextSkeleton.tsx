import type { HTMLAttributes, JSX } from 'react';

export interface InlineTextSkeletonProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  'children' | 'aria-hidden'
> {
  /**
   * Content is being fetched right now. Only then does the bar shade, after a
   * short delay so fast answers never flash, and never under reduced motion.
   */
  readonly active?: boolean;
}

/**
 * A soft inline bar that holds the place of text that has not arrived, on the
 * text's own line without changing the line height. It is hidden from
 * assistive technology and carries no text, so copying the surrounding prose
 * skips it. Size it with `className` (a width, and margin for any gap).
 */
export function InlineTextSkeleton({
  active = false,
  className = '',
  ...rest
}: InlineTextSkeletonProps): JSX.Element {
  return (
    <span
      {...rest}
      aria-hidden="true"
      data-active={active ? 'true' : undefined}
      className={`canopy-inline-skeleton select-none ${className}`}
    />
  );
}
