import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  ExecutionState,
  MaterializedJob,
  JobResult,
} from '@canopy/desktop-shared/types/pipeline';
import {
  getPresentJobStatuses,
  type JobStatus,
  type JobStatusCount,
} from '@/lib/pipelineDetailsView';
import type { PipelineEditDeepLink } from '@/stores/navigationStore';
import { CostIcon } from '@canopy/ui-shared/components/cost';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';
import { getPipelineJobStatusDotClassName } from '../utils';
import { ChevronIcon } from '@canopy/ui-shared/icons';
import { isPipelineDetailsDefinitionSelection } from './pipelineDetailTypes';
import { FilterIcon } from '../../shared/icons/FilterIcon';
import {
  FileIcon as AppCatalogFileIcon,
  BoardIcon as AppCatalogBoardIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/**
 * Nav selection target: `null` is the run "Summary" overview, otherwise a job
 * plus an optional physical matrix variant.
 *
 * `null` (rather than a `'summary'` sentinel) keeps the overview distinct from
 * a job that is literally named/id'd `summary`, so such a job stays reachable
 * instead of colliding with the overview entry.
 *
 * `variantJobId` absent means the logical group row is selected. A variant is
 * never a top-level nav row; it always lives under its logical matrix group.
 */
export interface PipelineDetailsTarget {
  jobId: string;
  variantJobId?: string;
}

export interface PipelineDetailsCostTarget {
  entry: 'cost';
}

/** The pipeline definition the run started with (its recorded snapshot). */
export interface PipelineDetailsDefinitionTarget {
  entry: 'definition';
}

export type PipelineDetailsSelection =
  | PipelineDetailsTarget
  | PipelineDetailsCostTarget
  | PipelineDetailsDefinitionTarget
  | null;

/**
 * Max pixel height of the child list under an expanded parent. A fan-out can
 * materialize a couple hundred children, so the list scrolls rather than
 * growing the nav unboundedly.
 */
const CHILD_LIST_MAX_HEIGHT = 240;

/**
 * The selected row's left accent line: a painted element on the row's
 * leading edge. It is not a `border-l` color, because the unlayered
 * `* { border-color }` base rule overrides every `border-<color>` utility
 * (CAN-2734), which drew the same base-colored line on every row. The row
 * carries `relative` so the line spans its full height.
 */
function SelectionMarker(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-0 w-0.5 line-accent"
      data-testid="pipeline-details-nav-selection-marker"
    />
  );
}

/** Selected and unselected row surfaces, shared by every selectable row. */
const SELECTED_ROW_CLASS = 'bg-fg-primary/[0.04] font-semibold';
const UNSELECTED_ROW_CLASS = 'hover:bg-fg-primary/[0.04]';

function DefinitionIcon(): JSX.Element {
  return (
    <AppCatalogFileIcon
      width="14"
      height="14"
      aria-hidden="true"
      className="shrink-0"
    />
  );
}

function OverviewIcon(): JSX.Element {
  return (
    <AppCatalogBoardIcon
      width="14"
      height="14"
      aria-hidden="true"
      className="shrink-0"
    />
  );
}

