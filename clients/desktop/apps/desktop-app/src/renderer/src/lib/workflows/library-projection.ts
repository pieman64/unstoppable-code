import type {
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionSummary,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import { pipelineSharePath } from '@canopy/protocol/pipelines';
import { describeFiveFieldCron } from '@canopy/ui-shared/lib';
import {
  describePipelineTriggers,
  describeRunUnavailable,
  describeStepCount,
  formatOneTimeTrigger,
  type WorkflowLastRunState,
  type WorkflowLibraryAction,
  type WorkflowLibraryRow,
  type WorkflowLibrarySource,
  type WorkflowStepGlyph,
  type WorkflowTriggerKind,
} from '@canopy/ui-app/workflows';
import { automationLibraryKey } from './run-feed';
import { automationProjectId } from './schedule-filter';

/**
 * The desktop Library rows (CAN-3981): a pure projection over what the
 * renderer already loads. Every automation is a row and every pipeline is a
 * row; a pipeline and the automations that run it are never folded together.
 * Nothing here reads or writes a store, so the page passes in the current
 * context's activities, pipelines and executions.
 */

/** Who shared an item, as the row's source suffix shows it. */
export interface LibrarySharer {
  /** A person, team or organization name. */
  readonly name: string;
  /** The name is a person's, so session replay masks it. */
  readonly isPerson: boolean;
}

/** A share visible to the user that they have not added yet. */
export interface LibrarySharedAutomation {
  readonly remoteId: string;
  readonly name: string;
  readonly triggerKind: 'cron' | 'one_time';
  readonly actionType: AutomationAction['type'];
  readonly sharer?: LibrarySharer;
  /** ISO 8601. */
  readonly updatedAt?: string;
}

export interface LibraryProjectionInput {
  /** Activities in the current context. */
  readonly activities: readonly ScheduledActivity[];
  /** The hot window; a running run marks its automation as running now. */
  readonly recentRuns: readonly ScheduledActivityRun[];
  /** User, project, built-in and shared pipelines the page lists. */
  readonly pipelines: readonly PipelineInfo[];
  /** The existing pipeline enable toggle's state, keyed by pipeline id. */
  readonly disabledPipelineIds: ReadonlySet<string>;
  /** Every retained execution, for a pipeline's Last run. */
  readonly executions: readonly ExecutionSummary[];
  /** Shares in the current context under the current access rules. */
  readonly sharedAutomations: readonly LibrarySharedAutomation[];
  /**
   * Shares the user has added in any context. A copy may run in a project
   * the current context does not list, and its share is still added.
   * Defaults to the shares `activities` were installed from.
   */
  readonly installedRemoteIds?: ReadonlySet<string>;
  /** Installs in flight, by share id; their Add is disabled. */
  readonly installingRemoteIds?: ReadonlySet<string>;
  /** Epoch milliseconds. */
  readonly now: number;
  readonly locale?: string;
  /** Project of the list's working directory, for project pipelines. */
  readonly currentProjectId?: string;
  /** `getAutomationNextRun`: the renderer-authoritative next occurrence. */
  readonly nextRun: (activity: ScheduledActivity, now: Date) => Date | null;
  readonly projectName: (projectId: string) => string | undefined;
  readonly chatTitle: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ) => string | undefined;
  /**
   * A pipeline's steps when its definition is loaded. `undefined` leaves the
   * chain to the step count, or to the name alone.
   */
  readonly pipelineSteps?: (
    pipeline: PipelineInfo,
  ) => readonly WorkflowStepGlyph[] | undefined;
  /** Who shared an installed copy, by the share it was installed from. */
  readonly sharerForInstalled?: (
    activity: ScheduledActivity,
  ) => LibrarySharer | undefined;
  /** Why an automation's target cannot be used, when it cannot. */
  readonly targetUnavailable?: (
    activity: ScheduledActivity,
  ) => string | undefined;
}

export function pipelineLibraryKey(pipeline: PipelineInfo): string {
  // Ids are unique per source only; project rows add their file and shared
  // rows their remote id, as the document locator does.
  if (pipeline.source === 'shared') {
    return `pipeline:shared:${pipeline.remoteId ?? pipeline.id}`;
  }
  if (pipeline.source === 'project') {
    return `pipeline:project:${pipeline.filePath ?? pipeline.id}`;
  }
  return `pipeline:${pipeline.source}:${pipeline.id}`;
}

