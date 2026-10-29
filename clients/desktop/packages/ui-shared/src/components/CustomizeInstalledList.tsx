import { Fragment, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import { SECONDARY_ACTION_BUTTON_CLASS } from '../lib/row-chips';
import { CUSTOMIZE_ROW_GRID_CLASS } from '../lib/customize-grid';

export interface CustomizeInstalledListProps {
  readonly sectionId: string;
  readonly entries: readonly UnifiedPluginEntry[];
  /** Collapsed preview size; omitted shows every entry. */
  readonly previewLimit?: number;
  readonly onShowAll?: () => void;
  readonly renderRow: (entry: UnifiedPluginEntry) => ReactNode;
}

function moveFocus(event: KeyboardEvent<HTMLUListElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[data-marketplace-entry="true"]',
    ),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
  if (index === -1 || !next) return;
  event.preventDefault();
  next.focus();
}

/** Rows of one headed section, with an optional Show all preview. */
export function CustomizeInstalledList({
  sectionId,
  entries,
  previewLimit,
  onShowAll,
  renderRow,
}: CustomizeInstalledListProps): JSX.Element {
  const collapsed =
    previewLimit !== undefined &&
    onShowAll !== undefined &&
    entries.length > previewLimit;
  const visible = collapsed ? entries.slice(0, previewLimit) : entries;
  return (
    <>
      <ul
        data-testid={`customize-section-${sectionId}-rows`}
        data-row-count={visible.length}
        className={`mt-3 ${CUSTOMIZE_ROW_GRID_CLASS}`}
        onKeyDown={moveFocus}
      >
        {visible.map((entry) => (
          <Fragment key={entry.id}>{renderRow(entry)}</Fragment>
        ))}
      </ul>
      {collapsed && (
        <button
          type="button"
          data-testid={`customize-section-${sectionId}-show-all`}
          onClick={onShowAll}
          className={`${SECONDARY_ACTION_BUTTON_CLASS} mt-3`}
        >
          {`Show all ${entries.length}`}
        </button>
      )}
    </>
  );
}
