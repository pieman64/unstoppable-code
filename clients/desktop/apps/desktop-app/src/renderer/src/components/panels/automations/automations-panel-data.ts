/**
 * Pure data derivation for the workspace Automations panel: workspace/worktree
 * scoping of automations and watchers, the Schedule occurrence window, and the
 * scope rules the Runs section hands the Workflows run feed. Dependency-free (no stores, no React) so every
 * rule here is unit-testable in plain Node.
 */
import type {
  AppAdvisorWatcherSummary,
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import {
  enumerateAutomationOccurrences,
  getNextAutomationTriggerRun,
} from '@canopy/desktop-shared/lib/automations';
import {
  pipelineAutomationTaskId,
  pipelineAutomationWorkspaceId,
  resolveAutomationPipelineTarget,
} from '@canopy/desktop-shared/lib/automation-pipeline-target';
import type { RunFeedInput } from '@/lib/workflows/run-feed';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import { workflowScheduleDestination } from '@canopy/desktop-shared/lib/workflow-schedule-destination';

/** Scope the panel filters by: the owning workspace and (optionally) worktree. */
export interface AutomationsPanelScope {
  projectId: string;
  worktreeId: string;
  /**
   * When true (code workspaces only), entries must explicitly reference the
   * current worktree; when false, every workspace-scoped entry matches.
   */
  worktreeOnly: boolean;
}

/** Entries firing inside this window are always shown in Upcoming. */
export const UPCOMING_SOON_WINDOW_MS = 10 * 60 * 1000;
/** Upcoming is padded out to at least this many entries when available. */
export const UPCOMING_MIN_ENTRIES = 5;
/**
 * Per-activity occurrence cap while enumerating the 10-minute window. A
 * five-field cron cannot fire more than once per minute, so 20 leaves margin
 * while bounding malformed or future trigger implementations.
 */
export const UPCOMING_MAX_OCCURRENCES_PER_ACTIVITY = 20;
/** Cap on Runs rows rendered by the panel. */
export const RUNS_MAX_ROWS = 50;

/**
 * The workspace an automation action targets, or `undefined` for actions with
 * no workspace scope (`app_advisor_prompt`). `standalone_prompt` stores the
 * cowork workspace id in `chatProjectId` (cowork workspaces ARE the
 * standalone chat projects).
 */
export function automationActionWorkspaceId(
  action: AutomationAction,
): string | undefined {
  switch (action.type) {
    case 'worktree_prompt':
    case 'worktree_session_prompt':
      return action.workspaceId;
    case 'worktree_pipeline':
      // A pipeline with no project has no workspace scope; its inert
      // `workspaceId` is never read.
      return pipelineAutomationWorkspaceId(action);
    case 'standalone_prompt':
      return action.chatProjectId;
    case 'pipeline_execution_resume':
      return action.projectId;
    case 'app_advisor_prompt':
      return undefined;
  }
}

/**
 * The worktree an automation action explicitly references, or `undefined`
 * when the action is workspace-level (fresh worktree, branch checkout, cowork
 * chat, …).
 */
export function automationActionWorktreeId(
  action: AutomationAction,
): string | undefined {
  switch (action.type) {
    case 'worktree_prompt':
      // `baseWorktreeId` only chooses the source for a newly provisioned
      // worktree. It does not target the existing worktree itself.
      return action.existingWorktreeId;
    case 'worktree_session_prompt':
      return action.worktreeId;
    case 'worktree_pipeline':
      // An existing-task destination targets that task. Otherwise the run
      // provisions a fresh worktree or uses the project folder;
      // `baseWorktreeId` is only a source and must not match the toggle.
      return pipelineAutomationTaskId(action);
    case 'pipeline_execution_resume':
      return action.worktreeId;
    case 'app_advisor_prompt':
    case 'standalone_prompt':
      return undefined;
  }
}

/**
 * The inputs of a workflow this automation owns and stores as a global
 * pipeline (CAN-4551 / CAN-5479). A converted chat automation runs a workflow
 * with no project of its own; the chat's workspace (`project_id`) and existing
 * task (`task_id`) are inputs the conversion wrote. `undefined` for anything
 * else, including a global pipeline the automation does not own.
 */
function ownedGlobalWorkflowInputs(
  activity: ScheduledActivity,
): Readonly<Record<string, string>> | undefined {
  const stored = activity.ownedPipeline?.storedAction;
  if (stored?.type !== 'worktree_pipeline') return undefined;
  return resolveAutomationPipelineTarget(stored)?.kind === 'global'
    ? stored.inputs
    : undefined;
}

function activityWorkspaceId(activity: ScheduledActivity): string | undefined {
  // CAN-5782: a workflow schedule runs where its destination points.
  const destination = workflowScheduleDestination(activity);
  if (destination?.kind === 'chat_action')
    return automationActionWorkspaceId(destination.action);
  if (destination?.kind === 'inputs') return destination.projectId;
  return (
    automationActionWorkspaceId(activity.action) ??
    ownedGlobalWorkflowInputs(activity)?.project_id
  );
}

/**
 * For an owned workflow, `task_id` is a worktree in a code workspace and a
 * Work Entry in a cowork one, which never narrows to a worktree.
 */
function activityWorktreeId(activity: ScheduledActivity): string | undefined {
  const destination = workflowScheduleDestination(activity);
  if (destination?.kind === 'chat_action')
    return automationActionWorktreeId(destination.action);
  if (destination?.kind === 'inputs') return destination.taskId;
  return (
    automationActionWorktreeId(activity.action) ??
    ownedGlobalWorkflowInputs(activity)?.task_id
  );
}

function activityMatchesScope(
  activity: ScheduledActivity,
  scope: AutomationsPanelScope,
): boolean {
  if (activityWorkspaceId(activity) !== scope.projectId) {
    return false;
  }
  if (!scope.worktreeOnly) return true;
  return activityWorktreeId(activity) === scope.worktreeId;
}

/** Activities targeting the scope's workspace (and worktree when narrowed). */
export function filterActivitiesForScope(
  activities: ScheduledActivity[],
  scope: AutomationsPanelScope,
): ScheduledActivity[] {
  return activities.filter((activity) => activityMatchesScope(activity, scope));
}

/**
 * The workspace a watcher's TARGET observes, or `undefined` for target kinds
 * with no workspace scope (`automation`, `github_workflow_runs`,
 * `github_pull_requests`).
 */
export function watcherTargetWorkspaceId(
  watcher: AppAdvisorWatcherSummary,
): string | undefined {
  const target = watcher.target;
  switch (target.kind) {
    case 'scheduled_wakeup':
    case 'command_watch':
      return watcher.destination.projectId;
    case 'worktree_chat':
    case 'standalone_chat':
    case 'worktree_chat_scope':
    case 'standalone_chat_project':
    case 'worktree_pipeline':
    case 'worktree_hook':
      return target.projectId;
    case 'automation':
    case 'github_workflow_runs':
    case 'github_pull_requests':
      return undefined;
  }
}

/** The worktree a watcher's target explicitly references, if any. */
export function watcherTargetWorktreeId(
  watcher: AppAdvisorWatcherSummary,
): string | undefined {
  const target = watcher.target;
  switch (target.kind) {
    case 'scheduled_wakeup':
    case 'command_watch':
      return watcher.destination.worktreeId;
    case 'worktree_chat':
    case 'worktree_chat_scope':
    case 'worktree_pipeline':
    case 'worktree_hook':
      return target.worktreeId;
    case 'standalone_chat':
    case 'standalone_chat_project':
    case 'automation':
    case 'github_workflow_runs':
    case 'github_pull_requests':
      return undefined;
  }
}

function watcherMatchesScope(
  watcher: AppAdvisorWatcherSummary,
  scope: AutomationsPanelScope,
  activitiesById: ReadonlyMap<string, ScheduledActivity>,
): boolean {
  if (watcher.target.kind === 'automation') {
    const activity = activitiesById.get(watcher.target.automationId);
    return activity ? activityMatchesScope(activity, scope) : false;
  }
  if (watcherTargetWorkspaceId(watcher) !== scope.projectId) {
    return false;
  }
  if (!scope.worktreeOnly) return true;
  return watcherTargetWorktreeId(watcher) === scope.worktreeId;
}

/**
 * The Workflows run feed's scope rules for this panel (`buildWorkflowRunRows`).
 * Workflows and watchers keep the panel's own scope. A pipeline run belongs to
 * the workspace (and worktree) it ran in; a run with no project, such as a
 * global workflow's, shows only through the scheduled run that owns it. A run
 * whose workflow is gone is placed by where it ran.
 */
export function panelRunFeedPredicates(
  scope: AutomationsPanelScope,
  activities: readonly ScheduledActivity[],
): Pick<
  RunFeedInput,
  'activityInScope' | 'orphanRunInScope' | 'executionInScope' | 'watcherInScope'
> {
  const activitiesById = new Map(
    activities.map((activity) => [activity.id, activity]),
  );
  const inScope = (
    workspaceId: string | undefined,
    worktreeId: string | undefined,
  ): boolean =>
    workspaceId === scope.projectId &&
    (!scope.worktreeOnly || worktreeId === scope.worktreeId);
  return {
    activityInScope: (activity) => activityMatchesScope(activity, scope),
    orphanRunInScope: (run) =>
      inScope(
        run.result?.projectId ?? run.target?.workspaceId,
        run.result?.worktreeId ?? run.target?.worktreeId,
      ),
    executionInScope: (execution) =>
      inScope(execution.project_id, execution.worktree_id),
    // A watcher still watching is listed in Library, and a fire still being
    // delivered is not history yet; Runs shows finished fires.
    watcherInScope: (watcher) =>
      (watcher.status === 'fired' || watcher.status === 'delivery_failed') &&
      watcherMatchesScope(watcher, scope, activitiesById),
  };
}

/** Watchers whose target observes the scope's workspace (and worktree). */
export function filterWatchersForScope(
  watchers: AppAdvisorWatcherSummary[],
  scope: AutomationsPanelScope,
  activities: ScheduledActivity[] = [],
): AppAdvisorWatcherSummary[] {
  const activitiesById = new Map(
    activities.map((activity) => [activity.id, activity]),
  );
  return watchers.filter((watcher) =>
    watcherMatchesScope(watcher, scope, activitiesById),
  );
}

/** One row of the Upcoming section: a concrete future fire of an activity. */
export interface UpcomingEntry {
  /** `${activity.id}:${occursAt.getTime()}` — stable render key. */
  key: string;
  activity: ScheduledActivity;
  occursAt: Date;
  /** Whether the fire lands inside {@link UPCOMING_SOON_WINDOW_MS}. */
  withinSoonWindow: boolean;
}

/**
 * The Upcoming section rows: every enabled scoped activity occurrence inside
 * the next 10 minutes, padded with the next later occurrences until the list
 * holds at least {@link UPCOMING_MIN_ENTRIES}. Padding has no arbitrary time
 * horizon: sparse weekly/monthly schedules still contribute their next fires.
 */
export function buildUpcomingEntries(
  activities: ScheduledActivity[],
  now: Date,
): UpcomingEntry[] {
  const soonBoundary = now.getTime() + UPCOMING_SOON_WINDOW_MS;
  const { occurrences } = enumerateAutomationOccurrences(activities, {
    rangeStart: now,
    // The product rule is inclusive ("within the next 10 minutes"), while
    // the enumeration helper uses a half-open range.
    rangeEnd: new Date(soonBoundary + 1),
    maxOccurrencesPerActivity: UPCOMING_MAX_OCCURRENCES_PER_ACTIVITY,
  });
  const entries: UpcomingEntry[] = occurrences.map((occurrence) => ({
    key: occurrence.key,
    activity: occurrence.activity,
    occursAt: occurrence.occursAt,
    withinSoonWindow: true,
  }));

  if (entries.length >= UPCOMING_MIN_ENTRIES) return entries;

  const lastOccurrenceByActivity = new Map<string, Date>();
  for (const occurrence of occurrences) {
    lastOccurrenceByActivity.set(occurrence.activity.id, occurrence.occursAt);
  }
  const candidates = activities
    .filter((activity) => activity.enabled)
    .map((activity) => {
      const cursor =
        lastOccurrenceByActivity.get(activity.id) ??
        new Date(now.getTime() - 1);
      return {
        activity,
        occursAt: getNextAutomationTriggerRun(activity.schedule, cursor),
      };
    });

  while (entries.length < UPCOMING_MIN_ENTRIES) {
    let nextIndex = -1;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]?.occursAt;
      if (!candidate) continue;
      const current =
        nextIndex >= 0 ? candidates[nextIndex]?.occursAt : undefined;
      if (!current || candidate.getTime() < current.getTime()) {
        nextIndex = index;
      }
    }
    if (nextIndex < 0) break;

    const candidate = candidates[nextIndex];
    if (!candidate?.occursAt) break;
    entries.push({
      key: `${candidate.activity.id}:${candidate.occursAt.getTime()}`,
      activity: candidate.activity,
      occursAt: candidate.occursAt,
      withinSoonWindow: candidate.occursAt.getTime() <= soonBoundary,
    });
    candidate.occursAt = getNextAutomationTriggerRun(
      candidate.activity.schedule,
      candidate.occursAt,
    );
  }
  return entries;
}

