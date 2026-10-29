import type { CanopyCapabilities } from '@canopy/app-core';
import { isFeatureSurfaceAvailable } from '@canopy/app-core/gating';

/**
 * The Workflows Library's row model (CAN-3981): every automation is a row and
 * every pipeline is a row, joined by the Trigger column. Rows are a view over
 * each host's existing models; nothing here is persisted.
 */
export type WorkflowLibraryKind = 'automation' | 'pipeline';

/**
 * What starts a workflow. An automation has one (`schedule` or `once`); a
 * pipeline has one or more of the event triggers.
 */
export type WorkflowTriggerKind =
  | 'schedule'
  | 'once'
  | 'manual'
  | 'plan-approved'
  | 'task-ready';

export const WORKFLOW_TRIGGER_KINDS: readonly WorkflowTriggerKind[] = [
  'schedule',
  'once',
  'manual',
  'plan-approved',
  'task-ready',
];

export const WORKFLOW_TRIGGER_LABELS: Readonly<
  Record<WorkflowTriggerKind, string>
> = {
  schedule: 'Schedule',
  once: 'One time',
  manual: 'Manual',
  'plan-approved': 'Plan approved',
  'task-ready': 'Task ready',
};

/** A step glyph in the name cell's chain. */
export type WorkflowStepGlyph =
  | 'gate'
  | 'advisor'
  | 'chat'
  | 'message'
  | 'agent'
  | 'script'
  | 'input'
  | 'pipeline'
  | 'step';

export const WORKFLOW_STEP_LABELS: Readonly<Record<WorkflowStepGlyph, string>> =
  {
    gate: 'Only if',
    advisor: 'Ask Advisor',
    chat: 'Start chat',
    message: 'Send message',
    agent: 'Ask an agent',
    script: 'Run script',
    input: 'Ask for input',
    pipeline: 'Run a pipeline',
    step: 'Step',
  };

export type WorkflowLibrarySource = 'mine' | 'project' | 'built-in' | 'shared';

export const WORKFLOW_LIBRARY_SOURCES: readonly WorkflowLibrarySource[] = [
  'mine',
  'project',
  'built-in',
  'shared',
];

export const WORKFLOW_LIBRARY_SOURCE_LABELS: Readonly<
  Record<WorkflowLibrarySource, string>
> = {
  mine: 'Yours',
  project: 'From project',
  'built-in': 'Built-in',
  shared: 'Shared',
};

export type WorkflowLastRunState =
  | 'success'
  | 'failure'
  | 'running'
  | 'skipped'
  | 'canceled';

export const WORKFLOW_LAST_RUN_LABELS: Readonly<
  Record<WorkflowLastRunState, string>
> = {
  success: 'Succeeded',
  failure: 'Failed',
  running: 'Running',
  skipped: 'Skipped',
  canceled: 'Canceled',
};

/**
 * Row actions. `run` is the row's Run button, `toggle` its switch and `add`
 * the install button of a shared item not yet added; the rest are the More
 * menu. A host lists only what applies and what it can perform.
 */
export type WorkflowLibraryAction =
  | 'toggle'
  | 'run'
  | 'add'
  | 'edit'
  | 'view-runs'
  | 'duplicate'
  | 'share'
  | 'copy-link'
  | 'delete';

export const WORKFLOW_LIBRARY_ACTION_LABELS: Readonly<
  Record<WorkflowLibraryAction, string>
> = {
  toggle: 'Turn on or off',
  run: 'Run',
  add: 'Add',
  edit: 'Edit',
  'view-runs': 'View runs',
  duplicate: 'Duplicate',
  share: 'Share…',
  'copy-link': 'Copy share link',
  delete: 'Delete',
};

const LIBRARY_MENU_ORDER: readonly WorkflowLibraryAction[] = [
  'edit',
  'view-runs',
  'duplicate',
  'share',
  'copy-link',
  'delete',
];

/** Project filter value for rows that belong to no project. */
export const WORKFLOW_NO_PROJECT = '__none__';