export function sharedAutomationLibraryKey(remoteId: string): string {
  return `shared-automation:${remoteId}`;
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sharedByLabel(sharer: LibrarySharer | undefined): string {
  return sharer ? `Shared by ${sharer.name}` : 'Shared';
}

function pipelineTriggers(
  pipeline: PipelineInfo,
): readonly WorkflowTriggerKind[] {
  const triggers: WorkflowTriggerKind[] = [];
  const types = pipeline.triggerTypes ?? [];
  if (types.includes('dispatch')) triggers.push('manual');
  if (types.includes('plan_ready')) triggers.push('plan-approved');
  if (types.includes('task_ready')) triggers.push('task-ready');
  // A pipeline that declares no trigger is started by hand.
  return triggers.length === 0 ? ['manual'] : triggers;
}

function pipelineSource(pipeline: PipelineInfo): WorkflowLibrarySource {
  switch (pipeline.source) {
    case 'user':
      return 'mine';
    case 'project':
      return 'project';
    case 'shared':
      return 'shared';
    case 'bundled':
    case 'curated':
      return 'built-in';
  }
}

function pipelineSharer(pipeline: PipelineInfo): LibrarySharer | undefined {
  const owner = pipeline.owner;
  if (!owner || !owner.name) return undefined;
  return { name: owner.name, isPerson: owner.type === 'user' };
}

function executionLastRunState(
  status: ExecutionSummary['status'],
): WorkflowLastRunState {
  switch (status) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    case 'cancelled':
      return 'canceled';
    default:
      return 'running';
  }
}

/** Newest top-level execution per pipeline id. */
function latestExecutions(
  executions: readonly ExecutionSummary[],
): ReadonlyMap<string, ExecutionSummary> {
  const latest = new Map<string, ExecutionSummary>();
  for (const execution of executions) {
    if (execution.parent_execution_id !== undefined) continue;
    const current = latest.get(execution.pipeline_id);
    if (
      current === undefined ||
      (parseTime(execution.started_at) ?? 0) >
        (parseTime(current.started_at) ?? 0)
    ) {
      latest.set(execution.pipeline_id, execution);
    }
  }
  return latest;
}

/**
 * The link a pipeline row copies. A public link wins; team and organization
 * shares copy their member-only lander. Anything else has no link.
 */
export function pipelineShareLinkPath(
  pipeline: PipelineInfo,
): string | undefined {
  if (pipeline.publicShare) return pipeline.publicShare.sharePath;
  if (pipeline.source !== 'shared' || !pipeline.remoteId) return undefined;
  return pipeline.shareScope === 'team' ||
    pipeline.shareScope === 'organization'
    ? pipelineSharePath(pipeline.remoteId)
    : undefined;
}

function pipelineActions(
  pipeline: PipelineInfo,
  manual: boolean,
): readonly WorkflowLibraryAction[] {
  const actions: WorkflowLibraryAction[] = ['toggle'];
  if (manual) actions.push('run');
  actions.push('edit', 'view-runs');
  // Your own pipeline is edited in place; the others are copied to change.
  if (pipeline.source !== 'user') actions.push('duplicate');
  if (pipelineShareLinkPath(pipeline) !== undefined) actions.push('copy-link');
  if (pipeline.source === 'shared') {
    if (pipeline.canUpdate === true) actions.push('share');
    if (pipeline.canDelete === true) actions.push('delete');
    return actions;
  }
  actions.push('share');
  if (!pipeline.readonly) actions.push('delete');
  return actions;
}

function projectPipelineRow(
  pipeline: PipelineInfo,
  input: LibraryProjectionInput,
  latest: ReadonlyMap<string, ExecutionSummary>,
): WorkflowLibraryRow {
  const triggers = pipelineTriggers(pipeline);
  const manual = triggers.includes('manual');
  const source = pipelineSource(pipeline);
  const steps = input.pipelineSteps?.(pipeline);
  const sharer = source === 'shared' ? pipelineSharer(pipeline) : undefined;
  // Executions carry the pipeline id but not its source, so two pipelines
  // that share an id across sources share a Last run.
  const execution = latest.get(pipeline.id);
  const lastRunState = execution
    ? executionLastRunState(execution.status)
    : undefined;
  const projectId =
    pipeline.source === 'project' ? input.currentProjectId : undefined;
  return {
    key: pipelineLibraryKey(pipeline),
    kind: 'pipeline',
    name: pipeline.name,
    triggers,
    triggerText: describePipelineTriggers(triggers),
    steps: steps ?? [],
    summary: steps ? describeStepCount(steps.length) : '',
    ...(pipeline.description ? { searchText: pipeline.description } : {}),
    source,
    ...(source === 'mine'
      ? {}
      : {
          sourceLabel:
            source === 'shared'
              ? sharedByLabel(sharer)
              : source === 'project'
                ? 'From project'
                : 'Built-in',
        }),
    ...(sharer?.isPerson ? { sourceIsPerson: true } : {}),
    ...(execution && lastRunState
      ? {
          lastRun: {
            state: lastRunState,
            ...(lastRunState === 'running'
              ? {}
              : {
                  at: parseTime(execution.completed_at ?? execution.started_at),
                }),
          },
        }
      : {}),
    changedAt: parseTime(pipeline.updatedAt),
    enabled: !input.disabledPipelineIds.has(pipeline.id),
    ...(projectId
      ? { projectId, projectName: input.projectName(projectId) }
      : {}),
    actions: pipelineActions(pipeline, manual),
    ...(manual
      ? {}
      : { runUnavailableLabel: describeRunUnavailable(triggers) }),
  };
}

