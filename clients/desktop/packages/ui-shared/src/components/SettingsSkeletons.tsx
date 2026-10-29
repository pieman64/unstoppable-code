import type { JSX, ReactNode } from 'react';
import {
  SKELETON_BLOCK_CLASS,
  SkeletonBlock,
  type SkeletonBarWidth,
} from './SkeletonBlock';

/**
 * Placeholders for settings pages and panels that have nothing to show yet.
 * Each one takes the shape of the content that is coming, so the content
 * replaces it in place. They carry no visible text: a `role="status"` region
 * announces "Loading" to assistive technology only. None has an entry
 * animation, since they remount on navigation; the shade on their blocks
 * stops under reduced motion. Place them with `className`; wrap them in
 * `DelayedLoadingPlaceholder` so fast answers never flash them.
 */

interface SkeletonStatusProps {
  readonly testId: string;
  readonly className: string;
  readonly children: ReactNode;
}

function SkeletonStatus({
  testId,
  className,
  children,
}: SkeletonStatusProps): JSX.Element {
  return (
    <div role="status" data-testid={testId} className={className}>
      <span className="sr-only">Loading</span>
      {children}
    </div>
  );
}

const DEFAULT_ROWS = 3;

function rowKeys(rows: number): readonly number[] {
  return Array.from({ length: Math.max(1, Math.floor(rows)) }, (_, i) => i);
}

/** Title widths cycle so a column of rows reads as distinct entries. */
const TITLE_WIDTHS = ['2/5', '1/3', '1/2'] as const satisfies readonly [
  SkeletonBarWidth,
  ...SkeletonBarWidth[],
];
const META_WIDTHS = ['1/4', '1/5', '1/3'] as const satisfies readonly [
  SkeletonBarWidth,
  ...SkeletonBarWidth[],
];

function cycled(
  values: readonly [SkeletonBarWidth, ...SkeletonBarWidth[]],
  index: number,
): SkeletonBarWidth {
  return values[index % values.length] ?? values[0];
}

export interface SettingsListSkeletonProps {
  readonly rows?: number;
  /** `square` for organization logos; `circle` for people. */
  readonly avatarShape?: 'circle' | 'square';
  /** Placement only: margin, width, and flex participation. */
  readonly className?: string;
}

/** Bordered rows, each an avatar beside a title and a shorter meta line. */
export function SettingsListSkeleton({
  rows = DEFAULT_ROWS,
  avatarShape = 'circle',
  className = '',
}: SettingsListSkeletonProps): JSX.Element {
  return (
    <SkeletonStatus
      testId="settings-skeleton-list"
      className={`flex flex-col gap-2 ${className}`}
    >
      {rowKeys(rows).map((row) => (
        <div
          key={row}
          className="flex items-center gap-3 rounded-lg border px-4 py-3"
        >
          <SkeletonBlock shape={avatarShape} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <SkeletonBlock height="text" width={cycled(TITLE_WIDTHS, row)} />
            <SkeletonBlock height="meta" width={cycled(META_WIDTHS, row)} />
          </div>
        </div>
      ))}
    </SkeletonStatus>
  );
}

export interface SettingsFormSkeletonProps {
  readonly rows?: number;
  /** Placement only: margin, width, and flex participation. */
  readonly className?: string;
}

/**
 * Setting rows divided by hairlines: a label and a description on the left,
 * a toggle-shaped block on the right.
 */
export function SettingsFormSkeleton({
  rows = DEFAULT_ROWS,
  className = '',
}: SettingsFormSkeletonProps): JSX.Element {
  return (
    <SkeletonStatus
      testId="settings-skeleton-form"
      className={`flex flex-col divide-y ${className}`}
    >
      {rowKeys(rows).map((row) => (
        <div key={row} className="flex items-center gap-6 py-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <SkeletonBlock height="text" width={cycled(TITLE_WIDTHS, row)} />
            <SkeletonBlock height="meta" width="3/4" />
          </div>
          <SkeletonBlock shape="toggle" />
        </div>
      ))}
    </SkeletonStatus>
  );
}

export interface SettingsTableSkeletonProps {
  /** Body rows; the tinted header row is always drawn. */
  readonly rows?: number;
  /** Placement only: margin, width, and flex participation. */
  readonly className?: string;
}

const TABLE_COLUMNS = [
  { key: 'first', width: '3/4' },
  { key: 'second', width: '1/2' },
  { key: 'third', width: '2/3' },
] as const satisfies ReadonlyArray<{
  readonly key: string;
  readonly width: SkeletonBarWidth;
}>;

/** A bordered table: a tinted header row over body rows, three columns. */
export function SettingsTableSkeleton({
  rows = DEFAULT_ROWS,
  className = '',
}: SettingsTableSkeletonProps): JSX.Element {
  return (
    <SkeletonStatus
      testId="settings-skeleton-table"
      className={`overflow-hidden rounded-lg border ${className}`}
    >
      <div className="grid grid-cols-3 gap-4 bg-subtle px-4 py-3">
        {TABLE_COLUMNS.map((column) => (
          <SkeletonBlock key={column.key} height="label" width="1/3" />
        ))}
      </div>
      {rowKeys(rows).map((row) => (
        <div key={row} className="grid grid-cols-3 gap-4 border-t px-4 py-3.5">
          {TABLE_COLUMNS.map((column) => (
            <SkeletonBlock
              key={column.key}
              height="text"
              width={column.width}
            />
          ))}
        </div>
      ))}
    </SkeletonStatus>
  );
}

