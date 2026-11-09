import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import type { PipelineStatusReason } from '@canopy/ui-shared/lib';

export type PipelineRunRowState = {
  readonly id: string;
  readonly status: ExecutionState['status'];
  readonly planId?: string;
  readonly rerun_source_id?: string;
  readonly event_name?: ExecutionState['event_name'];
  readonly trigger_source?: ExecutionState['trigger_source'];
  readonly status_reasons?: readonly PipelineStatusReason[];
  readonly inputs_persisted?: boolean;
  readonly rerun_context?: {
    readonly event_data?: {
      readonly task_ready?: { readonly task_text?: string };
      readonly plan_ready?: { readonly plan_text?: string };
    };
  };
  readonly pending_pauses?: readonly {
    readonly id: string;
    readonly kind: 'input' | 'action';
    readonly job_id: string;
    readonly logical_job_id: string;
    readonly step_id: string;
    readonly request?: {
      readonly title?: string;
      readonly message?: string;
      readonly fields: readonly unknown[];
    };
  }[];
  readonly pipeline_snapshot: {
    readonly jobs: Readonly<
      Record<
        string,
        {
          readonly name?: string;
          readonly needs: readonly string[];
          readonly steps: readonly { readonly id: string }[];
        }
      >
    >;
  };
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly status: string;
        readonly started_at?: string;
        readonly completed_at?: string;
        readonly steps: Readonly<Record<string, { readonly status: string }>>;
      }
    >
  >;
  readonly job_groups: Readonly<
    Record<
      string,
      {
        readonly kind: 'single' | 'matrix';
        readonly status: string;
        readonly variant_job_ids: readonly string[];
        readonly started_at?: string;
        readonly completed_at?: string;
        readonly resolved_max_parallel?: number;
      }
    >
  >;
};

type PipelineRunRowJob = PipelineRunRowState['jobs'][string];
type PipelineRunRowJobGroup = PipelineRunRowState['job_groups'][string];

function replayTextMarker(text: string): string {
  return text.length === 0 ? '' : '1';
}

function projectRerunContext(
  context: ExecutionState['rerun_context'] | undefined,
): PipelineRunRowState['rerun_context'] | undefined {
  if (context === undefined) return undefined;
  if (context.event_data === undefined) return {};

  const taskReady = context.event_data.task_ready;
  const planReady = context.event_data.plan_ready;
  return {
    event_data: {
      ...(taskReady === undefined
        ? {}
        : {
            task_ready: {
              ...(taskReady.task_text === undefined
                ? {}
                : { task_text: replayTextMarker(taskReady.task_text) }),
            },
          }),
      ...(planReady === undefined
        ? {}
        : {
            plan_ready: {
              ...(planReady.plan_text === undefined
                ? {}
                : { plan_text: replayTextMarker(planReady.plan_text) }),
            },
          }),
    },
  };
}

function projectStatusReasons(
  reasons: ExecutionState['status_reasons'] | undefined,
): readonly PipelineStatusReason[] | undefined {
  if (reasons === undefined) return undefined;
  return reasons.map((reason) => ({
    id: reason.id,
    kind: reason.kind,
    code: reason.code,
    ...(reason.provider === undefined ? {} : { provider: reason.provider }),
    ...(reason.resets_at === undefined ? {} : { resets_at: reason.resets_at }),
  }));
}

function projectPendingPauses(
  pauses: ExecutionState['pending_pauses'] | undefined,
): PipelineRunRowState['pending_pauses'] {
  if (pauses === undefined) return undefined;
  return pauses.map((pause) => ({
    id: pause.id,
    kind: pause.kind,
    job_id: pause.job_id,
    logical_job_id: pause.logical_job_id,
    step_id: pause.step_id,
    ...(pause.request === undefined
      ? {}
      : {
          request: {
            fields: [],
            ...(pause.request.title === undefined
              ? {}
              : { title: pause.request.title }),
            ...(pause.request.message === undefined
              ? {}
              : { message: pause.request.message }),
          },
        }),
  }));
}