export function PipelineDetailsNav({
  id,
  state,
  jobOrder,
  selected,
  costEntry,
  statusFilter,
  onSelect,
  onStatusFilter,
  onOpenDefinition,
}: {
  /** DOM id, so a toggle elsewhere can name this list in `aria-controls`. */
  id?: string;
  state: ExecutionState;
  jobOrder: string[];
  selected: PipelineDetailsSelection;
  /** Present when the owned run has an observed cost breakdown. */
  costEntry?: { amount: string };
  statusFilter: JobStatus | 'all';
  onSelect: (target: PipelineDetailsSelection) => void;
  onStatusFilter: (status: JobStatus | 'all') => void;
  /**
   * Opens the pipeline's current definition in the editor. Never closes the
   * detail.
   */
  onOpenDefinition: (link: PipelineEditDeepLink) => void;
}): JSX.Element {
  const present = getPresentJobStatuses(state);
  // A matrix group stays visible when any variant matches the filter.
  const visibleJobs = jobOrder.filter((id) => {
    if (statusFilter === 'all') return true;
    const group = state.job_groups[id];
    return (
      group?.status === statusFilter ||
      group?.variant_job_ids.some(
        (physicalId) => state.jobs[physicalId]?.status === statusFilter,
      )
    );
  });
  const openDefinition = (): void => {
    onOpenDefinition({ pipelineId: state.pipeline_id, cwd: state.cwd });
  };
  const costSelected =
    selected !== null && 'entry' in selected && selected.entry === 'cost';
  const definitionSelected = isPipelineDetailsDefinitionSelection(selected);

  // Every row is full-bleed inside this scrolling list, which would cut off
  // a ring drawn outside it, so rows draw the shared focus ring inside their
  // edges (`focus-ring focus-ring-inset`).
  return (
    <nav
      id={id}
      aria-label="Jobs"
      className="flex w-64 shrink-0 flex-col overflow-y-auto border-r bg-card"
      data-testid="pipeline-details-nav"
    >
      <button
        type="button"
        className={`focus-ring focus-ring-inset relative flex items-center gap-2 py-2 pl-4 pr-3.5 text-left transition-colors ${
          selected === null ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
        }`}
        aria-current={selected === null ? 'true' : undefined}
        onClick={(): void => onSelect(null)}
        data-testid="pipeline-details-nav-summary"
      >
        <OverviewIcon />
        Summary
        {selected === null && <SelectionMarker />}
      </button>

      {costEntry !== undefined ? (
        <button
          type="button"
          className={`focus-ring focus-ring-inset relative flex items-center gap-2 py-2 pl-4 pr-3.5 text-left transition-colors ${
            costSelected ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
          }`}
          aria-current={costSelected ? 'true' : undefined}
          onClick={(): void => onSelect({ entry: 'cost' })}
          data-testid="pipeline-job-list-cost"
        >
          <CostIcon width={14} height={14} className="shrink-0" />
          <span className="min-w-0 flex-1">Cost</span>
          <span className="shrink-0 tabular-nums text-2xs fg-secondary">
            {costEntry.amount}
          </span>
          {costSelected && <SelectionMarker />}
        </button>
      ) : null}

      <button
        type="button"
        className={`focus-ring focus-ring-inset relative flex items-center gap-2 py-2 pl-4 pr-3.5 text-left transition-colors ${
          definitionSelected ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
        }`}
        aria-current={definitionSelected ? 'true' : undefined}
        onClick={(): void => onSelect({ entry: 'definition' })}
        data-testid="pipeline-job-list-definition"
      >
        <DefinitionIcon />
        Definition used
        {definitionSelected && <SelectionMarker />}
      </button>

      <div className="flex items-center justify-between px-3.5 pb-1 pt-3 text-2xs fg-secondary">
        <span>All jobs · {visibleJobs.length}</span>
        <PipelineStatusFilter
          present={present}
          value={statusFilter}
          total={jobOrder.length}
          onChange={onStatusFilter}
        />
      </div>

      <div className="flex-1">
        {visibleJobs.map((jobId) => (
          <PipelineNavJob
            key={jobId}
            jobId={jobId}
            state={state}
            selected={selected}
            statusFilter={statusFilter}
            onSelect={onSelect}
          />
        ))}
      </div>

      <div className="border-t">
        <button
          type="button"
          onClick={openDefinition}
          className="focus-ring focus-ring-inset flex w-full items-center gap-2 px-3.5 py-2 text-left text-s fg-accent transition-colors hover:bg-fg-primary/[0.04] hover:underline"
          data-testid="pipeline-details-open-definition"
        >
          Open current definition ↗
        </button>
      </div>
    </nav>
  );
}

