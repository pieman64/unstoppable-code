'use client';

import type { ComponentType, JSX, ReactNode, SVGProps } from 'react';
import {
  Button,
  EmptyState,
  PageSearchControls,
  PageSearchFilters,
  PageSearchRow,
  SkeletonBlock,
  SearchEmptyState,
  SortDropdown,
  TableActionButton,
  TableActionsCell,
  ToggleSwitch,
  Tooltip,
  WorkflowLastRunText,
  pageFilter,
  type SkeletonBarWidth,
} from '@canopy/ui-shared/components';
import {
  AppAdvisorIcon,
  ChatIcon,
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
  GlobeIcon,
  FolderIcon,
  CircleCheckIcon,
  CognitionIcon,
  CopyIcon,
  FilterIcon,
  HistoryIcon,
  InputIcon,
  MessageIcon,
  PencilIcon,
  PipelineIcon,
  PlansIcon,
  PlayIcon,
  PlusIcon,
  ScheduleIcon,
  ShareIcon,
  TaskIcon,
  TerminalIcon,
  TimeslotIcon,
  TrashIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  WORKFLOW_LIBRARY_ACTION_LABELS,
  WORKFLOW_LIBRARY_SORTS,
  WORKFLOW_LIBRARY_SORT_LABELS,
  WORKFLOW_LIBRARY_SOURCES,
  WORKFLOW_LIBRARY_SOURCE_LABELS,
  WORKFLOW_LIBRARY_STATUS_FILTERS,
  WORKFLOW_LIBRARY_STATUS_LABELS,
  WORKFLOW_NO_PROJECT,
  WORKFLOW_STEP_LABELS,
  WORKFLOW_TRIGGER_LABELS,
  describeClearLibraryFilters,
  describeNoLibraryMatches,
  menuWorkflowLibraryActions,
  truncateStepChain,
  workflowLibraryFiltersActive,
  type WorkflowLibraryAction,
  type WorkflowLibraryFacetCounts,
  type WorkflowLibraryFilters,
  type WorkflowLibraryPage,
  type WorkflowLibraryRow,
  type WorkflowLibrarySort,
  type WorkflowLibrarySource,
  type WorkflowLibraryStatusFilter,
  type WorkflowStepGlyph,
  type WorkflowTriggerKind,
} from './workflow-library-model';
import { formatNextRun } from './workflow-time';
import {
  WorkflowsRowMenu,
  type WorkflowsRowMenuItem,
  WorkflowsSearchField,
} from './workflows-controls';

type Glyph = ComponentType<SVGProps<SVGSVGElement>>;

const TRIGGER_GLYPHS: Readonly<Record<WorkflowTriggerKind, Glyph>> = {
  schedule: ScheduleIcon,
  once: TimeslotIcon,
  manual: PlayIcon,
  'plan-approved': PlansIcon,
  'task-ready': TaskIcon,
};

const STEP_GLYPHS: Readonly<Record<WorkflowStepGlyph, Glyph>> = {
  gate: FilterIcon,
  advisor: AppAdvisorIcon,
  chat: ChatIcon,
  message: MessageIcon,
  agent: CognitionIcon,
  script: TerminalIcon,
  input: InputIcon,
  pipeline: PipelineIcon,
  step: PipelineIcon,
};

function TriggerGlyph({
  trigger,
  size = 14,
}: {
  readonly trigger: WorkflowTriggerKind;
  readonly size?: number;
}): JSX.Element {
  const Icon = TRIGGER_GLYPHS[trigger];
  return <Icon width={size} height={size} aria-hidden="true" />;
}

/**
 * Each library menu row's icon and group. Share… and Copy share link are one
 * action's two forms, so they share an icon; Delete closes the menu.
 * `toggle`, `run` and `add` are row buttons today, never menu rows; they keep
 * an entry so the map stays total over the action union.
 */
