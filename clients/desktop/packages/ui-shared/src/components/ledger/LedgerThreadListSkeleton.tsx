import type { JSX } from 'react';
import {
  SkeletonBlock,
  useSkeletonBone,
  type SkeletonBarWidth,
} from '../SkeletonBlock';
import type { LedgerDensity } from './ledger-entry-slots';

/** The type avatar's own size: 32px on a page, 24px in a panel. */
function AvatarBone({ page }: { readonly page: boolean }): JSX.Element {
  const bone = useSkeletonBone<HTMLSpanElement>();
  return (
    <span
      {...bone}
      className={`block shrink-0 rounded-full ${page ? 'size-8' : 'size-6'}`}
    />
  );
}

export interface LedgerThreadListSkeletonProps {
  readonly density: LedgerDensity;
  readonly rows?: number;
  /** Placement only: margin and flex participation. */
  readonly className?: string;
}

/** Each row's lines, varied so the column reads as distinct entries. */
const ROW_WIDTHS = [
  { key: 'first', type: '1/5', meta: '1/4', title: '1/2', body: '5/6' },
  { key: 'second', type: '1/5', meta: '1/5', title: '2/5', body: '2/3' },
  { key: 'third', type: '1/5', meta: '1/3', title: '1/2', body: '3/4' },
  { key: 'fourth', type: '1/4', meta: '1/5', title: '1/3', body: '3/5' },
  { key: 'fifth', type: '1/5', meta: '1/4', title: '2/5', body: '2/3' },
] as const satisfies ReadonlyArray<{
  readonly key: string;
  readonly type: SkeletonBarWidth;
  readonly meta: SkeletonBarWidth;
  readonly title: SkeletonBarWidth;
  readonly body: SkeletonBarWidth;
}>;

/**
 * Entries are tall (about 150px), so three fill a side panel and leave room
 * below them for the slow-load note.
 */
const DEFAULT_ROWS = 3;

/**
 * Feed entries that have not arrived, in the shape of the entries that will
 * replace them (`LedgerEntryPost`): the type avatar, the type and
 * attribution lines, the title and a line of body, then the actions line
 * left blank, on the row height and dividers of `LedgerThreadList`. Only the
 * blocks pulse, and not under reduced motion. "Loading entries" is announced
 * to assistive technology only. Wrap it in `DelayedLoadingPlaceholder` so a
 * fast read never flashes it.
 */
export function LedgerThreadListSkeleton({
  density,
  rows = DEFAULT_ROWS,
  className = '',
}: LedgerThreadListSkeletonProps): JSX.Element {
  const page = density === 'page';
  const shown = ROW_WIDTHS.slice(
    0,
    Math.max(1, Math.min(ROW_WIDTHS.length, Math.floor(rows))),
  );
  return (
    <div
      role="status"
      data-testid="ledger-thread-list-skeleton"
      data-density={density}
      className={`flex flex-col ${className}`}
    >
      <span className="sr-only">Loading entries</span>
      {shown.map((row, index) => (
        <div
          key={row.key}
          data-testid="ledger-thread-list-skeleton-row"
          className={`flex gap-3 ${page ? 'py-4' : 'py-3'} ${
            index === shown.length - 1 ? '' : 'border-b border-line-base'
          }`}
        >
          <AvatarBone page={page} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {/* The type line and the attribution line. */}
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex h-5 items-center">
                <SkeletonBlock height="label" width={row.type} />
              </div>
              <div className="flex h-3 items-center">
                <SkeletonBlock height="meta" width={row.meta} />
              </div>
            </div>
            {/* The title and the first line of body. */}
            <div className="flex min-w-0 flex-col gap-2">
              <div className={`flex items-center ${page ? 'h-6' : 'h-5'}`}>
                <SkeletonBlock
                  height={page ? 'title' : 'text'}
                  width={row.title}
                />
              </div>
              <div className="flex h-5 items-center">
                <SkeletonBlock height="text" width={row.body} />
              </div>
            </div>
            {/* Where Show details and Add correction sit, left blank. */}
            <div
              data-testid="ledger-thread-list-skeleton-actions"
              className="h-7"
            />
          </div>
        </div>
      ))}
    </div>
  );
}