function projectPipelineJobs(
  jobs: ExecutionState['pipeline_snapshot']['jobs'] | undefined,
): PipelineRunRowState['pipeline_snapshot']['jobs'] {
  const projected: Record<
    string,
    PipelineRunRowState['pipeline_snapshot']['jobs'][string]
  > = {};
  for (const [jobId, job] of Object.entries(jobs ?? {})) {
    projected[jobId] = {
      name: job.name,
      needs: [...job.needs],
      steps: job.steps.map((step) => ({ id: step.id })),
    };
  }
  return projected;
}

function projectJobs(
  jobs: ExecutionState['jobs'] | undefined,
): PipelineRunRowState['jobs'] {
  const projected: Record<string, PipelineRunRowJob> = {};
  for (const [jobId, job] of Object.entries(jobs ?? {})) {
    const steps: Record<string, { readonly status: string }> = {};
    for (const [stepId, step] of Object.entries(job.steps)) {
      steps[stepId] = { status: step.status };
    }
    projected[jobId] = {
      status: job.status,
      ...(job.started_at === undefined ? {} : { started_at: job.started_at }),
      ...(job.completed_at === undefined
        ? {}
        : { completed_at: job.completed_at }),
      steps,
    };
  }
  return projected;
}

function projectJobGroups(
  groups: ExecutionState['job_groups'] | undefined,
): PipelineRunRowState['job_groups'] {
  const projected: Record<string, PipelineRunRowJobGroup> = {};
  for (const [jobId, group] of Object.entries(groups ?? {})) {
    projected[jobId] = {
      kind: group.kind,
      status: group.status,
      variant_job_ids: [...group.variant_job_ids],
      ...(group.started_at === undefined
        ? {}
        : { started_at: group.started_at }),
      ...(group.completed_at === undefined
        ? {}
        : { completed_at: group.completed_at }),
      ...(group.resolved_max_parallel === undefined
        ? {}
        : { resolved_max_parallel: group.resolved_max_parallel }),
    };
  }
  return projected;
}

export function toPipelineRunRowState(
  state: ExecutionState,
): PipelineRunRowState {
  const statusReasons = projectStatusReasons(state.status_reasons);
  const pendingPauses = projectPendingPauses(state.pending_pauses);
  const rerunContext = projectRerunContext(state.rerun_context);

  return {
    id: state.id,
    status: state.status,
    pipeline_snapshot: {
      jobs: projectPipelineJobs(state.pipeline_snapshot?.jobs),
    },
    jobs: projectJobs(state.jobs),
    job_groups: projectJobGroups(state.job_groups),
    ...(state.planId === undefined ? {} : { planId: state.planId }),
    ...(state.rerun_source_id === undefined
      ? {}
      : { rerun_source_id: state.rerun_source_id }),
    ...(state.event_name === undefined ? {} : { event_name: state.event_name }),
    ...(state.trigger_source === undefined
      ? {}
      : { trigger_source: state.trigger_source }),
    ...(statusReasons === undefined ? {} : { status_reasons: statusReasons }),
    ...(state.inputs_persisted === undefined
      ? {}
      : { inputs_persisted: state.inputs_persisted }),
    ...(rerunContext === undefined ? {} : { rerun_context: rerunContext }),
    ...(pendingPauses === undefined ? {} : { pending_pauses: pendingPauses }),
  };
}

function copyJob(job: PipelineRunRowJob): PipelineRunRowJob {
  const steps: Record<string, { readonly status: string }> = {};
  for (const [stepId, step] of Object.entries(job.steps)) {
    steps[stepId] = { status: step.status };
  }
  return {
    status: job.status,
    ...(job.started_at === undefined ? {} : { started_at: job.started_at }),
    ...(job.completed_at === undefined
      ? {}
      : { completed_at: job.completed_at }),
    steps,
  };
}

function mergeJobs(
  existing: PipelineRunRowState['jobs'],
  incoming: PipelineRunRowState['jobs'],
): PipelineRunRowState['jobs'] {
  const merged: Record<string, PipelineRunRowJob> = {};
  for (const [jobId, job] of Object.entries(existing)) {
    merged[jobId] = copyJob(job);
  }
  for (const [jobId, job] of Object.entries(incoming)) {
    const prior = existing[jobId];
    const steps: Record<string, { readonly status: string }> = {};
    for (const [stepId, step] of Object.entries(prior?.steps ?? {})) {
      steps[stepId] = { status: step.status };
    }
    for (const [stepId, step] of Object.entries(job.steps)) {
      steps[stepId] = { status: step.status };
    }
    merged[jobId] = {
      status: job.status,
      ...(job.started_at === undefined
        ? prior?.started_at === undefined
          ? {}
          : { started_at: prior.started_at }
        : { started_at: job.started_at }),
      ...(job.completed_at === undefined
        ? prior?.completed_at === undefined
          ? {}
          : { completed_at: prior.completed_at }
        : { completed_at: job.completed_at }),
      steps,
    };
  }
  return merged;
}