function PipelineNavJob({
  jobId,
  state,
  selected,
  statusFilter,
  onSelect,
}: {
  jobId: string;
  state: ExecutionState;
  selected: PipelineDetailsSelection;
  statusFilter: JobStatus | 'all';
  onSelect: (target: PipelineDetailsSelection) => void;
}): JSX.Element {
  const group = state.job_groups[jobId];
  const jobDef = state.pipeline_snapshot.jobs[jobId];
  const isMatrix = group?.kind === 'matrix';
  const children = (group?.variant_job_ids ?? []).map((physicalJobId) => ({
    id: physicalJobId,
    definition: state.job_definitions[physicalJobId],
    result: state.jobs[physicalJobId],
  }));
  const name = jobDef?.name ?? jobId;
  const selectedJob =
    selected !== null && 'jobId' in selected ? selected : null;
  const selectedInJob = selectedJob?.jobId === jobId;
  const parentActive = selectedInJob && selectedJob?.variantJobId === undefined;

  // A filtered nav reveals the matching children rather than hiding them, so
  // failed work under a `continue_on_error` parent stays reachable.
  const filteredChildren = useMemo(
    () =>
      statusFilter === 'all'
        ? children
        : children.filter((child) => child.result?.status === statusFilter),
    [children, statusFilter],
  );
  const filterRevealsChildren =
    statusFilter !== 'all' &&
    group?.status !== statusFilter &&
    filteredChildren.length > 0;

  const [userExpanded, setUserExpanded] = useState(false);
  const expanded =
    isMatrix &&
    (userExpanded ||
      filterRevealsChildren ||
      (selectedInJob && selectedJob?.variantJobId !== undefined));

  return (
    <div>
      <div
        className={`relative flex w-full items-center transition-colors ${
          parentActive ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
        }`}
      >
        {isMatrix && (
          <button
            type="button"
            onClick={(): void => setUserExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse variants' : 'Expand variants'}
            data-testid={`pipeline-details-nav-job-toggle-${jobId}`}
            className="focus-ring focus-ring-inset shrink-0 rounded p-1 pl-3 fg-secondary transition-colors hover:fg-primary"
          >
            <ChevronIcon open={expanded} />
          </button>
        )}
        <button
          type="button"
          onClick={(): void => onSelect({ jobId })}
          className={`focus-ring focus-ring-inset flex min-w-0 flex-1 items-center gap-2 py-2 pr-2.5 text-left ${
            isMatrix ? 'pl-1.5' : 'pl-4'
          }`}
          aria-current={parentActive ? 'true' : undefined}
          data-testid={`pipeline-details-nav-job-${jobId}`}
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${getPipelineJobStatusDotClassName(
              group?.status ?? 'pending',
            )}`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-s">{name}</span>
          {isMatrix && (
            <span
              className="shrink-0 rounded-full bg-fg-primary/[0.06] px-1.5 py-0.5 text-3xs font-medium fg-secondary"
              data-testid={`pipeline-details-nav-job-child-count-${jobId}`}
            >
              {children.length} variants
            </span>
          )}
        </button>
        {parentActive && <SelectionMarker />}
      </div>
      {expanded && (
        // A neutral rail: the base `* { border-color }` rule paints
        // `--line-base` on any `border-<color>` (CAN-2734), so the rail
        // names no color utility of its own.
        <ul
          className="overflow-y-auto border-l pl-1"
          style={{ maxHeight: CHILD_LIST_MAX_HEIGHT }}
          data-testid={`pipeline-details-nav-children-${jobId}`}
        >
          {filteredChildren.map((child) => (
            <li key={child.id}>
              <PipelineNavMatrixVariant
                jobId={jobId}
                child={child}
                active={selectedInJob && selectedJob?.variantJobId === child.id}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One matrix variant row. Renders purely from summary fields rather than
 * `steps`, so a large matrix stays cheap to list.
 */
function PipelineNavMatrixVariant({
  jobId,
  child,
  active,
  onSelect,
}: {
  jobId: string;
  child: {
    id: string;
    definition: MaterializedJob;
    result: JobResult;
  };
  active: boolean;
  onSelect: (target: PipelineDetailsSelection) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={(): void => onSelect({ jobId, variantJobId: child.id })}
      className={`focus-ring focus-ring-inset relative flex w-full items-center gap-2 py-1.5 pl-3.5 pr-2.5 text-left transition-colors ${
        active ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
      }`}
      aria-current={active ? 'true' : undefined}
      data-testid={`pipeline-details-nav-child-${jobId}-${child.id}`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${getPipelineJobStatusDotClassName(
          child.result?.status ?? 'pending',
        )}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs">
          {child.definition?.name ?? child.id}
        </span>
        <span className="block truncate text-3xs fg-secondary">
          {JSON.stringify(child.definition?.matrix?.values ?? {})}
        </span>
      </span>
      {active && <SelectionMarker />}
    </button>
  );
}

function isDomNode(value: EventTarget | null): value is Node {
  return value !== null && 'nodeType' in value;
}

function PipelineStatusFilter({
  present,
  value,
  total,
  onChange,
}: {
  present: JobStatusCount[];
  value: JobStatus | 'all';
  total: number;
  onChange: (status: JobStatus | 'all') => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const active = value !== 'all';

  // A press anywhere outside the filter closes the menu, in whichever window
  // document the list is shown.
  useEffect(() => {
    if (!open) return undefined;
    const ownerDocument = rootRef.current?.ownerDocument;
    if (ownerDocument === undefined) return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (isDomNode(target) && rootRef.current?.contains(target) === true) {
        return;
      }
      setOpen(false);
    };
    ownerDocument.addEventListener('pointerdown', handlePointerDown, true);
    return (): void => {
      ownerDocument.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event): void => {
        // Escape closes the menu first and keeps focus on its button; an
        // enclosing preview or dialog sees the key as handled.
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={(): void => setOpen((v) => !v)}
        className={`focus-ring inline-flex items-center justify-center rounded-md border p-1.25 transition-colors ${
          active
            ? 'bg-warning-subtle fg-warning'
            : 'fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary'
        }`}
        data-testid="pipeline-details-filter-button"
        data-active={active ? 'true' : 'false'}
        aria-label="Filter by status"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <FilterIcon active={active} />
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-1 w-56 rounded-lg bg-popover p-1.5 shadow-lg"
          data-testid="pipeline-details-filter-popover"
        >
          <button
            type="button"
            className="focus-ring flex w-full items-center justify-between rounded px-2 py-1.5 hover:bg-fg-primary/[0.05]"
            onClick={(): void => {
              onChange('all');
              setOpen(false);
            }}
          >
            <span>All</span>
            <span className="fg-secondary">{total}</span>
          </button>
          {present.map(({ status, count }) => (
            <button
              key={status}
              type="button"
              className="focus-ring flex w-full items-center justify-between rounded px-2 py-1.5 hover:bg-fg-primary/[0.05]"
              onClick={(): void => {
                onChange(status);
                setOpen(false);
              }}
            >
              <span>{capitalizeFirstLetter(status)}</span>
              <span className="fg-secondary">{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