const LIBRARY_MENU_ROWS: Readonly<
  Record<
    WorkflowLibraryAction,
    Pick<WorkflowsRowMenuItem, 'icon' | 'group' | 'destructive'>
  >
> = {
  toggle: { icon: <PlayIcon />, group: 'manage' },
  run: { icon: <PlayIcon />, group: 'manage' },
  add: { icon: <PlusIcon />, group: 'manage' },
  edit: { icon: <PencilIcon />, group: 'manage' },
  'view-runs': { icon: <HistoryIcon />, group: 'manage' },
  duplicate: { icon: <CopyIcon />, group: 'manage' },
  share: { icon: <ShareIcon />, group: 'share' },
  'copy-link': { icon: <ShareIcon />, group: 'share' },
  delete: { icon: <TrashIcon />, destructive: true },
};

export interface WorkflowStepChainProps {
  readonly trigger: WorkflowTriggerKind;
  readonly steps: readonly WorkflowStepGlyph[];
}

/**
 * Trigger glyph, then the first three steps and `+N`: a quiet preview of the
 * workflow's shape. Decorative; the row's text carries the meaning.
 */
export function WorkflowStepChain({
  trigger,
  steps,
}: WorkflowStepChainProps): JSX.Element {
  const { shown, more } = truncateStepChain(steps);
  return (
    <span
      className="flex shrink-0 items-center gap-1 fg-tertiary"
      data-testid="workflows-step-chain"
      aria-hidden="true"
    >
      <span
        className="flex fg-secondary"
        title={WORKFLOW_TRIGGER_LABELS[trigger]}
      >
        <TriggerGlyph trigger={trigger} />
      </span>
      {shown.length > 0 ? (
        <ChevronRightMediumIcon
          width={12}
          height={12}
          aria-hidden="true"
          className="fg-quaternary"
        />
      ) : null}
      {shown.map((step, index) => {
        const Icon = STEP_GLYPHS[step];
        return (
          <span
            // Steps repeat, so position is the only stable identity.
            key={`${step}-${String(index)}`}
            className="flex"
            title={WORKFLOW_STEP_LABELS[step]}
            data-step={step}
          >
            <Icon width={14} height={14} aria-hidden="true" />
          </span>
        );
      })}
      {more > 0 ? (
        <span
          className="text-2xs tabular-nums fg-tertiary"
          data-testid="workflows-step-chain-more"
        >
          +{more}
        </span>
      ) : null}
    </span>
  );
}

export interface WorkflowsLibraryTableProps {
  /** One page of filtered, sorted rows. */
  readonly rows: readonly WorkflowLibraryRow[];
  /** Epoch milliseconds, so the Next run column is stable within a render. */
  readonly now: number;
  readonly locale?: string;
  /** Opens the row: its editor, or the read-only detail of a shared item. */
  readonly onOpen: (row: WorkflowLibraryRow) => void;
  readonly onAction: (
    row: WorkflowLibraryRow,
    action: WorkflowLibraryAction,
  ) => void;
  /** Rows with an action in flight; their switch and Run are disabled. */
  readonly busyKeys?: ReadonlySet<string>;
  /** The row a reveal is pointing at (an install that just finished). */
  readonly highlightKey?: string | null;
  /**
   * Fold Next run under the trigger. Hosts set it at narrow widths so the
   * table never scrolls sideways.
   */
  readonly compact?: boolean;
}

/**
 * The Library table (CAN-3981): automations and pipelines in one inventory.
 * A row click or Enter opens the row; the switch, Run, Add and the More menu
 * never do.
 */
