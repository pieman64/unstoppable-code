'use client';

import { memo, useMemo, type JSX } from 'react';
import type { DiffViewMode } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  pairSplitRows,
  parseUnifiedPatch,
  type PatchFile,
  type PatchHunk,
  type PatchRow,
  type PatchRowKind,
} from './unified-patch';

const ROW_TONE: Record<
  PatchRowKind,
  { readonly background: string; readonly ink: string; readonly marker: string }
> = {
  add: { background: 'bg-success-subtle', ink: 'fg-success', marker: '+' },
  del: {
    background: 'bg-destructive-subtle',
    ink: 'fg-destructive',
    marker: '-',
  },
  context: { background: '', ink: 'fg-tertiary', marker: ' ' },
};

const GUTTER =
  'select-none whitespace-nowrap px-2 text-right align-top tabular-nums';
const CODE = 'whitespace-pre pr-4 align-top fg-primary';
const SEPARATOR = 'bg-fg-primary/[0.04] px-3 fg-secondary';
const FILLER = 'bg-fg-primary/[0.03]';

/** Code text with its non-selectable `+`/`-` marker and no-newline hint. */
function CodeText({ row }: { readonly row: PatchRow }): JSX.Element {
  const tone = ROW_TONE[row.kind];
  return (
    <>
      <span className={`inline-block w-4 select-none text-center ${tone.ink}`}>
        {tone.marker}
      </span>
      {row.text}
      {row.noNewline ? (
        <span className="ml-2 select-none fg-tertiary">
          No newline at end of file
        </span>
      ) : null}
    </>
  );
}

function lineNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

function hunkLabel(hunk: PatchHunk): string {
  return hunk.section === '' ? hunk.header : hunk.section;
}

/**
 * Whether a hunk gets a separator row (Monaco's collapsed unchanged region):
 * between hunks, and before a first hunk that does not start the file.
 */
function hasSeparator(hunk: PatchHunk, index: number): boolean {
  return index > 0 || hunk.oldStart > 1 || hunk.newStart > 1;
}

function UnifiedHunk({
  hunk,
  index,
}: {
  readonly hunk: PatchHunk;
  readonly index: number;
}): JSX.Element {
  return (
    <>
      {hasSeparator(hunk, index) ? (
        <tr data-diff-row="hunk">
          <td colSpan={3} className={SEPARATOR}>
            {hunkLabel(hunk)}
          </td>
        </tr>
      ) : null}
      {hunk.rows.map((row, rowIndex) => {
        const tone = ROW_TONE[row.kind];
        const gutter = `${GUTTER} ${row.kind === 'context' ? 'fg-tertiary' : tone.ink}`;
        return (
          // Index key is safe: rows are recomputed atomically from `patch`.
          <tr
            key={rowIndex}
            data-diff-row={row.kind}
            className={tone.background}
          >
            <td className={gutter}>{lineNumber(row.oldLine)}</td>
            <td className={gutter}>{lineNumber(row.newLine)}</td>
            <td className={`${CODE} w-full`}>
              <CodeText row={row} />
            </td>
          </tr>
        );
      })}
    </>
  );
}

/** One side of a split row: gutter + code, or a faint filler. */
function SplitSide({
  row,
  line,
  side,
}: {
  readonly row: PatchRow | null;
  readonly line: number | null;
  readonly side: 'old' | 'new';
}): JSX.Element {
  if (row === null) {
    return (
      <>
        <td
          className={`${FILLER} ${side === 'new' ? 'border-l' : ''}`}
          data-diff-cell="empty"
        />
        <td className={`${FILLER} w-1/2`} data-diff-cell="empty" />
      </>
    );
  }
  const tone = ROW_TONE[row.kind];
  return (
    <>
      <td
        className={`${GUTTER} ${tone.background} ${
          row.kind === 'context' ? 'fg-tertiary' : tone.ink
        } ${side === 'new' ? 'border-l' : ''}`}
      >
        {lineNumber(line)}
      </td>
      <td
        className={`${CODE} w-1/2 ${tone.background}`}
        data-diff-cell={row.kind}
      >
        <CodeText row={row} />
      </td>
    </>
  );
}