export interface WorkflowLibraryRow {
  /** Stable and unique in the table: kind plus the backing locator. */
  readonly key: string;
  readonly kind: WorkflowLibraryKind;
  readonly name: string;
  /** At least one. The first is the chain's leading glyph. */
  readonly triggers: readonly WorkflowTriggerKind[];
  /** Plain language: `Weekdays at 9:00 AM`, `When a plan is approved`. */
  readonly triggerText: string;
  /** The chain after the trigger; a gate comes first when there is one. */
  readonly steps: readonly WorkflowStepGlyph[];
  /** Destination or step count: `Start chat in storefront`, `6 steps`. */
  readonly summary: string;
  /** Text the search also matches but the row does not show. */
  readonly searchText?: string;
  readonly source: WorkflowLibrarySource;
  /** Source suffix: `Built-in`, `From project`, `Shared by Acme`. */
  readonly sourceLabel?: string;
  /** The suffix names a person, so session replay masks it. */
  readonly sourceIsPerson?: boolean;
  /** Third line in warning ink: `Failed the last 3 runs`. */
  readonly attention?: string;
  readonly lastRun?: {
    readonly state: WorkflowLastRunState;
    /** Epoch milliseconds. */
    readonly at?: number;
  };
  /** Epoch milliseconds; absent for pipelines and anything switched off. */
  readonly nextRunAt?: number;
  /** Epoch milliseconds of the last edit, when the host knows it. */
  readonly changedAt?: number;
  /** `undefined` when the item has no on/off state (no switch is drawn). */
  readonly enabled?: boolean;
  readonly projectId?: string;
  readonly projectName?: string;
  /** A shared item not yet added: Add replaces the switch and Run. */
  readonly installable?: boolean;
  /** The install is in flight, so Add is disabled. */
  readonly installing?: boolean;
  readonly actions: readonly WorkflowLibraryAction[];
  /** Why Run is disabled, as its accessible name. */
  readonly runUnavailableLabel?: string;
}

export type WorkflowLibraryStatusFilter =
  | 'on'
  | 'off'
  | 'attention'
  | 'running';

export const WORKFLOW_LIBRARY_STATUS_FILTERS: readonly WorkflowLibraryStatusFilter[] =
  ['on', 'off', 'attention', 'running'];

export const WORKFLOW_LIBRARY_STATUS_LABELS: Readonly<
  Record<WorkflowLibraryStatusFilter, string>
> = {
  on: 'On',
  off: 'Off',
  attention: 'Needs attention',
  running: 'Running',
};

export interface WorkflowLibraryFilters {
  readonly query: string;
  /** Empty is any trigger; several narrow to rows with any of them. */
  readonly triggers: readonly WorkflowTriggerKind[];
  readonly status: WorkflowLibraryStatusFilter | null;
  /** A project id, {@link WORKFLOW_NO_PROJECT}, or `null` for any. */
  readonly project: string | null;
  readonly source: WorkflowLibrarySource | null;
}

export const EMPTY_WORKFLOW_LIBRARY_FILTERS: WorkflowLibraryFilters = {
  query: '',
  triggers: [],
  status: null,
  project: null,
  source: null,
};

export function workflowLibraryFiltersActive(
  filters: WorkflowLibraryFilters,
): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.triggers.length > 0 ||
    filters.status !== null ||
    filters.project !== null ||
    filters.source !== null
  );
}

export type WorkflowLibrarySort =
  | 'recently-run'
  | 'next-run'
  | 'name'
  | 'recently-changed';

export const WORKFLOW_LIBRARY_SORTS: readonly WorkflowLibrarySort[] = [
  'recently-run',
  'next-run',
  'name',
  'recently-changed',
];

export const WORKFLOW_LIBRARY_SORT_LABELS: Readonly<
  Record<WorkflowLibrarySort, string>
> = {
  'recently-run': 'Recently run',
  'next-run': 'Next run',
  name: 'Name',
  'recently-changed': 'Recently changed',
};

export const WORKFLOW_LIBRARY_PAGE_SIZE = 25;

function matchesStatus(
  row: WorkflowLibraryRow,
  status: WorkflowLibraryStatusFilter,
): boolean {
  switch (status) {
    case 'on':
      return row.enabled === true;
    case 'off':
      return row.enabled === false;
    case 'attention':
      return row.attention !== undefined;
    case 'running':
      return row.lastRun?.state === 'running';
  }
}

function matchesProject(row: WorkflowLibraryRow, project: string): boolean {
  if (project === WORKFLOW_NO_PROJECT) return row.projectId === undefined;
  return row.projectId === project;
}

function matchesQuery(row: WorkflowLibraryRow, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/);
  const text = [
    row.name,
    row.triggerText,
    row.summary,
    row.searchText ?? '',
    row.sourceLabel ?? '',
    row.projectName ?? '',
  ]
    .join('\n')
    .toLowerCase();
  return terms.every((term) => text.includes(term));
}

/** Applies every filter, keeping row order. */
export function filterLibraryRows(
  rows: readonly WorkflowLibraryRow[],
  filters: WorkflowLibraryFilters,
): readonly WorkflowLibraryRow[] {
  return rows.filter((row) => {
    if (
      filters.triggers.length > 0 &&
      !row.triggers.some((trigger) => filters.triggers.includes(trigger))
    ) {
      return false;
    }
    if (filters.status !== null && !matchesStatus(row, filters.status)) {
      return false;
    }
    if (filters.project !== null && !matchesProject(row, filters.project)) {
      return false;
    }
    if (filters.source !== null && row.source !== filters.source) return false;
    return filters.query.trim() === '' || matchesQuery(row, filters.query);
  });
}