/**
 * Renderer-authoritative next run. The persisted `nextRunAt` value is a
 * scheduler snapshot and may lag; the shared trigger calculation is the
 * contract source of truth for previews and details.
 */
export function getAutomationNextRun(
  activity: ScheduledActivity,
  now: Date,
): Date | null {
  return activity.enabled
    ? getNextAutomationTriggerRun(activity.schedule, now)
    : null;
}

/**
 * Compact future-relative label for an Upcoming entry ("now", "in 3m",
 * "in 2h 15m", "in 3d"). Pure so the rounding rules are unit-testable.
 */
export function formatTimeUntil(now: Date, occursAt: Date): string {
  const deltaMs = occursAt.getTime() - now.getTime();
  if (deltaMs <= 30_000) return 'now';
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder > 0 ? `in ${hours}h ${remainder}m` : `in ${hours}h`;
  }
  return `in ${Math.floor(hours / 24)}d`;
}

/** The Library's type filter: every kind, or one. */
export type LibraryTypeFilter =
  | 'all'
  | 'automations'
  | 'pipelines'
  | 'watchers';

/** One Library row: a scheduled workflow, an on-demand workflow or a watcher. */
export type LibraryRow =
  | { kind: 'automation'; activity: ScheduledActivity }
  | { kind: 'pipeline'; pipeline: PipelineInfo }
  | { kind: 'watcher'; watcher: AppAdvisorWatcherSummary };

