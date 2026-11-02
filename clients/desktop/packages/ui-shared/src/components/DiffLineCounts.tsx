import type { JSX } from 'react';

export interface DiffLineCountsProps {
  /** Insertion count. Hidden when undefined or zero. */
  insertions?: number;
  /** Deletion count. Hidden when undefined or zero. */
  deletions?: number;
  /** `compact` is the smaller size used by the diff file trees. */
  size?: 'default' | 'compact';
  /** Layout classes applied to each count. */
  className?: string;
  /** `strong` uses the higher-contrast success/destructive inks. */
  tone?: 'default' | 'strong';
}

/**
 * `+N -M` line counts for a changed file. A zero count renders nothing, so a
 * row with no line changes (a mode-only change, a new symlink) shows no
 * counts and its other content takes the space.
 */
export function DiffLineCounts({
  insertions,
  deletions,
  size = 'default',
  className = '',
  tone = 'default',
}: DiffLineCountsProps): JSX.Element {
  const sizeClass = size === 'compact' ? 'text-3xs' : 'text-2xs';
  const addClass = tone === 'strong' ? 'fg-success-strong' : 'fg-success';
  const delClass =
    tone === 'strong' ? 'fg-destructive-strong' : 'fg-destructive';
  return (
    <>
      {insertions !== undefined && insertions > 0 && (
        <span className={`${sizeClass} ${addClass} ${className}`}>
          +{insertions}
        </span>
      )}
      {deletions !== undefined && deletions > 0 && (
        <span className={`${sizeClass} ${delClass} ${className}`}>
          -{deletions}
        </span>
      )}
    </>
  );
}