export interface WorkflowLibraryFacetCounts {
  readonly triggers: Readonly<Record<WorkflowTriggerKind, number>>;
  readonly statuses: Readonly<Record<WorkflowLibraryStatusFilter, number>>;
  readonly sources: Readonly<Record<WorkflowLibrarySource, number>>;
  /** Keyed by project id, plus {@link WORKFLOW_NO_PROJECT}. */
  readonly projects: Readonly<Record<string, number>>;
}

/**
 * Counts for the filter menus, from the unfiltered rows of the current
 * context. A pipeline with several triggers counts once under each.
 */
export function countLibraryFacets(
  rows: readonly WorkflowLibraryRow[],
): WorkflowLibraryFacetCounts {
  const triggers: Record<WorkflowTriggerKind, number> = {
    schedule: 0,
    once: 0,
    manual: 0,
    'plan-approved': 0,
    'task-ready': 0,
  };
  const statuses: Record<WorkflowLibraryStatusFilter, number> = {
    on: 0,
    off: 0,
    attention: 0,
    running: 0,
  };
  const sources: Record<WorkflowLibrarySource, number> = {
    mine: 0,
    project: 0,
    'built-in': 0,
    shared: 0,
  };
  const projects: Record<string, number> = {};
  for (const row of rows) {
    for (const trigger of new Set(row.triggers)) triggers[trigger] += 1;
    for (const status of WORKFLOW_LIBRARY_STATUS_FILTERS) {
      if (matchesStatus(row, status)) statuses[status] += 1;
    }
    sources[row.source] += 1;
    const project = row.projectId ?? WORKFLOW_NO_PROJECT;
    projects[project] = (projects[project] ?? 0) + 1;
  }
  return { triggers, statuses, sources, projects };
}

function compareNames(a: WorkflowLibraryRow, b: WorkflowLibraryRow): number {
  const byName = a.name.localeCompare(b.name);
  return byName !== 0 ? byName : a.key.localeCompare(b.key);
}

/** Descending by `value`; rows without one last, then by name. */
function compareNewestFirst(
  a: WorkflowLibraryRow,
  b: WorkflowLibraryRow,
  value: (row: WorkflowLibraryRow) => number | undefined,
): number {
  const valueA = value(a);
  const valueB = value(b);
  if (valueA === undefined && valueB === undefined) return compareNames(a, b);
  if (valueA === undefined) return 1;
  if (valueB === undefined) return -1;
  return valueA !== valueB ? valueB - valueA : compareNames(a, b);
}

/**
 * - `recently-run`: newest last run first; never-run rows last, then by name.
 * - `next-run`: soonest first; rows without a next run last.
 * - `name`: locale compare.
 * - `recently-changed`: newest edit first; rows with no timestamp last.
 */
export function sortLibraryRows(
  rows: readonly WorkflowLibraryRow[],
  sort: WorkflowLibrarySort,
): readonly WorkflowLibraryRow[] {
  const sorted = [...rows];
  switch (sort) {
    case 'recently-run':
      // A row that is running now has no end time yet; it sorts first.
      return sorted.sort((a, b) =>
        compareNewestFirst(a, b, (row) =>
          row.lastRun === undefined
            ? undefined
            : (row.lastRun.at ?? Number.POSITIVE_INFINITY),
        ),
      );
    case 'next-run':
      return sorted.sort((a, b) => {
        if (a.nextRunAt === undefined && b.nextRunAt === undefined) {
          return compareNames(a, b);
        }
        if (a.nextRunAt === undefined) return 1;
        if (b.nextRunAt === undefined) return -1;
        return a.nextRunAt !== b.nextRunAt
          ? a.nextRunAt - b.nextRunAt
          : compareNames(a, b);
      });
    case 'name':
      return sorted.sort(compareNames);
    case 'recently-changed':
      return sorted.sort((a, b) =>
        compareNewestFirst(a, b, (row) => row.changedAt),
      );
  }
}

export interface WorkflowLibraryPage {
  readonly rows: readonly WorkflowLibraryRow[];
  /** 1-based, clamped into range. */
  readonly page: number;
  readonly pageCount: number;
  /** 1-based index of the first row shown; 0 when there are none. */
  readonly from: number;
  readonly to: number;
  readonly total: number;
}