interface AutomationChain {
  readonly steps: readonly WorkflowStepGlyph[];
  readonly summary: string;
  /** The pipeline this automation runs is not in the list. */
  readonly missingPipeline: boolean;
}

/**
 * The listed pipeline an automation's `worktree_pipeline` action runs. Ids
 * are unique per source only, so a recorded source picks among same-id
 * pipelines; without one the first match wins.
 */
export function findTargetPipeline(
  action: Extract<AutomationAction, { type: 'worktree_pipeline' }>,
  pipelines: readonly PipelineInfo[],
): PipelineInfo | undefined {
  const sameId = pipelines.filter(
    (pipeline) => pipeline.id === action.pipelineId,
  );
  if (action.pipelineSource === undefined) return sameId[0];
  return (
    sameId.find((pipeline) => pipeline.source === action.pipelineSource) ??
    undefined
  );
}

function automationChain(
  action: AutomationAction,
  input: LibraryProjectionInput,
): AutomationChain {
  switch (action.type) {
    case 'app_advisor_prompt':
      return {
        steps: ['advisor'],
        summary: 'Ask Advisor',
        missingPipeline: false,
      };
    case 'standalone_prompt':
    case 'worktree_prompt': {
      const project = input.projectName(
        action.type === 'standalone_prompt'
          ? action.chatProjectId
          : action.workspaceId,
      );
      return {
        steps: ['chat'],
        summary: project ? `Start chat in ${project}` : 'Start chat',
        missingPipeline: false,
      };
    }
    case 'worktree_session_prompt': {
      const chat =
        input.chatTitle(action.workspaceId, action.worktreeId, action.chatId) ??
        action.chatTitle;
      return {
        steps: ['message'],
        summary: chat ? `Send message to ${chat}` : 'Send message',
        missingPipeline: false,
      };
    }
    case 'worktree_pipeline': {
      const target = findTargetPipeline(action, input.pipelines);
      const name = target?.name ?? action.pipelineName ?? action.pipelineId;
      if (!target) {
        // The chain shows the pipeline's name alone.
        return { steps: ['pipeline'], summary: name, missingPipeline: true };
      }
      const steps = input.pipelineSteps?.(target);
      return steps
        ? {
            steps,
            summary: describeStepCount(steps.length),
            missingPipeline: false,
          }
        : { steps: ['pipeline'], summary: name, missingPipeline: false };
    }
    case 'pipeline_execution_resume':
      return {
        steps: ['pipeline'],
        summary: `Resume ${action.pipelineName}`,
        missingPipeline: false,
      };
  }
}

function automationAttention(
  activity: ScheduledActivity,
  chain: AutomationChain,
  input: LibraryProjectionInput,
): string | undefined {
  if (activity.sharedPipelineReview) {
    return 'Review needed: the shared pipeline changed';
  }
  if (chain.missingPipeline) return 'The pipeline it runs is missing';
  const unavailable = input.targetUnavailable?.(activity);
  if (unavailable) return unavailable;
  if (activity.failureCount === 1) return 'The last run failed';
  if (activity.failureCount > 1) {
    return `Failed the last ${String(activity.failureCount)} runs`;
  }
  return undefined;
}

/** An automation's trigger kind and the schedule text its Library row shows. */
export function automationTrigger(
  activity: ScheduledActivity,
  locale: string | undefined,
): { readonly kind: WorkflowTriggerKind; readonly text: string } {
  if (activity.schedule.kind === 'cron') {
    return {
      kind: 'schedule',
      // The raw expression shows only when it has no plain-language form.
      text:
        describeFiveFieldCron(activity.schedule.expression) ??
        activity.schedule.expression,
    };
  }
  const runAt = parseTime(activity.schedule.runAt);
  return {
    kind: 'once',
    text:
      runAt === undefined
        ? activity.schedule.runAt
        : formatOneTimeTrigger(runAt, locale),
  };
}

