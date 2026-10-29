/**
 * Pure data derivation for the workspace Automations panel: workspace/worktree
 * scoping of automations and watchers, the Upcoming occurrence window, and the
 * merged Completed history. Dependency-free (no stores, no React) so every
 * rule here is unit-testable in plain Node.
 */
import type {
  AppAdvisorWatcherSummary,
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import {
  enumerateAutomationOccurrences,
  getNextAutomationTriggerRun,
} from '@canopy/desktop-shared/lib/automations';

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
/** Cap on merged Completed rows rendered by the panel. */
export const COMPLETED_MAX_ENTRIES = 50;

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
    case 'worktree_pipeline':
      return action.workspaceId;
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
      // Pipeline automations provision a fresh worktree; `baseWorktreeId` is
      // only its source and must not match the worktree-only toggle.
      return undefined;
    case 'pipeline_execution_resume':
      return action.worktreeId;
    case 'app_advisor_prompt':
    case 'standalone_prompt':
      return undefined;
  }
}

function activityMatchesScope(
  activity: ScheduledActivity,
  scope: AutomationsPanelScope,
): boolean {
  if (automationActionWorkspaceId(activity.action) !== scope.projectId) {
    return false;
  }
  if (!scope.worktreeOnly) return true;
  return automationActionWorktreeId(activity.action) === scope.worktreeId;
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

/** One row of the Completed section (merged automation runs + watcher fires). */
export type CompletedEntry =
  | {
      kind: 'automation-run';
      key: string;
      name: string;
      // `missed` is deliberately absent: missed occurrences are archive-only
      // and never enter the `recentRuns` hot window this list reads.
      status: 'success' | 'failure' | 'skipped' | 'canceled';
      completedAt: Date;
      run: ScheduledActivityRun;
      /** The owning activity, when it still exists. */
      activity?: ScheduledActivity;
    }
  | {
      kind: 'watcher-fire';
      key: string;
      name: string;
      status: 'success' | 'failure';
      completedAt: Date;
      watcher: AppAdvisorWatcherSummary;
    };

/**
 * The Completed section rows: finished (non-running) runs of the scoped
 * activities merged with the scoped completed watcher fires, newest first,
 * capped at {@link COMPLETED_MAX_ENTRIES}.
 *
 * `scopedActivities` doubles as the scope filter for runs — a run whose
 * activity was deleted (or falls outside the scope) is dropped, because runs
 * carry no target of their own.
 */
export function buildCompletedEntries(
  recentRuns: ScheduledActivityRun[],
  scopedActivities: ScheduledActivity[],
  scopedCompletedWatchers: AppAdvisorWatcherSummary[],
): CompletedEntry[] {
  const activitiesById = new Map(
    scopedActivities.map((activity) => [activity.id, activity]),
  );
  const entries: CompletedEntry[] = [];
  for (const run of recentRuns) {
    if (run.status === 'running' || run.status === 'missed') continue;
    const activity = activitiesById.get(run.activityId);
    if (!activity) continue;
    const completedAtMs = Date.parse(run.completedAt ?? run.startedAt);
    if (!Number.isFinite(completedAtMs)) continue;
    entries.push({
      kind: 'automation-run',
      key: `run:${run.id}`,
      name: run.activityName || activity.name,
      status: run.status,
      completedAt: new Date(completedAtMs),
      run,
      activity,
    });
  }
  for (const watcher of scopedCompletedWatchers) {
    // A fire whose message is still being delivered is not history yet.
    if (watcher.status === 'firing') continue;
    const completedAtMs = Date.parse(
      watcher.completedAt ?? watcher.firedAt ?? watcher.createdAt,
    );
    if (!Number.isFinite(completedAtMs)) continue;
    entries.push({
      kind: 'watcher-fire',
      key: `watcher:${watcher.id}`,
      name: watcher.label,
      status: watcher.status === 'delivery_failed' ? 'failure' : 'success',
      completedAt: new Date(completedAtMs),
      watcher,
    });
  }
  entries.sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
  return entries.slice(0, COMPLETED_MAX_ENTRIES);
}
