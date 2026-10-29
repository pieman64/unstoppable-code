import type { JSX, ReactNode } from 'react';

export interface FoldRevealProps {
  /** Shown at full width when `true`; folded to zero width when `false`. */
  open: boolean;
  children: ReactNode;
  /** Placement only, such as a margin that cancels the parent's gap. */
  className?: string;
}

/**
 * Folds inline content in and out sideways, width and fade together, so a
 * control that gains or drops a label or glyph resizes in one motion instead
 * of popping. A 0fr/1fr grid column animates to the content's exact width.
 * The content stays mounted; folded, it is hidden from assistive tech.
 */
export function FoldReveal({
  open,
  children,
  className,
}: FoldRevealProps): JSX.Element {
  return (
    <span
      aria-hidden={open ? undefined : true}
      data-fold-open={open}
      className={`grid shrink-0 transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none ${
        open ? 'grid-cols-[1fr]' : 'grid-cols-[0fr] opacity-0'
      } ${className ?? ''}`}
    >
      <span className="flex min-w-0 items-center overflow-hidden whitespace-nowrap">
        {children}
      </span>
    </span>
  );
}
