import type { JSX } from 'react';

const GROUPED_COUNT_FORMAT = new Intl.NumberFormat('en-US');

/**
 * Line changes in full, with thousands separators: `+2,674 -963`. For a card
 * with the room a row's condensed `DiffStatsBadge` lacks.
 */
export function GroupedDiffStats({
  insertions,
  deletions,
  testId,
  numerals = 'tabular',
}: {
  insertions: number;
  deletions: number;
  testId?: string;
  /** `tabular` lines counts up in a column; `proportional` reads as prose. */
  numerals?: 'tabular' | 'proportional';
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 ${numerals === 'tabular' ? 'tabular-nums' : ''}`}
      data-testid={testId}
    >
      {insertions > 0 && (
        <span className="fg-success">
          +{GROUPED_COUNT_FORMAT.format(insertions)}
        </span>
      )}
      {deletions > 0 && (
        <span className="fg-destructive">
          -{GROUPED_COUNT_FORMAT.format(deletions)}
        </span>
      )}
    </span>
  );
}
