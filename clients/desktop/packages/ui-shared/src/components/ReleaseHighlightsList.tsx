import type { JSX } from 'react';
import type { ReleaseHighlight } from '@canopy/protocol/release-notes';

// Pure display: no hooks or host APIs, so the web changelog renders it on the
// server and the desktop dialog composes it.

export interface ReleaseHighlightsListProps {
  readonly highlights: readonly ReleaseHighlight[];
  readonly className?: string;
  readonly dataTestId?: string;
  /** Reading pages use the larger body style; dialogs keep compact UI text. */
  readonly size?: 'compact' | 'reading';
}

/** Curated release highlights, shared by the desktop dialog and the web changelog. */
export function ReleaseHighlightsList({
  highlights,
  className = '',
  dataTestId,
  size = 'compact',
}: ReleaseHighlightsListProps): JSX.Element {
  const textClassName = size === 'reading' ? 'text-m' : 'text-s';
  return (
    <ul
      className={`flex flex-col ${size === 'reading' ? 'gap-6' : 'gap-3'} ${className}`}
      data-testid={dataTestId}
    >
      {highlights.map((highlight, index) => (
        <li
          // Titles are curated and unique per release; the index guards
          // against a duplicate reaching a preview build.
          key={`${index}:${highlight.title}`}
          className={`flex flex-col ${size === 'reading' ? 'gap-1' : 'gap-0.5'}`}
        >
          <span className={`${textClassName} font-medium fg-primary`}>
            {highlight.title}
          </span>
          {highlight.description ? (
            <span className={`${textClassName} fg-secondary`}>
              {highlight.description}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
