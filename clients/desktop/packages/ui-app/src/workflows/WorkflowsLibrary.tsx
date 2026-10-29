'use client';

import type { ComponentType, JSX, ReactNode, SVGProps } from 'react';
import {
  Button,
  TableActionButton,
  TableActionsCell,
  ToggleSwitch,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  AppAdvisorIcon,
  ChatIcon,
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
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
import { formatRelativeTime } from '@canopy/ui-shared/lib';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  WORKFLOW_LAST_RUN_LABELS,
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
  describeNoLibraryMatches,
  describeTriggerFilter,
  menuWorkflowLibraryActions,
  truncateStepChain,
  workflowLibraryFiltersActive,
  type WorkflowLastRunState,
  type WorkflowLibraryAction,
  type WorkflowLibraryFacetCounts,
  type WorkflowLibraryFilters,
  type WorkflowLibraryPage,
  type WorkflowLibraryRow,
  type WorkflowLibrarySort,
  type WorkflowLibrarySource,
  type WorkflowStepGlyph,
  type WorkflowTriggerKind,
} from './workflow-library-model';
import { formatNextRun } from './workflow-time';
import {
  WorkflowsFilterMenu,
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

const LAST_RUN_DOTS: Readonly<Record<WorkflowLastRunState, string>> = {
  success: 'bg-fg-success-strong',
  failure: 'bg-fg-destructive-strong',
  running: 'bg-fg-info',
  skipped: 'bg-fg-secondary',
  canceled: 'bg-fg-secondary',
};

function LastRunText({
  lastRun,
}: {
  readonly lastRun: WorkflowLibraryRow['lastRun'];
}): JSX.Element {
  if (lastRun === undefined) {
    return <span className="fg-tertiary">Not run yet</span>;
  }
  const at =
    lastRun.state === 'running'
      ? 'Now'
      : lastRun.at === undefined
        ? undefined
        : formatRelativeTime(lastRun.at);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${LAST_RUN_DOTS[lastRun.state]}`}
      />
      <span className="truncate">
        <span className="fg-primary">
          {WORKFLOW_LAST_RUN_LABELS[lastRun.state]}
        </span>
        {at ? <span className="fg-tertiary"> · {at}</span> : null}
      </span>
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
        <thead className="text-xs fg-tertiary">
          <tr>
            <th className="px-4 py-2.5 font-normal">Workflow</th>
            <th
              className={`${compact ? 'w-44' : 'w-52'} px-3 py-2.5 font-normal`}
            >
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
        <LastRunText lastRun={row.lastRun} />
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
                size="control"
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
 * Library search, the Trigger / Status / Project / Source capsule filters
 * with counts, the sort, and the result line shown while a filter is active.
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
  const active = workflowLibraryFiltersActive(filters);
  const projectName =
    filters.project === null
      ? 'Any project'
      : filters.project === WORKFLOW_NO_PROJECT
        ? 'No project'
        : (projects.find((project) => project.id === filters.project)?.name ??
          'Any project');
  const query = filters.query.trim();
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="workflows-library-toolbar"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <WorkflowsSearchField
          value={filters.query}
          onChange={(next): void =>
            onFiltersChange({ ...filters, query: next })
          }
          placeholder="Search workflows"
          testId="workflows-library-search"
        />
        <WorkflowsFilterMenu
          title="Trigger"
          label={describeTriggerFilter(filters.triggers)}
          anyLabel="Any trigger"
          multiple
          options={triggers.map((trigger) => ({
            value: trigger,
            label: WORKFLOW_TRIGGER_LABELS[trigger],
            count: counts.triggers[trigger],
            icon: <TriggerGlyph trigger={trigger} />,
          }))}
          selected={filters.triggers}
          onToggle={(trigger): void =>
            onFiltersChange({
              ...filters,
              triggers: filters.triggers.includes(trigger)
                ? filters.triggers.filter((value) => value !== trigger)
                : [...filters.triggers, trigger],
            })
          }
          onClear={(): void => onFiltersChange({ ...filters, triggers: [] })}
          testId="workflows-library-filter-trigger"
        />
        <WorkflowsFilterMenu
          title="Status"
          label={
            filters.status === null
              ? 'Any status'
              : WORKFLOW_LIBRARY_STATUS_LABELS[filters.status]
          }
          anyLabel="Any status"
          options={WORKFLOW_LIBRARY_STATUS_FILTERS.map((status) => ({
            value: status,
            label: WORKFLOW_LIBRARY_STATUS_LABELS[status],
            count: counts.statuses[status],
          }))}
          selected={filters.status === null ? [] : [filters.status]}
          onToggle={(status): void =>
            onFiltersChange({
              ...filters,
              status: filters.status === status ? null : status,
            })
          }
          onClear={(): void => onFiltersChange({ ...filters, status: null })}
          testId="workflows-library-filter-status"
        />
        <WorkflowsFilterMenu
          title="Project"
          label={projectName}
          anyLabel="Any project"
          options={[
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
          ]}
          selected={filters.project === null ? [] : [filters.project]}
          onToggle={(project): void =>
            onFiltersChange({
              ...filters,
              project: filters.project === project ? null : project,
            })
          }
          onClear={(): void => onFiltersChange({ ...filters, project: null })}
          testId="workflows-library-filter-project"
        />
        <WorkflowsFilterMenu<WorkflowLibrarySource>
          title="Source"
          label={
            filters.source === null
              ? 'Any source'
              : WORKFLOW_LIBRARY_SOURCE_LABELS[filters.source]
          }
          anyLabel="Any source"
          options={WORKFLOW_LIBRARY_SOURCES.map((source) => ({
            value: source,
            label: WORKFLOW_LIBRARY_SOURCE_LABELS[source],
            count:
              source === 'shared' && sharedCountUnknown
                ? undefined
                : counts.sources[source],
          }))}
          selected={filters.source === null ? [] : [filters.source]}
          onToggle={(source): void =>
            onFiltersChange({
              ...filters,
              source: filters.source === source ? null : source,
            })
          }
          onClear={(): void => onFiltersChange({ ...filters, source: null })}
          testId="workflows-library-filter-source"
        />
        <span className="ml-auto flex shrink-0">
          <WorkflowsFilterMenu<WorkflowLibrarySort>
            title="Sort"
            label={WORKFLOW_LIBRARY_SORT_LABELS[sort]}
            anyLabel={WORKFLOW_LIBRARY_SORT_LABELS['recently-run']}
            options={WORKFLOW_LIBRARY_SORTS.filter(
              (value) => value !== 'recently-run',
            ).map((value) => ({
              value,
              label: WORKFLOW_LIBRARY_SORT_LABELS[value],
            }))}
            selected={sort === 'recently-run' ? [] : [sort]}
            onToggle={onSortChange}
            onClear={(): void => onSortChange('recently-run')}
            testId="workflows-library-sort"
          />
        </span>
      </div>
      {active ? (
        <p
          className="flex flex-wrap items-center gap-2 text-xs fg-tertiary"
          data-testid="workflows-library-result-line"
        >
          <span className="tabular-nums">
            {matched} of {total} workflows match
            {query === '' ? '' : ` "${query}"`}
          </span>
          <button
            type="button"
            className="focus-ring rounded-sm fg-secondary underline-offset-2 hover:fg-primary hover:underline"
            data-testid="workflows-library-clear-filters"
            onClick={(): void =>
              onFiltersChange({
                query: '',
                triggers: [],
                status: null,
                project: null,
                source: null,
              })
            }
          >
            Clear filters
          </button>
        </p>
      ) : null}
    </div>
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
 * The Library with nothing to show: `No workflows match …` with Clear filters
 * when a filter hides every row, otherwise the first-use state.
 */
export function WorkflowsLibraryEmptyState({
  filters,
  onClearFilters,
  newWorkflow,
}: WorkflowsLibraryEmptyStateProps): JSX.Element {
  const filtered = workflowLibraryFiltersActive(filters);
  return (
    <div
      className="flex flex-col items-center gap-2 px-6 py-16 text-center"
      data-testid={
        filtered ? 'workflows-library-no-matches' : 'workflows-library-empty'
      }
    >
      {filtered ? (
        <p className="text-s fg-secondary">
          {describeNoLibraryMatches(filters)}
        </p>
      ) : (
        <>
          <h2 className="text-m font-semibold fg-primary">No workflows yet</h2>
          <p className="text-s fg-secondary">
            Pipelines and scheduled workflows you create or add show up here.
          </p>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {filtered ? (
          <Button
            variant="secondary"
            size="md"
            data-testid="workflows-library-empty-clear"
            onClick={onClearFilters}
          >
            Clear filters
          </Button>
        ) : (
          newWorkflow
        )}
      </div>
    </div>
  );
}