export function WorkflowsLibraryTable({
  rows,
  now,
  locale,
  onOpen,
  onAction,
  busyKeys,
  highlightKey,
  compact = false,
}: WorkflowsLibraryTableProps): JSX.Element {
  return (
    <div
      className="overflow-hidden rounded-lg border"
      data-testid="workflows-library-table"
    >
      <table className="w-full table-fixed text-left text-s">
        <WorkflowsLibraryTableHead compact={compact} />
        <tbody>
          {rows.map((row) => (
            <WorkflowsLibraryTableRow
              key={row.key}
              row={row}
              now={now}
              locale={locale}
              compact={compact}
              busy={busyKeys?.has(row.key) === true}
              highlighted={highlightKey === row.key}
              onOpen={onOpen}
              onAction={onAction}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The Library table's column heads, shared by the table and its loading
 * skeleton so the two always line up.
 */
function WorkflowsLibraryTableHead({
  compact,
}: {
  readonly compact: boolean;
}): JSX.Element {
  return (
    <thead className="text-xs fg-tertiary">
      <tr>
        <th className="px-4 py-2.5 font-normal">Workflow</th>
        <th className={`${compact ? 'w-44' : 'w-52'} px-3 py-2.5 font-normal`}>
          Trigger
        </th>
        <th className="w-48 px-3 py-2.5 font-normal">Last run</th>
        {compact ? null : (
          <th className="w-44 px-3 py-2.5 font-normal">Next run</th>
        )}
        <th className="w-32 px-3 py-2.5 text-right font-normal">
          <span className="sr-only">On or off, and actions</span>
        </th>
      </tr>
    </thead>
  );
}

export interface WorkflowsLibraryTableSkeletonProps {
  /** Body rows. Defaults to five. */
  readonly rows?: number;
  /** Match the table's narrow layout, without the Next run column. */
  readonly compact?: boolean;
}

/** Each row's bars, varied so the column reads as distinct workflows. */
const SKELETON_ROWS = [
  { key: 'first', name: '1/2', summary: '1/4', trigger: '3/5', run: '2/3' },
  { key: 'second', name: '2/5', summary: '1/5', trigger: '1/2', run: '3/5' },
  { key: 'third', name: '1/2', summary: '1/3', trigger: '2/3', run: '2/3' },
  { key: 'fourth', name: '1/3', summary: '1/4', trigger: '1/2', run: '3/4' },
  { key: 'fifth', name: '2/5', summary: '1/5', trigger: '3/5', run: '1/2' },
] as const satisfies ReadonlyArray<{
  readonly key: string;
  readonly name: SkeletonBarWidth;
  readonly summary: SkeletonBarWidth;
  readonly trigger: SkeletonBarWidth;
  readonly run: SkeletonBarWidth;
}>;

/**
 * The Library while its rows load: the real table and column heads, with
 * rows of the same height in which only the values pulse. The rows replace
 * it in place. Wrap it in `DelayedLoadingPlaceholder` so a fast load never
 * flashes it.
 */
export function WorkflowsLibraryTableSkeleton({
  rows = SKELETON_ROWS.length,
  compact = false,
}: WorkflowsLibraryTableSkeletonProps): JSX.Element {
  const shown = SKELETON_ROWS.slice(
    0,
    Math.max(1, Math.min(SKELETON_ROWS.length, Math.floor(rows))),
  );
  return (
    <div
      role="status"
      className="overflow-hidden rounded-lg border"
      data-testid="workflows-library-skeleton"
    >
      <span className="sr-only">Loading workflows</span>
      <table aria-hidden="true" className="w-full table-fixed text-left text-s">
        <WorkflowsLibraryTableHead compact={compact} />
        <tbody>
          {shown.map((row) => (
            <tr key={row.key} className="border-t align-middle">
              <td className="px-4 py-3">
                {/* The name and summary lines' own heights, so the row is
                    as tall as a loaded one. */}
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex h-5 items-center">
                    <SkeletonBlock height="text" width={row.name} />
                  </span>
                  <span className="flex h-4.5 items-center">
                    <SkeletonBlock height="meta" width={row.summary} />
                  </span>
                </div>
              </td>
              <td className="px-3 py-3">
                <span className="flex h-5 items-center">
                  <SkeletonBlock height="text" width={row.trigger} />
                </span>
              </td>
              <td className="px-3 py-3">
                <span className="flex h-5 items-center">
                  <SkeletonBlock height="text" width={row.run} />
                </span>
              </td>
              {compact ? null : (
                <td className="px-3 py-3">
                  <span className="flex h-5 items-center">
                    <SkeletonBlock height="text" width="1/4" />
                  </span>
                </td>
              )}
              <td className="px-3 py-3">
                {/* Where the switch sits; Run and More stay blank. */}
                <span className="flex h-7 items-center justify-end pr-18">
                  <SkeletonBlock shape="toggle" />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface WorkflowsLibraryTableRowProps {
  readonly row: WorkflowLibraryRow;
  readonly now: number;
  readonly locale?: string;
  readonly compact: boolean;
  readonly busy: boolean;
  readonly highlighted: boolean;
  readonly onOpen: (row: WorkflowLibraryRow) => void;
  readonly onAction: (
    row: WorkflowLibraryRow,
    action: WorkflowLibraryAction,
  ) => void;
}

/** One Library row: two-line name cell, trigger, last and next run, row end. */
export function WorkflowsLibraryTableRow({
  row,
  now,
  locale,
  compact,
  busy,
  highlighted,
  onOpen,
  onAction,
}: WorkflowsLibraryTableRowProps): JSX.Element {
  const off = row.enabled === false;
  const leadTrigger = row.triggers[0] ?? 'manual';
  const nextRun =
    row.nextRunAt !== undefined && !off
      ? formatNextRun(row.nextRunAt, now, locale)
      : undefined;
  const canRun = row.actions.includes('run');
  const showRun = canRun || row.runUnavailableLabel !== undefined;
  return (
    <tr
      data-testid="workflows-library-row"
      data-row-key={row.key}
      data-row-kind={row.kind}
      data-highlighted={highlighted ? 'true' : undefined}
      tabIndex={0}
      onClick={(event): void => {
        // Portaled menus bubble through React to the row; only a press on the
        // row's own cells opens it.
        if (
          event.target instanceof Node &&
          event.currentTarget.contains(event.target)
        ) {
          onOpen(row);
        }
      }}
      onKeyDown={(event): void => {
        if (event.key !== 'Enter' || event.target !== event.currentTarget) {
          return;
        }
        event.preventDefault();
        onOpen(row);
      }}
      className={`focus-ring cursor-pointer border-t align-middle transition-colors ${
        highlighted ? 'bg-subtle' : 'hover:bg-subtle'
      }`}
    >
      <td className="px-4 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span
            className={`truncate ${off ? 'fg-tertiary' : 'fg-primary'} ${REPLAY_MASK_CLASS}`}
            data-testid="workflows-library-name"
          >
            {row.name}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs fg-tertiary">
            <WorkflowStepChain trigger={leadTrigger} steps={row.steps} />
            <span className="truncate" data-testid="workflows-library-summary">
              <span className={REPLAY_MASK_CLASS}>{row.summary}</span>
              {row.sourceLabel ? (
                <>
                  {row.summary ? ' · ' : ''}
                  <span
                    className={row.sourceIsPerson ? REPLAY_MASK_CLASS : ''}
                    data-testid="workflows-library-source"
                  >
                    {row.sourceLabel}
                  </span>
                </>
              ) : null}
            </span>
          </span>
          {row.attention ? (
            <span
              className="inline-flex min-w-0 items-center gap-1 text-xs fg-warning"
              data-testid="workflows-library-attention"
            >
              <WarningIcon
                width={12}
                height={12}
                aria-hidden="true"
                className="shrink-0"
              />
              <span className="truncate">{row.attention}</span>
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span
            className="truncate fg-secondary"
            data-testid="workflows-library-trigger"
          >
            {row.triggerText}
          </span>
          {compact && nextRun ? (
            <span className="truncate text-xs tabular-nums fg-tertiary">
              Next: {nextRun}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-3 text-s" data-testid="workflows-library-last-run">
        <WorkflowLastRunText lastRun={row.lastRun} />
      </td>
      {compact ? null : (
        <td
          className="truncate px-3 py-3 tabular-nums fg-secondary"
          data-testid="workflows-library-next-run"
        >
          {nextRun ?? <span className="fg-quaternary">—</span>}
        </td>
      )}
      <td className="px-3 py-3">
        <TableActionsCell testId="workflows-library-actions">
          <span className="flex items-center gap-2">
            {row.installable ? (
              <Button
                variant="secondary"
                size="compact"
                disabled={row.installing === true || busy}
                aria-busy={row.installing === true}
                data-testid="workflows-library-add"
                onClick={(): void => onAction(row, 'add')}
              >
                Add
              </Button>
            ) : (
              <>
                {row.enabled !== undefined && row.actions.includes('toggle') ? (
                  // The accessible name says the state; the tooltip says what
                  // a press does.
                  <Tooltip label={row.enabled ? 'Turn off' : 'Turn on'}>
                    <ToggleSwitch
                      checked={row.enabled}
                      disabled={busy}
                      label={`${row.name} is ${row.enabled ? 'on' : 'off'}`}
                      dataTestId="workflows-library-toggle"
                      onChange={(): void => onAction(row, 'toggle')}
                    />
                  </Tooltip>
                ) : (
                  // Quiet gap where the switch sits, so Run stays aligned.
                  <span className="w-8 shrink-0" aria-hidden="true" />
                )}
                {showRun ? (
                  <TableActionButton
                    label={
                      canRun
                        ? `Run ${row.name}`
                        : (row.runUnavailableLabel ?? `Run ${row.name}`)
                    }
                    disabled={!canRun || busy}
                    testId="workflows-library-run"
                    onClick={(): void => onAction(row, 'run')}
                  >
                    <PlayIcon width={14} height={14} aria-hidden="true" />
                  </TableActionButton>
                ) : null}
              </>
            )}
            <WorkflowsRowMenu
              label={`More actions for ${row.name}`}
              testId="workflows-library-menu"
              items={menuWorkflowLibraryActions(row.actions).map((action) => ({
                id: action,
                label: WORKFLOW_LIBRARY_ACTION_LABELS[action],
                ...LIBRARY_MENU_ROWS[action],
                onSelect: (): void => onAction(row, action),
              }))}
            />
          </span>
        </TableActionsCell>
      </td>
    </tr>
  );
}

export interface WorkflowsLibraryProjectOption {
  readonly id: string;
  readonly name: string;
}

export interface WorkflowsLibraryToolbarProps {
  readonly filters: WorkflowLibraryFilters;
  readonly onFiltersChange: (filters: WorkflowLibraryFilters) => void;
  readonly sort: WorkflowLibrarySort;
  readonly onSortChange: (sort: WorkflowLibrarySort) => void;
  /** Counts from the unfiltered rows of the current context. */
  readonly counts: WorkflowLibraryFacetCounts;
  /** Trigger kinds this host can show. */
  readonly triggers: readonly WorkflowTriggerKind[];
  /** Projects in the current context; "No project" is added here. */
  readonly projects: readonly WorkflowsLibraryProjectOption[];
  /**
   * Leave the Shared count out when the share list failed to load, rather
   * than showing a 0 that reads as "nothing is shared".
   */
  readonly sharedCountUnknown?: boolean;
  /** Rows in the unfiltered set and after filtering, for the result line. */
  readonly total: number;
  readonly matched: number;
}

/**
 * Library search. The Trigger / Status / Project / Source filters with
 * counts sit behind one Filter dropdown after the field (more than fit
 * inline), then the sort; while there is a query the field shows how many
 * workflows match.
 */
export function WorkflowsLibraryToolbar({
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  counts,
  triggers,
  projects,
  sharedCountUnknown = false,
  total,
  matched,
}: WorkflowsLibraryToolbarProps): JSX.Element {
  const pageFilters = [
    pageFilter<WorkflowTriggerKind>({
      key: 'trigger',
      title: 'Trigger',
      groupIcon: <PlayIcon />,
      anyLabel: 'Any trigger',
      multiple: true,
      options: triggers.map((trigger) => ({
        value: trigger,
        label: WORKFLOW_TRIGGER_LABELS[trigger],
        count: counts.triggers[trigger],
        icon: <TriggerGlyph trigger={trigger} />,
      })),
      selected: filters.triggers,
      onToggle: (trigger): void =>
        onFiltersChange({
          ...filters,
          triggers: filters.triggers.includes(trigger)
            ? filters.triggers.filter((value) => value !== trigger)
            : [...filters.triggers, trigger],
        }),
      onClear: (): void => onFiltersChange({ ...filters, triggers: [] }),
      testId: 'workflows-library-filter-trigger',
    }),
    pageFilter<WorkflowLibraryStatusFilter>({
      key: 'status',
      title: 'Status',
      groupIcon: <CircleCheckIcon />,
      anyLabel: 'Any status',
      options: WORKFLOW_LIBRARY_STATUS_FILTERS.map((status) => ({
        value: status,
        label: WORKFLOW_LIBRARY_STATUS_LABELS[status],
        count: counts.statuses[status],
      })),
      selected: filters.status === null ? [] : [filters.status],
      onToggle: (status): void =>
        onFiltersChange({
          ...filters,
          status: filters.status === status ? null : status,
        }),
      onClear: (): void => onFiltersChange({ ...filters, status: null }),
      testId: 'workflows-library-filter-status',
    }),
    pageFilter<string>({
      key: 'project',
      title: 'Project',
      groupIcon: <FolderIcon />,
      anyLabel: 'Any project',
      options: [
        ...projects.map((project) => ({
          value: project.id,
          label: project.name,
          count: counts.projects[project.id] ?? 0,
        })),
        {
          value: WORKFLOW_NO_PROJECT,
          label: 'No project',
          count: counts.projects[WORKFLOW_NO_PROJECT] ?? 0,
        },
      ],
      selected: filters.project === null ? [] : [filters.project],
      onToggle: (project): void =>
        onFiltersChange({
          ...filters,
          project: filters.project === project ? null : project,
        }),
      onClear: (): void => onFiltersChange({ ...filters, project: null }),
      testId: 'workflows-library-filter-project',
    }),
    pageFilter<WorkflowLibrarySource>({
      key: 'source',
      title: 'Source',
      groupIcon: <GlobeIcon />,
      anyLabel: 'Any source',
      options: WORKFLOW_LIBRARY_SOURCES.map((source) => ({
        value: source,
        label: WORKFLOW_LIBRARY_SOURCE_LABELS[source],
        count:
          source === 'shared' && sharedCountUnknown
            ? undefined
            : counts.sources[source],
      })),
      selected: filters.source === null ? [] : [filters.source],
      onToggle: (source): void =>
        onFiltersChange({
          ...filters,
          source: filters.source === source ? null : source,
        }),
      onClear: (): void => onFiltersChange({ ...filters, source: null }),
      testId: 'workflows-library-filter-source',
    }),
  ];
  return (
    <PageSearchRow testId="workflows-library-toolbar">
      <WorkflowsSearchField
        value={filters.query}
        onChange={(next): void => onFiltersChange({ ...filters, query: next })}
        placeholder="Search workflows"
        testId="workflows-library-search"
        count={`${String(matched)} of ${String(total)}`}
      />
      <PageSearchControls>
        <PageSearchFilters
          filters={pageFilters}
          onClearAll={(): void =>
            onFiltersChange({
              ...filters,
              triggers: [],
              status: null,
              project: null,
              source: null,
            })
          }
          testId="workflows-library-filter"
        />
        <SortDropdown<WorkflowLibrarySort>
          value={sort}
          options={WORKFLOW_LIBRARY_SORTS.map((value) => ({
            value,
            label: WORKFLOW_LIBRARY_SORT_LABELS[value],
          }))}
          onChange={onSortChange}
          testId="workflows-library-sort"
        />
      </PageSearchControls>
    </PageSearchRow>
  );
}

export interface WorkflowsLibraryPaginationProps {
  readonly page: WorkflowLibraryPage;
  readonly onPageChange: (page: number) => void;
}

/** `1–25 of 38 workflows` and the page buttons. */
export function WorkflowsLibraryPagination({
  page,
  onPageChange,
}: WorkflowsLibraryPaginationProps): JSX.Element {
  const numbers = Array.from({ length: page.pageCount }, (_, i) => i + 1);
  return (
    <div
      className="flex items-center justify-between gap-4 pt-3 text-xs fg-tertiary"
      data-testid="workflows-library-pagination"
    >
      <span className="tabular-nums" data-testid="workflows-library-range">
        {page.from}–{page.to} of {page.total}{' '}
        {page.total === 1 ? 'workflow' : 'workflows'}
      </span>
      {page.pageCount > 1 ? (
        <nav aria-label="Pages" className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous page"
            disabled={page.page === 1}
            data-testid="workflows-library-page-previous"
            onClick={(): void => onPageChange(page.page - 1)}
            className="focus-ring flex h-7 w-7 items-center justify-center rounded-md fg-secondary hover:bg-subtle disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronLeftMediumIcon width={16} height={16} aria-hidden="true" />
          </button>
          {numbers.map((number) => (
            <button
              key={number}
              type="button"
              aria-current={number === page.page ? 'page' : undefined}
              data-testid={`workflows-library-page-${String(number)}`}
              onClick={(): void => onPageChange(number)}
              className={`focus-ring flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 tabular-nums ${
                number === page.page
                  ? 'bg-secondary fg-primary'
                  : 'fg-secondary hover:bg-subtle'
              }`}
            >
              {number}
            </button>
          ))}
          <button
            type="button"
            aria-label="Next page"
            disabled={page.page === page.pageCount}
            data-testid="workflows-library-page-next"
            onClick={(): void => onPageChange(page.page + 1)}
            className="focus-ring flex h-7 w-7 items-center justify-center rounded-md fg-secondary hover:bg-subtle disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronRightMediumIcon width={16} height={16} aria-hidden="true" />
          </button>
        </nav>
      ) : null}
    </div>
  );
}

export interface WorkflowsLibraryEmptyStateProps {
  readonly filters: WorkflowLibraryFilters;
  readonly onClearFilters: () => void;
  /**
   * The New workflow control for the first-use state; omitted when the host
   * cannot create one. A filtered Library offers Clear filters alone.
   */
  readonly newWorkflow?: ReactNode;
}

/**
 * The Library with nothing to show: `No workflows match …` with the one
 * action that clears it when a search or filter hides every row, otherwise
 * the first-use state.
 */
export function WorkflowsLibraryEmptyState({
  filters,
  onClearFilters,
  newWorkflow,
}: WorkflowsLibraryEmptyStateProps): JSX.Element {
  const filtered = workflowLibraryFiltersActive(filters);
  if (filtered) {
    return (
      <SearchEmptyState
        testId="workflows-library-no-matches"
        title={describeNoLibraryMatches(filters)}
        actionLabel={describeClearLibraryFilters(filters)}
        onAction={onClearFilters}
        actionTestId="workflows-library-empty-clear"
      />
    );
  }
  return (
    <EmptyState
      testId="workflows-library-empty"
      title="No workflows yet"
      subtitle="Workflows you create or add show up here, whether they run on a schedule or when you start them."
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {newWorkflow}
        </div>
      }
    />
  );
}