function projectAutomationRow(
  activity: ScheduledActivity,
  runningActivityIds: ReadonlySet<string>,
  input: LibraryProjectionInput,
): WorkflowLibraryRow {
  const trigger = automationTrigger(activity, input.locale);
  const chain = automationChain(activity.action, input);
  const installed = activity.installedFrom !== undefined;
  const sharer = installed ? input.sharerForInstalled?.(activity) : undefined;
  const attention = automationAttention(activity, chain, input);
  const next = input.nextRun(activity, new Date(input.now));
  const projectId = automationProjectId(activity.action);
  const projectName = projectId ? input.projectName(projectId) : undefined;
  const lastRun: WorkflowLibraryRow['lastRun'] = runningActivityIds.has(
    activity.id,
  )
    ? { state: 'running' }
    : activity.lastResult
      ? {
          state: activity.lastResult.status,
          at: parseTime(activity.lastResult.completedAt),
        }
      : undefined;
  return {
    key: automationLibraryKey(activity.id),
    kind: 'automation',
    name: activity.name,
    triggers: [trigger.kind],
    triggerText: trigger.text,
    // An If command is the automation's own gate, shown before its action.
    steps: activity.ifCommand ? ['gate', ...chain.steps] : chain.steps,
    summary: chain.summary,
    // A copy keeps its suffix even after the share is revoked.
    source: installed ? 'shared' : 'mine',
    ...(installed ? { sourceLabel: sharedByLabel(sharer) } : {}),
    ...(sharer?.isPerson ? { sourceIsPerson: true } : {}),
    ...(attention ? { attention } : {}),
    ...(lastRun ? { lastRun } : {}),
    ...(next ? { nextRunAt: next.getTime() } : {}),
    changedAt: parseTime(activity.updatedAt),
    enabled: activity.enabled,
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    // A usage-limit resume binds to a local execution, so it is not shared.
    actions:
      activity.action.type === 'pipeline_execution_resume'
        ? ['toggle', 'run', 'edit', 'view-runs', 'delete']
        : ['toggle', 'run', 'edit', 'view-runs', 'share', 'delete'],
  };
}

function sharedAutomationGlyph(
  actionType: AutomationAction['type'],
): WorkflowStepGlyph {
  switch (actionType) {
    case 'app_advisor_prompt':
      return 'advisor';
    case 'standalone_prompt':
    case 'worktree_prompt':
      return 'chat';
    case 'worktree_session_prompt':
      return 'message';
    case 'worktree_pipeline':
    case 'pipeline_execution_resume':
      return 'pipeline';
  }
}

const SHARED_AUTOMATION_SUMMARIES: Readonly<Record<WorkflowStepGlyph, string>> =
  {
    advisor: 'Ask Advisor',
    chat: 'Start chat',
    message: 'Send message',
    pipeline: 'Run a pipeline',
    gate: '',
    agent: '',
    script: '',
    input: '',
    step: '',
  };

function projectSharedAutomationRow(
  share: LibrarySharedAutomation,
  input: LibraryProjectionInput,
): WorkflowLibraryRow {
  const glyph = sharedAutomationGlyph(share.actionType);
  return {
    key: sharedAutomationLibraryKey(share.remoteId),
    kind: 'automation',
    name: share.name,
    triggers: [share.triggerKind === 'cron' ? 'schedule' : 'once'],
    // The schedule itself is read once the share is added.
    triggerText: share.triggerKind === 'cron' ? 'On a schedule' : 'One time',
    steps: [glyph],
    summary: SHARED_AUTOMATION_SUMMARIES[glyph],
    source: 'shared',
    sourceLabel: sharedByLabel(share.sharer),
    ...(share.sharer?.isPerson ? { sourceIsPerson: true } : {}),
    changedAt: parseTime(share.updatedAt),
    installable: true,
    ...(input.installingRemoteIds?.has(share.remoteId)
      ? { installing: true }
      : {}),
    actions: ['add'],
  };
}

/** Every Library row for the current context, automations then pipelines. */
export function projectLibraryRows(
  input: LibraryProjectionInput,
): readonly WorkflowLibraryRow[] {
  const runningActivityIds = new Set(
    input.recentRuns
      .filter((run) => run.status === 'running')
      .map((run) => run.activityId),
  );
  const latest = latestExecutions(input.executions);
  // A share and the user's added copy of it are one row: the added copy.
  const installedRemoteIds =
    input.installedRemoteIds ??
    new Set(
      input.activities.flatMap((activity) =>
        activity.installedFrom ? [activity.installedFrom.remoteId] : [],
      ),
    );
  return [
    ...input.activities.map((activity) =>
      projectAutomationRow(activity, runningActivityIds, input),
    ),
    ...input.sharedAutomations
      .filter((share) => !installedRemoteIds.has(share.remoteId))
      .map((share) => projectSharedAutomationRow(share, input)),
    ...input.pipelines.map((pipeline) =>
      projectPipelineRow(pipeline, input, latest),
    ),
  ];
}
