'use client';

import { useMemo, useState, type JSX, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
} from '@canopy/ui-shared/icons/AppIcons';

export interface StatColumn<T> {
  key: string;
  header: string;
  /** Right-align numeric columns. */
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
  /**
   * When provided the column is sortable: the returned scalar is used as the
   * sort key (numbers compared numerically, strings via `localeCompare`).
   * Return `null` for a "missing" value (e.g. a rate with a zero denominator
   * rendered as `'—'`); missing values always sort to the bottom regardless of
   * direction. Columns without this callback are not sortable.
   */
  sortValue?: (row: T) => number | string | null;
  /** Optional header tooltip shown via the native `title` attribute. */
  tooltip?: string;
}

export type StatSortDir = 'asc' | 'desc';

/** A spanning group rendered as a second header row above the columns. */
export interface StatColumnGroup {
  label: string;
  /** Number of leaf columns this group spans. */
  span: number;
}

interface StatTableProps<T> {
  columns: ReadonlyArray<StatColumn<T>>;
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  emptyLabel: string;
  testId?: string;
  /**
   * Column `key` to sort by initially. When set the table becomes sortable:
   * sortable headers render as clickable buttons and rows sort by the active
   * column. Omit to keep the table in its original static (input-order) mode.
   */
  defaultSortKey?: string;
  /** Initial sort direction for `defaultSortKey` (defaults to `desc`). */
  defaultSortDir?: StatSortDir;
  /** Optional grouping header row rendered above the column headers. */
  columnGroups?: ReadonlyArray<StatColumnGroup>;
}

/** Compact, dependency-free breakdown table used across the metric tabs. */
export function StatTable<T>({
  columns,
  rows,
  rowKey,
  emptyLabel,
  testId,
  defaultSortKey,
  defaultSortDir = 'desc',
  columnGroups,
}: StatTableProps<T>): JSX.Element {
  const sortable = defaultSortKey !== undefined;
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSortKey);
  const [sortDir, setSortDir] = useState<StatSortDir>(defaultSortDir);

  const activeColumn = useMemo(
    () => columns.find((column) => column.key === sortKey),
    [columns, sortKey],
  );

  const sortedRows = useMemo(() => {
    if (!activeColumn?.sortValue) {
      return rows;
    }
    const sortValue = activeColumn.sortValue;
    const direction = sortDir === 'asc' ? 1 : -1;
    // Slice so the input order is preserved for non-sorted renders and stable
    // ties keep their original relative order.
    return [...rows].sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      // Missing values (`null`) always sort last, independent of direction, so
      // they mirror the `'—'` the cell renders instead of floating to the top.
      if (av === null || bv === null) {
        if (av === null && bv === null) {
          return 0;
        }
        return av === null ? 1 : -1;
      }
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * direction;
      }
      return String(av).localeCompare(String(bv)) * direction;
    });
  }, [rows, activeColumn, sortDir]);

  const handleSort = (column: StatColumn<T>): void => {
    if (!column.sortValue) {
      return;
    }
    if (column.key === sortKey) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(column.key);
    // Numeric/headline columns are most useful highest-first; default to desc.
    setSortDir('desc');
  };

  if (rows.length === 0) {
    return (
      <p
        className="rounded-lg border border-dashed px-4 py-6 text-center text-s fg-secondary"
        data-testid={testId ? `${testId}-empty` : undefined}
      >
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border" data-testid={testId}>
      <table className="w-full border-collapse text-s">
        <thead>
          {columnGroups && columnGroups.length > 0 && (
            <tr className="border-b bg-secondary/60 text-left text-xs font-semibold fg-secondary">
              {columnGroups.map((group, index) => (
                <th
                  key={`${group.label}-${index}`}
                  scope="colgroup"
                  colSpan={group.span}
                  className="whitespace-nowrap border-r px-3 py-1.5 last:border-r-0"
                >
                  {group.label}
                </th>
              ))}
            </tr>
          )}
          <tr className="border-b bg-secondary/50 text-left text-xs fg-secondary">
            {columns.map((column) => {
              const isSortable = sortable && column.sortValue !== undefined;
              const isActive = isSortable && column.key === sortKey;
              const ariaSort = isActive
                ? sortDir === 'asc'
                  ? 'ascending'
                  : 'descending'
                : isSortable
                  ? 'none'
                  : undefined;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  title={column.tooltip}
                  className={`whitespace-nowrap px-3 py-2 font-medium ${
                    column.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {isSortable ? (
                    <button
                      type="button"
                      data-settings-control="sort"
                      onClick={() => handleSort(column)}
                      data-testid={
                        testId ? `${testId}-sort-${column.key}` : undefined
                      }
                      className={`inline-flex items-center gap-1 font-medium transition-colors hover:fg-primary ${
                        column.align === 'right' ? 'flex-row-reverse' : ''
                      } ${isActive ? 'fg-primary' : ''}`}
                    >
                      <span>{column.header}</span>
                      <SortIcon active={isActive} dir={sortDir} />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              className="border-b last:border-0 hover:bg-secondary/30"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`px-3 py-2 fg-primary ${
                    column.align === 'right'
                      ? 'text-right tabular-nums'
                      : 'text-left'
                  }`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface SortIconProps {
  active: boolean;
  dir: StatSortDir;
}

function SortIcon({ active, dir }: SortIconProps): JSX.Element {
  if (!active) {
    return (
      <ChevronsUpDown
        size={12}
        className="fg-secondary/60"
        aria-hidden="true"
      />
    );
  }
  return dir === 'asc' ? (
    <ChevronUp size={12} aria-hidden="true" />
  ) : (
    <ChevronDown size={12} aria-hidden="true" />
  );
}