/**
 * The Library rows: the scoped scheduled workflows, the workspace's own
 * on-demand workflows (project pipelines; user, bundled and shared ones belong
 * to no workspace and stay on the Workflows page), then the scoped watchers,
 * narrowed by type and by a case-insensitive name match.
 */
export function buildLibraryRows(input: {
  activities: readonly ScheduledActivity[];
  pipelines: readonly PipelineInfo[];
  watchers: readonly AppAdvisorWatcherSummary[];
  typeFilter: LibraryTypeFilter;
  search: string;
}): LibraryRow[] {
  const needle = input.search.trim().toLowerCase();
  const matches = (name: string): boolean =>
    needle.length === 0 || name.toLowerCase().includes(needle);
  const shows = (kind: Exclude<LibraryTypeFilter, 'all'>): boolean =>
    input.typeFilter === 'all' || input.typeFilter === kind;
  const rows: LibraryRow[] = [];
  if (shows('automations')) {
    for (const activity of input.activities) {
      if (matches(activity.name)) rows.push({ kind: 'automation', activity });
    }
  }
  if (shows('pipelines')) {
    for (const pipeline of input.pipelines) {
      if (pipeline.source === 'project' && matches(pipeline.name)) {
        rows.push({ kind: 'pipeline', pipeline });
      }
    }
  }
  if (shows('watchers')) {
    for (const watcher of input.watchers) {
      if (matches(watcher.label)) rows.push({ kind: 'watcher', watcher });
    }
  }
  return rows;
}
