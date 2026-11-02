'use client';

import {
  DEFAULT_OFFICE_PREVIEW_COPY,
  type OfficePreviewCopy,
  type OfficePreviewRenderFailure,
} from './office-preview-copy';
import { LoadingPlaceholder } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { XlsxSheetModel } from './office-parse';
import { parseOfficeDocument } from './office-parse-client';
import { OfficePreviewBanner } from './OfficePreviewBanner';
import { cellKey, columnLabel, coveredCells, spanByAnchor } from './xlsx-grid';

const ROW_HEIGHT_PX = 28;
const OVERSCAN_ROWS = 10;

export interface XlsxPreviewProps {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  readonly createWorker: () => Worker;
  readonly copy?: OfficePreviewCopy;
  readonly onRenderFailure: (failure: OfficePreviewRenderFailure) => void;
}

type State =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly bytes: ArrayBuffer;
      readonly sheets: readonly XlsxSheetModel[];
    };

export function XlsxPreview({
  bytes,
  fileName,
  createWorker,
  copy = DEFAULT_OFFICE_PREVIEW_COPY,
  onRenderFailure,
}: XlsxPreviewProps): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [activeSheet, setActiveSheet] = useState(0);
  const tabsId = useId();
  useEffect(() => {
    const controller = new AbortController();
    void (async (): Promise<void> => {
      try {
        const result = await parseOfficeDocument(
          { kind: 'xlsx', bytes },
          { createWorker, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (result.kind !== 'xlsx') throw new Error('Unexpected parse result.');
        setActiveSheet(0);
        setState({ status: 'ready', bytes, sheets: result.sheets });
      } catch {
        if (!controller.signal.aborted) onRenderFailure('parse-failed');
      }
    })();
    return (): void => controller.abort();
  }, [bytes, createWorker, onRenderFailure]);

  // Both roots share the block: the workbook reuses the loading root div, and
  // the recorder ignores a block class added to an element it already recorded.
  if (state.status === 'loading' || state.bytes !== bytes) {
    return (
      <div
        className={`${REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
        data-testid="xlsx-preview"
      >
        <OfficePreviewBanner text={copy.banner} />
        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          data-testid="xlsx-preview-loading"
        >
          <LoadingPlaceholder />
        </div>
      </div>
    );
  }
  const sheet = state.sheets[activeSheet] ?? state.sheets[0];
  const selectByKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    const count = state.sheets.length;
    if (count === 0) return;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? count - 1
          : event.key === 'ArrowRight'
            ? (index + 1) % count
            : event.key === 'ArrowLeft'
              ? (index + count - 1) % count
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActiveSheet(next);
    document.getElementById(`${tabsId}-tab-${next}`)?.focus();
  };
  return (
    <div
      className={`${REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
      data-testid="xlsx-preview"
    >
      <OfficePreviewBanner text={copy.banner} />
      <div
        role="tablist"
        aria-label={`Sheets in ${fileName}`}
        className="flex shrink-0 gap-1 overflow-x-auto border-b px-2"
      >
        {state.sheets.map((entry, index) => (
          <button
            key={`${index}:${entry.name}`}
            type="button"
            role="tab"
            id={`${tabsId}-tab-${index}`}
            aria-controls={`${tabsId}-panel`}
            tabIndex={index === activeSheet ? 0 : -1}
            aria-selected={index === activeSheet}
            onKeyDown={(event): void => selectByKey(event, index)}
            onClick={(): void => setActiveSheet(index)}
            data-testid="xlsx-sheet-tab"
            className={`relative px-3 py-1.5 text-xs ${index === activeSheet ? 'fg-primary' : 'fg-secondary hover:fg-primary'}`}
          >
            {entry.name}
            {index === activeSheet && (
              <span
                aria-hidden="true"
                data-testid="xlsx-active-sheet-indicator"
                className="absolute inset-x-0 bottom-0 h-0.5 bg-accent"
              />
            )}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        data-selectable
        id={`${tabsId}-panel`}
        aria-labelledby={sheet ? `${tabsId}-tab-${activeSheet}` : undefined}
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col"
      >
        {sheet && sheet.rows.length > 0 ? (
          <SheetGrid
            key={`${activeSheet}:${sheet.name}`}
            sheet={sheet}
            truncationRecovery={copy.truncationRecovery}
          />
        ) : (
          <p
            className="p-6 text-center text-xs fg-secondary"
            data-testid="xlsx-empty"
          >
            {sheet
              ? `${sheet.name} is empty.`
              : 'This workbook has no sheets to preview.'}
          </p>
        )}
      </div>
    </div>
  );
}

function SheetGrid({
  sheet,
  truncationRecovery,
}: {
  readonly sheet: XlsxSheetModel;
  readonly truncationRecovery: string;
}): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const visibleCols = sheet.rows.reduce(
    (largest, row) => Math.max(largest, row.length),
    0,
  );
  const rowsTruncated = sheet.rowCount > sheet.rows.length;
  const colsTruncated = sheet.colCount > visibleCols;
  const spans = useMemo(() => spanByAnchor(sheet.merges), [sheet.merges]);
  // TanStack Virtual owns mutable measurement state by design.
  const virtualizer = useVirtualizer({
    count: sheet.rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      for (const merge of sheet.merges) {
        if (
          merge.endRow >= range.startIndex &&
          merge.startRow <= range.endIndex
        )
          indexes.push(merge.startRow);
      }
      return [...new Set(indexes)].sort((left, right) => left - right);
    },
  });
  const items = virtualizer.getVirtualItems();
  const covered = coveredCells(
    sheet.merges,
    new Set(items.map((item) => item.index)),
  );
  const gridTemplateColumns = `48px repeat(${visibleCols}, 140px)`;
  return (
    <>
      {(rowsTruncated || colsTruncated) && (
        <div
          role="status"
          className="shrink-0 border-b px-3 py-1.5 text-xs fg-secondary"
          data-testid="xlsx-truncation-banner"
        >
          Showing the first {sheet.rows.length.toLocaleString('en-US')} of{' '}
          {sheet.rowCount.toLocaleString('en-US')} rows
          {colsTruncated
            ? ` and ${visibleCols} of ${sheet.colCount} columns`
            : ''}
          . {truncationRecovery}
        </div>
      )}
      {(sheet.hasFormulas || rowsTruncated || colsTruncated) && (
        <div
          className="shrink-0 border-b px-3 py-1.5 text-xs fg-secondary"
          data-testid="xlsx-formula-note"
        >
          Cells show the values saved in the file; formulas are not
          recalculated.
        </div>
      )}
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto"
        data-testid="xlsx-grid"
        data-row-count={sheet.rows.length}
      >
        <div
          role="table"
          aria-label={sheet.name}
          aria-rowcount={sheet.rows.length + 1}
          aria-colcount={visibleCols + 1}
          className="text-xs"
          style={{ width: 48 + visibleCols * 140 }}
        >
          {/*
           * The frozen edge. Both this header row and the row-number gutter
           * below are `position: sticky`, so they have to be OPAQUE or the
           * rows travelling underneath read straight through the column
           * letters and the row numbers. `bg-secondary` also fills the gutter
           * corner, so the header and the gutter read as one edge rather than
           * a filled strip with a hole at its origin.
           */}
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-10 grid bg-secondary"
            style={{ gridTemplateColumns, height: ROW_HEIGHT_PX }}
          >
            <div role="columnheader" aria-label="Row number" />
            {Array.from({ length: visibleCols }, (_, col) => (
              <div
                key={col}
                role="columnheader"
                aria-colindex={col + 2}
                className="border px-2 font-medium fg-secondary"
              >
                {columnLabel(col)}
              </div>
            ))}
          </div>
          <div
            role="rowgroup"
            className="relative"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((item) => (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 2}
                data-index={item.index}
                className="absolute left-0 grid"
                style={{
                  top: item.start,
                  height: ROW_HEIGHT_PX,
                  gridTemplateColumns,
                }}
              >
                {/*
                 * `z-2`, not the header row's `z-10` and not `z-index: auto`.
                 * Painting order decides what a sticky gutter covers: the
                 * cells are positioned siblings LATER in tree order, so at
                 * `auto` they paint over the gutter and its fill buys
                 * nothing, and a merged cell explicitly takes `1`. Above
                 * both, below the header row, so the top-left corner stays
                 * the header's.
                 */}
                <div
                  role="rowheader"
                  aria-colindex={1}
                  className="sticky left-0 z-2 col-start-1 border bg-secondary px-2 text-right fg-secondary"
                >
                  {item.index + 1}
                </div>
                {Array.from({ length: visibleCols }, (_, col) => {
                  const key = cellKey(item.index, col);
                  if (covered.has(key)) return null;
                  const span = spans.get(key);
                  const value = sheet.rows[item.index]?.[col] ?? '';
                  return (
                    <div
                      key={col}
                      role="cell"
                      aria-colindex={col + 2}
                      aria-rowspan={span?.rowSpan}
                      aria-colspan={span?.colSpan}
                      data-testid="xlsx-cell"
                      data-cell={`${columnLabel(col)}${item.index + 1}`}
                      title={value}
                      className="relative box-border min-w-0 overflow-hidden text-ellipsis whitespace-nowrap border px-2"
                      style={{
                        gridColumn: `${col + 2} / span ${span?.colSpan ?? 1}`,
                        height: (span?.rowSpan ?? 1) * ROW_HEIGHT_PX,
                        zIndex: span ? 1 : undefined,
                      }}
                    >
                      {value}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