export interface SettingsCardsSkeletonProps {
  /** Placement only: margin, width, and flex participation. */
  readonly className?: string;
}

/** Two bordered cards: the first with three bars, the second with two. */
export function SettingsCardsSkeleton({
  className = '',
}: SettingsCardsSkeletonProps): JSX.Element {
  return (
    <SkeletonStatus
      testId="settings-skeleton-cards"
      className={`flex flex-col gap-4 ${className}`}
    >
      <div className="flex flex-col gap-3 rounded-lg border p-5">
        <SkeletonBlock height="title" width="2/5" />
        <SkeletonBlock height="text" width="5/6" />
        <SkeletonBlock height="text" width="3/5" />
      </div>
      <div className="flex flex-col gap-3 rounded-lg border p-5">
        <SkeletonBlock height="title" width="1/3" />
        <SkeletonBlock height="text" width="3/4" />
      </div>
    </SkeletonStatus>
  );
}

export interface SettingsChartSkeletonProps {
  /** `bars` for usage and statistics; `graph` for an entity graph. */
  readonly variant?: 'bars' | 'graph';
  /** Placement only: margin, width, and flex participation. */
  readonly className?: string;
}

const STAT_TILES = ['first', 'second', 'third'] as const;
/** Fixed decorative heights, so the silhouette never changes between mounts. */
const CHART_BAR_HEIGHTS = [
  '45%',
  '70%',
  '35%',
  '85%',
  '55%',
  '65%',
  '30%',
  '75%',
  '50%',
  '60%',
] as const;

function ChartBarsSkeleton({ className }: { className: string }): JSX.Element {
  return (
    <SkeletonStatus
      testId="settings-skeleton-chart-bars"
      className={`flex flex-col gap-4 ${className}`}
    >
      <div className="grid grid-cols-3 gap-3">
        {STAT_TILES.map((tile) => (
          <div
            key={tile}
            className="flex flex-col gap-2.5 rounded-lg border px-4 py-3"
          >
            <SkeletonBlock height="label" width="1/2" />
            <SkeletonBlock height="value" width="2/3" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border p-4">
        <div className="flex h-48 items-end gap-2 border-b">
          {CHART_BAR_HEIGHTS.map((height) => (
            <span
              key={height}
              aria-hidden="true"
              className={`${SKELETON_BLOCK_CLASS} flex-1 rounded-t-sm`}
              style={{ height }}
            />
          ))}
        </div>
      </div>
    </SkeletonStatus>
  );
}

const GRAPH_CENTER = { x: 200, y: 120, r: 22 } as const;
const GRAPH_NODES = [
  { x: 90, y: 55, r: 12 },
  { x: 310, y: 50, r: 13 },
  { x: 60, y: 170, r: 11 },
  { x: 340, y: 175, r: 12 },
  { x: 200, y: 215, r: 10 },
  { x: 205, y: 28, r: 9 },
] as const;
const GRAPH_CROSS_EDGES = [
  [GRAPH_NODES[0], GRAPH_NODES[2]],
  [GRAPH_NODES[1], GRAPH_NODES[3]],
  [GRAPH_NODES[0], GRAPH_NODES[5]],
] as const;

function ChartGraphSkeleton({ className }: { className: string }): JSX.Element {
  return (
    <SkeletonStatus
      testId="settings-skeleton-chart-graph"
      className={`flex min-h-80 flex-1 rounded-lg border p-4 ${className}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 400 240"
        preserveAspectRatio="xMidYMid meet"
        className="min-h-0 w-full flex-1 animate-pulse motion-reduce:animate-none"
      >
        <g className="stroke-muted" strokeWidth={2}>
          {GRAPH_NODES.map((node) => (
            <line
              key={`center-${node.x}-${node.y}`}
              x1={GRAPH_CENTER.x}
              y1={GRAPH_CENTER.y}
              x2={node.x}
              y2={node.y}
            />
          ))}
          {GRAPH_CROSS_EDGES.map(([from, to]) => (
            <line
              key={`edge-${from.x}-${to.x}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
            />
          ))}
        </g>
        <g className="fill-muted">
          <circle cx={GRAPH_CENTER.x} cy={GRAPH_CENTER.y} r={GRAPH_CENTER.r} />
          {GRAPH_NODES.map((node) => (
            <circle
              key={`node-${node.x}-${node.y}`}
              cx={node.x}
              cy={node.y}
              r={node.r}
            />
          ))}
        </g>
      </svg>
    </SkeletonStatus>
  );
}

/**
 * `bars`: three stat tiles above a chart area with a baseline and fixed bars.
 * `graph`: a fixed silhouette of muted nodes joined by lines.
 */
export function SettingsChartSkeleton({
  variant = 'bars',
  className = '',
}: SettingsChartSkeletonProps): JSX.Element {
  return variant === 'graph' ? (
    <ChartGraphSkeleton className={className} />
  ) : (
    <ChartBarsSkeleton className={className} />
  );
}
