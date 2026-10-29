'use client';

import { memo, useRef, type HTMLAttributes, type JSX } from 'react';
import { useWordBoundaryTruncation } from '../lib/useWordBoundaryTruncation';

export interface WordBoundaryTruncatedTextProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  'children' | 'title'
> {
  readonly text: string;
  /** Expose the whole text as a native tooltip while it is cut. */
  readonly hoverTitle?: boolean;
  /** End after this many words, even when more would fit. */
  readonly maxWords?: number;
}

/**
 * Single-line text that, when cut, ends after the last whole word that fits
 * followed by "…", or after `maxWords` words when that is sooner. The full
 * text stays one DOM text node for selection, copy, and the accessible name.
 * Size it with `className` (`block`, or `inline-block` with a max width) and
 * no padding or border. Its width must
 * follow its nearest block ancestor, so wrap it rather than using it directly
 * as a flex item.
 */
export const WordBoundaryTruncatedText = memo(
  function WordBoundaryTruncatedText({
    text,
    hoverTitle,
    maxWords,
    className = '',
    ...rest
  }: WordBoundaryTruncatedTextProps): JSX.Element {
    const ref = useRef<HTMLSpanElement | null>(null);
    useWordBoundaryTruncation(ref, text, { hoverTitle, maxWords });
    return (
      <span {...rest} ref={ref} className={`truncate ${className}`}>
        {text}
      </span>
    );
  },
);