function copyJobGroup(group: PipelineRunRowJobGroup): PipelineRunRowJobGroup {
  return {
    kind: group.kind,
    status: group.status,
    variant_job_ids: [...group.variant_job_ids],
    ...(group.started_at === undefined ? {} : { started_at: group.started_at }),
    ...(group.completed_at === undefined
      ? {}
      : { completed_at: group.completed_at }),
    ...(group.resolved_max_parallel === undefined
      ? {}
      : { resolved_max_parallel: group.resolved_max_parallel }),
  };
}

function mergeJobGroups(
  existing: PipelineRunRowState['job_groups'],
  incoming: PipelineRunRowState['job_groups'],
): PipelineRunRowState['job_groups'] {
  const merged: Record<string, PipelineRunRowJobGroup> = {};
  for (const [jobId, group] of Object.entries(existing)) {
    merged[jobId] = copyJobGroup(group);
  }
  for (const [jobId, group] of Object.entries(incoming)) {
    const prior = existing[jobId];
    merged[jobId] = {
      kind: group.kind,
      status: group.status,
      variant_job_ids: [...group.variant_job_ids],
      ...(group.started_at === undefined
        ? prior?.started_at === undefined
          ? {}
          : { started_at: prior.started_at }
        : { started_at: group.started_at }),
      ...(group.completed_at === undefined
        ? prior?.completed_at === undefined
          ? {}
          : { completed_at: prior.completed_at }
        : { completed_at: group.completed_at }),
      ...(group.resolved_max_parallel === undefined
        ? prior?.resolved_max_parallel === undefined
          ? {}
          : { resolved_max_parallel: prior.resolved_max_parallel }
        : { resolved_max_parallel: group.resolved_max_parallel }),
    };
  }
  return merged;
}

function hasJobStructure(state: ExecutionState): boolean {
  return (
    (state.job_definitions !== undefined && state.job_groups !== undefined) ||
    state.pipeline_snapshot?.jobs !== undefined
  );
}

export function mergePipelineRunRowEvent(
  existing: PipelineRunRowState | undefined,
  incoming: ExecutionState,
): PipelineRunRowState | undefined {
  if (hasJobStructure(incoming)) return toPipelineRunRowState(incoming);
  if (existing === undefined) return undefined;

  const update = toPipelineRunRowState(incoming);
  const statusReasons = update.status_reasons ?? existing.status_reasons;
  const pendingPauses = update.pending_pauses ?? existing.pending_pauses;
  const rerunContext = update.rerun_context ?? existing.rerun_context;
  const planId = update.planId ?? existing.planId;
  const rerunSourceId = update.rerun_source_id ?? existing.rerun_source_id;
  const eventName = update.event_name ?? existing.event_name;
  const triggerSource = update.trigger_source ?? existing.trigger_source;
  const inputsPersisted = update.inputs_persisted ?? existing.inputs_persisted;

  return {
    id: update.id,
    status: update.status,
    pipeline_snapshot: existing.pipeline_snapshot,
    jobs: mergeJobs(existing.jobs, update.jobs),
    job_groups: mergeJobGroups(existing.job_groups, update.job_groups),
    ...(planId === undefined ? {} : { planId }),
    ...(rerunSourceId === undefined ? {} : { rerun_source_id: rerunSourceId }),
    ...(eventName === undefined ? {} : { event_name: eventName }),
    ...(triggerSource === undefined ? {} : { trigger_source: triggerSource }),
    ...(statusReasons === undefined ? {} : { status_reasons: statusReasons }),
    ...(inputsPersisted === undefined
      ? {}
      : { inputs_persisted: inputsPersisted }),
    ...(rerunContext === undefined ? {} : { rerun_context: rerunContext }),
    ...(pendingPauses === undefined ? {} : { pending_pauses: pendingPauses }),
  };
}