/** One page of rows. A page past the end clamps to the last page. */
export function pageLibraryRows(
  rows: readonly WorkflowLibraryRow[],
  page: number,
  pageSize: number = WORKFLOW_LIBRARY_PAGE_SIZE,
): WorkflowLibraryPage {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * pageSize;
  const shown = rows.slice(start, start + pageSize);
  return {
    rows: shown,
    page: current,
    pageCount,
    from: total === 0 ? 0 : start + 1,
    to: start + shown.length,
    total,
  };
}

/** The first steps of a chain and how many it leaves out. */
export function truncateStepChain(
  steps: readonly WorkflowStepGlyph[],
  limit = 3,
): { readonly shown: readonly WorkflowStepGlyph[]; readonly more: number } {
  const shown = steps.slice(0, limit);
  return { shown, more: steps.length - shown.length };
}

const PIPELINE_TRIGGER_PHRASES: Readonly<
  Record<'plan-approved' | 'task-ready', string>
> = {
  'plan-approved': 'a plan is approved',
  'task-ready': 'a task is ready',
};

/**
 * A pipeline's Trigger text from its events: `Manual`, `When a plan is
 * approved`, `When a plan is approved or a task is ready`, and `Manual, or
 * when a plan is approved` when it can also be started by hand. No events
 * reads as `Manual`.
 */
export function describePipelineTriggers(
  triggers: readonly WorkflowTriggerKind[],
): string {
  const events: string[] = [];
  if (triggers.includes('plan-approved')) {
    events.push(PIPELINE_TRIGGER_PHRASES['plan-approved']);
  }
  if (triggers.includes('task-ready')) {
    events.push(PIPELINE_TRIGGER_PHRASES['task-ready']);
  }
  if (events.length === 0) return 'Manual';
  const phrase = events.join(' or ');
  return triggers.includes('manual')
    ? `Manual, or when ${phrase}`
    : `When ${phrase}`;
}

/** `6 steps`, `1 step`. */
export function describeStepCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'step' : 'steps'}`;
}

/** Where a pipeline starts when it cannot be run by hand. */
export function describeRunUnavailable(
  triggers: readonly WorkflowTriggerKind[],
): string {
  const events: string[] = [];
  if (triggers.includes('plan-approved')) events.push('an approved plan');
  if (triggers.includes('task-ready')) events.push('a new task');
  return events.length === 0
    ? 'Cannot be started from here'
    : `Starts from ${events.join(' or ')}`;
}

const TRIGGER_FILTER_PHRASES: Readonly<Record<WorkflowTriggerKind, string>> = {
  schedule: 'a schedule',
  once: 'a one-time trigger',
  manual: 'a manual trigger',
  'plan-approved': 'a plan-approved trigger',
  'task-ready': 'a task-ready trigger',
};

/**
 * The filtered empty state's sentence: `No workflows match "deploy" with a
 * one-time trigger`. Names the query and the trigger filter; the other
 * filters read as "these filters".
 */
export function describeNoLibraryMatches(
  filters: WorkflowLibraryFilters,
): string {
  const query = filters.query.trim();
  const parts: string[] = ['No workflows match'];
  if (query !== '') parts.push(`"${query}"`);
  const trigger =
    filters.triggers.length === 1 ? filters.triggers[0] : undefined;
  if (trigger !== undefined) {
    parts.push(`with ${TRIGGER_FILTER_PHRASES[trigger]}`);
  }
  const others =
    filters.triggers.length > 1 ||
    filters.status !== null ||
    filters.project !== null ||
    filters.source !== null;
  if (query === '' && trigger === undefined) parts.push('these filters');
  else if (others) parts.push('and these filters');
  return parts.join(' ');
}

/** The Trigger capsule's label for the current selection. */
export function describeTriggerFilter(
  triggers: readonly WorkflowTriggerKind[],
): string {
  const first = triggers[0];
  if (first === undefined) return 'Any trigger';
  if (triggers.length === 1) return WORKFLOW_TRIGGER_LABELS[first];
  return `${String(triggers.length)} triggers`;
}

/** The More menu's items for a row, in menu order. */
export function menuWorkflowLibraryActions(
  actions: readonly WorkflowLibraryAction[],
): readonly WorkflowLibraryAction[] {
  return LIBRARY_MENU_ORDER.filter((action) => actions.includes(action));
}

/** The trigger kinds this host can show, for the Trigger filter's options. */
export function availableWorkflowTriggerKinds(
  capabilities: CanopyCapabilities,
): readonly WorkflowTriggerKind[] {
  if (isFeatureSurfaceAvailable(capabilities, 'workflow-automations')) {
    return WORKFLOW_TRIGGER_KINDS;
  }
  return WORKFLOW_TRIGGER_KINDS.filter(
    (trigger) => trigger !== 'schedule' && trigger !== 'once',
  );
}
