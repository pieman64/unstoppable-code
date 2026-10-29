import type { JSX } from 'react';
import { ArrowUp } from '../icons/AppIcons';

export type SortDirection = 'asc' | 'desc';

interface SortableColumnHeaderProps<TColumn extends string> {
  label: string;
  column: TColumn;
  /** The column the table is currently sorted by, if any. */
  activeColumn: TColumn | null;
  /** Direction of the active sort; `null` while the table is unsorted. */
  direction: SortDirection | null;
  onToggle: (column: TColumn) => void;
  /** Applied to the `<th>` for column-specific width and wrapping. */
  className?: string;
  /** Lands on the button, which is the element automation should click. */
  testId?: string;
}

const ARIA_SORT = {
  asc: 'ascending',
  desc: 'descending',
  none: 'none',
} as const;

/**
 * Table header cell whose label is a sort button. Pure display: the caller
 * owns the sort state and decides what a toggle means.
 *
 * The direction arrow always occupies its slot — hidden while the column is
 * inactive, hinted on hover and keyboard focus — so activating a sort never
 * shifts the header. State is announced through `aria-sort` on the `<th>`.
 */
export function SortableColumnHeader<TColumn extends string>({
  label,
  column,
  activeColumn,
  direction,
  onToggle,
  className,
  testId,
}: SortableColumnHeaderProps<TColumn>): JSX.Element {
  const activeDirection = activeColumn === column ? direction : null;
  const sortState = activeDirection ?? 'none';
  let arrowClassName =
    'opacity-0 group-hover:opacity-50 group-focus-visible:opacity-50';
  if (activeDirection === 'asc') {
    arrowClassName = 'fg-primary';
  } else if (activeDirection === 'desc') {
    arrowClassName = 'rotate-180 fg-primary';
  }

  return (
    <th
      scope="col"
      aria-sort={ARIA_SORT[sortState]}
      className={`px-3 py-2${className ? ` ${className}` : ''}`}
    >
      <button
        type="button"
        data-testid={testId}
        data-sort-direction={sortState}
        onClick={(): void => onToggle(column)}
        className={`focus-ring group inline-flex items-center gap-1 rounded-sm text-left transition-colors hover:fg-primary ${
          activeDirection === null ? '' : 'fg-primary'
        }`}
      >
        {label}
        <ArrowUp
          width={12}
          height={12}
          className={`shrink-0 transition-opacity ${arrowClassName}`}
        />
      </button>
    </th>
  );
}