function SplitHunk({
  hunk,
  index,
}: {
  readonly hunk: PatchHunk;
  readonly index: number;
}): JSX.Element {
  const pairs = useMemo(() => pairSplitRows(hunk.rows), [hunk.rows]);
  return (
    <>
      {hasSeparator(hunk, index) ? (
        <tr data-diff-row="hunk">
          <td colSpan={4} className={SEPARATOR}>
            {hunkLabel(hunk)}
          </td>
        </tr>
      ) : null}
      {pairs.map((pair, pairIndex) => (
        <tr
          key={pairIndex}
          data-diff-row={pair.left === pair.right ? 'context' : 'change'}
        >
          <SplitSide
            row={pair.left}
            line={pair.left?.oldLine ?? null}
            side="old"
          />
          <SplitSide
            row={pair.right}
            line={pair.right?.newLine ?? null}
            side="new"
          />
        </tr>
      ))}
    </>
  );
}

function FileSection({
  file,
  viewMode,
  showPath,
}: {
  readonly file: PatchFile;
  readonly viewMode: DiffViewMode;
  readonly showPath: boolean;
}): JSX.Element {
  const columns = viewMode === 'split' ? 4 : 3;
  const Hunk = viewMode === 'split' ? SplitHunk : UnifiedHunk;
  return (
    <tbody>
      {showPath ? (
        <tr data-diff-row="file">
          <td
            colSpan={columns}
            className="sticky top-0 border-y bg-base px-3 py-1 fg-primary"
          >
            {file.path ?? 'Unknown file'}
            {file.notes.length > 0 ? (
              <span className="ml-3 fg-secondary">
                {file.notes.join(' · ')}
              </span>
            ) : null}
          </td>
        </tr>
      ) : (
        file.notes.map((note, index) => (
          <tr key={index} data-diff-row="note">
            <td colSpan={columns} className="px-3 fg-secondary">
              {note}
            </td>
          </tr>
        ))
      )}
      {file.hunks.map((hunk, index) => (
        <Hunk key={hunk.header + String(index)} hunk={hunk} index={index} />
      ))}
    </tbody>
  );
}

/**
 * Dependency-free renderer for a {@link
 * import('@canopy/protocol/portal').PortalDiffPayload} `patch` string.
 *
 * Parses the patch ({@link parseUnifiedPatch}) and renders it the way desktop's
 * Monaco diff editor reads: no git headers, old/new line-number gutters,
 * tinted added/removed rows, a muted separator between hunks, and a split
 * (side-by-side) mode. Deliberately does *not* pull in Monaco or
 * `react-diff-viewer-continued`: the shared package must stay browser-safe and
 * light. The payload has no full file contents, so unchanged regions outside
 * the hunks cannot be expanded, and there is no syntax highlighting.
 */
export interface UnifiedDiffViewProps {
  readonly patch: string;
  /** Unified (one column) or split (old | new). Defaults to unified. */
  readonly viewMode?: DiffViewMode;
  /** Shown when the patch is empty (e.g. a status-only change). */
  readonly emptyState?: JSX.Element;
}

function UnifiedDiffViewImpl({
  patch,
  viewMode = 'unified',
  emptyState,
}: UnifiedDiffViewProps): JSX.Element | null {
  const files = useMemo(
    () =>
      parseUnifiedPatch(patch).filter(
        (file) => file.hunks.length > 0 || file.notes.length > 0,
      ),
    [patch],
  );

  if (files.length === 0) {
    return emptyState ?? null;
  }

  return (
    <div
      className={`min-h-0 flex-1 overflow-auto font-mono text-xs leading-5 ${REPLAY_BLOCK_CLASS}`}
      data-testid="file-unified-diff"
      data-diff-view-mode={viewMode}
    >
      <table className="min-w-full border-collapse">
        {files.map((file, index) => (
          <FileSection
            key={(file.path ?? '') + String(index)}
            file={file}
            viewMode={viewMode}
            showPath={files.length > 1}
          />
        ))}
      </table>
    </div>
  );
}

export const UnifiedDiffView = memo(UnifiedDiffViewImpl);
