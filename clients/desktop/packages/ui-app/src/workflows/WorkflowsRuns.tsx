'use client';

import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';
import {
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  Button,
  TableActionsCell,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  ChatIcon,
  DocumentSearchIcon,
  EyeOffIcon,
  MessageIcon,
  RerunIcon,
  StopIcon,
  WorkflowsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import {
  runSearchHint,
  workflowRunFiltersActive,
  type WorkflowRunFilters,
} from './run-search';
import {
  WORKFLOW_RUN_ACTION_LABELS,
  WORKFLOW_RUN_KIND_LABELS,
  WORKFLOW_RUN_STARTER_LABELS,
  WORKFLOW_RUN_STATUS_LABELS,
  menuWorkflowRunActions,
  primaryWorkflowRunAction,
  workflowRunDurationLabel,
  workflowRunStatusTone,
  type WorkflowRunAction,
  type WorkflowRunKind,
  type WorkflowRunRow,
  type WorkflowRunStarter,
  type WorkflowRunStatus,
} from './workflow-run-model';
import { formatRunStarted } from './workflow-time';
import {
  WorkflowsFilterMenu,
  WorkflowsRowMenu,
  type WorkflowsRowMenuItem,
  WorkflowsSearchField,
} from './workflows-controls';

/** Rows drawn before the footer's Load more reveals the next batch. */
/**
 * Each run menu row's icon and group. Rerun and Retry are one action's two
 * forms, so they share an icon; Hide and Cancel close the menu as removals.
 */
const RUN_MENU_ROWS: Readonly<
  Record<
    WorkflowRunAction,
    Pick<WorkflowsRowMenuItem, 'icon' | 'group' | 'destructive' | 'removal'>
  >
> = {
  inspect: { icon: <DocumentSearchIcon />, group: 'open' },
  'open-library': { icon: <WorkflowsIcon />, group: 'open' },
  rerun: { icon: <RerunIcon />, group: 'run' },
  retry: { icon: <RerunIcon />, group: 'run' },
  respond: { icon: <MessageIcon />, group: 'chat' },
  'go-to-chat': { icon: <ChatIcon />, group: 'chat' },
  hide: { icon: <EyeOffIcon />, removal: true },
  cancel: { icon: <StopIcon />, destructive: true },
};

export const WORKFLOWS_RUNS_RENDER_BATCH = 100;

function statusDotClassName(status: WorkflowRunStatus): string {
  const { tone, muted } = workflowRunStatusTone(status);
  const ink =
    tone === 'warning'
      ? 'bg-fg-warning'
      : tone === 'neutral'
        ? 'bg-fg-secondary'
        : OPERATIONAL_STATUS_COLORS[tone].background;
  return `${ink}${muted ? ' opacity-60' : ''}`;
}

/**
 * The status mark at the head of a run row. The color alone does not say
 * what it means, so the status is named in a tooltip and for readers.
 */
export function WorkflowRunStatusDot({
  status,
}: {
  readonly status: WorkflowRunStatus;
}): JSX.Element {
  const label = WORKFLOW_RUN_STATUS_LABELS[status];
  return (
    <Tooltip label={label}>
      <span
        className="flex h-5 w-4 shrink-0 items-center justify-center"
        data-status={status}
        data-testid="workflows-run-status"
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${statusDotClassName(status)}`}
        />
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}

export interface WorkflowsRunsToolbarProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly filters: WorkflowRunFilters;
  readonly onFiltersChange: (filters: WorkflowRunFilters) => void;
  /** Values offered by each menu; a host lists only what it can show. */
  readonly statuses: readonly WorkflowRunStatus[];
  readonly kinds: readonly WorkflowRunKind[];
  readonly starters: readonly WorkflowRunStarter[];
}

/**
 * Runs search with its Status, Kind and Started by filters, and the message
 * for an unrecognized token.
 */
export function WorkflowsRunsToolbar({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  statuses,
  kinds,
  starters,
}: WorkflowsRunsToolbarProps): JSX.Element {
  const hint = runSearchHint(query);
  return (
    <div className="flex flex-col gap-1.5" data-testid="workflows-runs-toolbar">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <WorkflowsSearchField
          value={query}
          onChange={onQueryChange}
          placeholder="Search runs"
          testId="workflows-runs-search"
          className="w-80 max-w-full"
        />
        <WorkflowsFilterMenu
          title="Status"
          label={
            filters.status === null
              ? 'Any status'
              : WORKFLOW_RUN_STATUS_LABELS[filters.status]
          }
          anyLabel="Any status"
          options={statuses.map((status) => ({
            value: status,
            label: WORKFLOW_RUN_STATUS_LABELS[status],
          }))}
          selected={filters.status === null ? [] : [filters.status]}
          onToggle={(status): void =>
            onFiltersChange({
              ...filters,
              status: filters.status === status ? null : status,
            })
          }
          onClear={(): void => onFiltersChange({ ...filters, status: null })}
          testId="workflows-runs-filter-status"
        />
        {kinds.length > 1 ? (
          <WorkflowsFilterMenu
            title="Kind"
            label={
              filters.kind === null
                ? 'Any kind'
                : WORKFLOW_RUN_KIND_LABELS[filters.kind]
            }
            anyLabel="Any kind"
            options={kinds.map((kind) => ({
              value: kind,
              label: WORKFLOW_RUN_KIND_LABELS[kind],
            }))}
            selected={filters.kind === null ? [] : [filters.kind]}
            onToggle={(kind): void =>
              onFiltersChange({
                ...filters,
                kind: filters.kind === kind ? null : kind,
              })
            }
            onClear={(): void => onFiltersChange({ ...filters, kind: null })}
            testId="workflows-runs-filter-kind"
          />
        ) : null}
        <WorkflowsFilterMenu
          title="Started by"
          label={
            filters.starter === null
              ? 'Started by'
              : WORKFLOW_RUN_STARTER_LABELS[filters.starter]
          }
          anyLabel="Anything"
          options={starters.map((starter) => ({
            value: starter,
            label: WORKFLOW_RUN_STARTER_LABELS[starter],
          }))}
          selected={filters.starter === null ? [] : [filters.starter]}
          onToggle={(starter): void =>
            onFiltersChange({
              ...filters,
              starter: filters.starter === starter ? null : starter,
            })
          }
          onClear={(): void => onFiltersChange({ ...filters, starter: null })}
          testId="workflows-runs-filter-starter"
        />
      </div>
      {hint === null ? null : (
        <p className="text-xs fg-tertiary" data-testid="workflows-runs-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export interface WorkflowsRunsTableProps {
  /** Filtered and sorted by the host; drawn in this order. */
  readonly rows: readonly WorkflowRunRow[];
  /** Epoch milliseconds, so the Started column is stable within a render. */
  readonly now: number;
  readonly locale?: string;
  /** Opens a row's result. Only called for rows whose result is available. */
  readonly onOpen: (row: WorkflowRunRow) => void;
  readonly onAction: (row: WorkflowRunRow, action: WorkflowRunAction) => void;
  /** Rows with an action in flight; their buttons are disabled. */
  readonly busyKeys?: ReadonlySet<string>;
  /**
   * Host action buttons for a row, in place of the default button. The More
   * menu still follows them.
   */
  readonly renderActions?: (row: WorkflowRunRow) => ReactNode;
  /** More runs can be fetched from the host. */
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly onLoadMore?: () => void;
  /** A row to mark as selected, e.g. the run a chat linked to. */
  readonly highlightKey?: string | null;
}

function isRowControlTarget(event: MouseEvent | KeyboardEvent): boolean {
  // Portaled menus bubble through React to the row; only a press on the row's
  // own cells opens it.
  return (
    event.target instanceof Node && event.currentTarget.contains(event.target)
  );
}

/**
 * The Runs feed table (CAN-3981): one row per automation run, pipeline run or
 * watcher. Rows are focusable; Enter or a click opens the result, and a row
 * without a result expands to show the output it recorded.
 */
export function WorkflowsRunsTable({
  rows,
  now,
  locale,
  onOpen,
  onAction,
  busyKeys,
  renderActions,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  highlightKey = null,
}: WorkflowsRunsTableProps): JSX.Element {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [renderLimit, setRenderLimit] = useState(WORKFLOWS_RUNS_RENDER_BATCH);
  // An explicit selection must be rendered before the host can focus it.
  const highlightedIndex =
    highlightKey === null
      ? -1
      : rows.findIndex((row) => row.key === highlightKey);
  const shown = rows.slice(0, Math.max(renderLimit, highlightedIndex + 1));
  const hiddenLoaded = rows.length - shown.length;

  const activate = (row: WorkflowRunRow): void => {
    if (row.result.available) {
      onOpen(row);
      return;
    }
    if (row.output !== undefined) {
      setExpandedKey((current) => (current === row.key ? null : row.key));
    }
  };

  return (
    <div className="flex min-h-0 flex-col" data-testid="workflows-runs-table">
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full table-fixed text-left text-s">
          <thead className="text-xs fg-tertiary">
            <tr>
              <th className="px-4 py-2.5 font-normal">Workflow</th>
              <th className="w-24 px-3 py-2.5 font-normal">Kind</th>
              <th className="hidden w-28 px-3 py-2.5 font-normal lg:table-cell">
                Started by
              </th>
              <th className="hidden w-48 px-3 py-2.5 font-normal xl:table-cell">
                Where
              </th>
              <th className="w-36 px-3 py-2.5 font-normal">Started</th>
              <th className="w-24 px-3 py-2.5 font-normal">Duration</th>
              <th className="w-32 px-3 py-2.5 text-right font-normal">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const interactive =
                row.result.available || row.output !== undefined;
              const expanded = expandedKey === row.key;
              const primary = primaryWorkflowRunAction(row.actions);
              const busy = busyKeys?.has(row.key) === true;
              const detail =
                row.detail ??
                (row.result.available ? undefined : row.result.reason);
              return (
                <tr
                  key={row.key}
                  data-testid="workflows-run-row"
                  data-run-key={row.key}
                  data-run-kind={row.kind}
                  data-run-status={row.status}
                  data-highlighted={
                    highlightKey === row.key ? 'true' : undefined
                  }
                  aria-current={highlightKey === row.key ? 'true' : undefined}
                  tabIndex={
                    interactive ? 0 : highlightKey === row.key ? -1 : undefined
                  }
                  aria-expanded={
                    !row.result.available && row.output !== undefined
                      ? expanded
                      : undefined
                  }
                  onClick={
                    interactive
                      ? (event): void => {
                          if (isRowControlTarget(event)) activate(row);
                        }
                      : undefined
                  }
                  onKeyDown={
                    interactive
                      ? (event): void => {
                          if (event.key !== 'Enter') return;
                          if (event.target !== event.currentTarget) return;
                          event.preventDefault();
                          activate(row);
                        }
                      : undefined
                  }
                  className={`border-t align-top transition-colors ${
                    interactive
                      ? 'focus-ring cursor-pointer hover:bg-subtle'
                      : ''
                  }${highlightKey === row.key ? ' bg-subtle' : ''}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex min-w-0 gap-2">
                      <WorkflowRunStatusDot status={row.status} />
                      <div className="flex min-w-0 flex-col gap-1">
                        <span
                          className={`truncate fg-primary ${REPLAY_MASK_CLASS}`}
                          data-testid="workflows-run-name"
                        >
                          {row.name}
                        </span>
                        {detail ? (
                          <span
                            className={`truncate text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}
                            data-testid="workflows-run-detail"
                          >
                            {detail}
                          </span>
                        ) : null}
                        {expanded && row.output !== undefined ? (
                          <pre
                            className={`mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-subtle p-2 font-mono text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
                            data-testid="workflows-run-output"
                          >
                            {row.output}
                          </pre>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="truncate px-3 py-3 fg-secondary">
                    {WORKFLOW_RUN_KIND_LABELS[row.kind]}
                  </td>
                  <td className="hidden truncate px-3 py-3 fg-secondary lg:table-cell">
                    {row.starter
                      ? WORKFLOW_RUN_STARTER_LABELS[row.starter]
                      : ''}
                  </td>
                  <td
                    className={`hidden truncate px-3 py-3 fg-secondary xl:table-cell ${REPLAY_MASK_CLASS}`}
                  >
                    {row.where ?? ''}
                  </td>
                  <td className="truncate px-3 py-3 tabular-nums fg-secondary">
                    {row.startedAt === undefined
                      ? ''
                      : formatRunStarted(row.startedAt, now, locale)}
                  </td>
                  <td className="truncate px-3 py-3 tabular-nums fg-secondary">
                    {workflowRunDurationLabel(row)}
                  </td>
                  <td className="px-3 py-2">
                    <TableActionsCell testId="workflows-run-actions">
                      {renderActions ? (
                        renderActions(row)
                      ) : primary ? (
                        <Button
                          variant="secondary"
                          size="control"
                          disabled={busy}
                          data-testid={`workflows-run-action-${primary}`}
                          onClick={(): void => onAction(row, primary)}
                        >
                          {WORKFLOW_RUN_ACTION_LABELS[primary]}
                        </Button>
                      ) : null}
                      <WorkflowsRowMenu
                        label={`More actions for ${row.name}`}
                        testId="workflows-run-menu"
                        items={menuWorkflowRunActions(row.actions).map(
                          (action) => ({
                            id: action,
                            label: WORKFLOW_RUN_ACTION_LABELS[action],
                            ...RUN_MENU_ROWS[action],
                            onSelect: (): void => onAction(row, action),
                          }),
                        )}
                      />
                    </TableActionsCell>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hiddenLoaded > 0 || hasMore ? (
        <div className="flex justify-end pt-3">
          <Button
            variant="secondary"
            size="control"
            disabled={loadingMore}
            aria-busy={loadingMore}
            data-testid="workflows-runs-load-more"
            onClick={(): void => {
              // Rows already loaded are revealed first; the host is asked for
              // more only once every loaded row is drawn.
              setRenderLimit(
                (current) =>
                  Math.max(current, highlightedIndex + 1) +
                  WORKFLOWS_RUNS_RENDER_BATCH,
              );
              if (hiddenLoaded === 0) onLoadMore?.();
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface WorkflowsRunsEmptyStateProps {
  /** The search and filters hide every run, rather than there being none. */
  readonly query: string;
  readonly filters: WorkflowRunFilters;
  readonly onClearFilters: () => void;
  /**
   * Starts a run. Pass it when the Library has something to run: it is then
   * the one action offered.
   */
  readonly onRunWorkflow?: () => void;
  /** With nothing to run yet: create a workflow, or find one to add. */
  readonly onNewWorkflow?: () => void;
  readonly onBrowseMarketplace?: () => void;
}

/**
 * Runs with nothing to show: `No runs yet` with one way forward (Run a
 * workflow when there is one to run, otherwise New workflow beside Browse
 * Marketplace), or `No runs match` with Clear filters when a search or filter
 * hides them all.
 */
export function WorkflowsRunsEmptyState({
  query,
  filters,
  onClearFilters,
  onRunWorkflow,
  onNewWorkflow,
  onBrowseMarketplace,
}: WorkflowsRunsEmptyStateProps): JSX.Element {
  if (workflowRunFiltersActive(query, filters)) {
    const trimmed = query.trim();
    return (
      <div
        className="flex flex-col items-center gap-4 px-6 py-16 text-center"
        data-testid="workflows-runs-no-matches"
      >
        <p className="text-s fg-secondary">
          {trimmed === ''
            ? 'No runs match these filters'
            : `No runs match "${trimmed}"`}
        </p>
        <Button
          variant="secondary"
          size="md"
          data-testid="workflows-runs-clear-filters"
          onClick={onClearFilters}
        >
          Clear filters
        </Button>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col items-center gap-2 px-6 py-16 text-center"
      data-testid="workflows-runs-empty"
    >
      <h2 className="text-m font-semibold fg-primary">No runs yet</h2>
      <p className="text-s fg-secondary">
        Workflow runs from your library show up here.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {onRunWorkflow ? (
          <Button
            variant="primary"
            size="md"
            data-testid="workflows-runs-empty-run"
            onClick={onRunWorkflow}
          >
            Run a workflow
          </Button>
        ) : (
          <>
            {onNewWorkflow ? (
              <Button
                variant="primary"
                size="md"
                data-testid="workflows-runs-empty-new"
                onClick={onNewWorkflow}
              >
                New workflow
              </Button>
            ) : null}
            {onBrowseMarketplace ? (
              <Button
                variant="secondary"
                size="md"
                data-testid="workflows-runs-empty-marketplace"
                onClick={onBrowseMarketplace}
              >
                Browse {CUSTOMIZE_LABEL}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
