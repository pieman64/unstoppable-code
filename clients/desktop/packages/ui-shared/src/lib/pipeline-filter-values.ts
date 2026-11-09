import {
  PIPELINE_EXECUTION_SCOPES,
  PORTABLE_PIPELINE_TRIGGER_TYPES,
  type PipelineExecutionScope,
  type PipelineTriggerType,
} from '@canopy/protocol/pipelines';
import {
  PIPELINE_SOURCE_BADGE_KEYS,
  type PipelineSourceBadgeKey,
} from './pipeline-source-badges';

/** The Marketplace Pipelines tab's filters; `'all'` leaves a dimension open. */
export interface PipelineFilterValues {
  readonly source: PipelineSourceBadgeKey | 'all';
  readonly scope: PipelineExecutionScope | 'all';
  readonly trigger: PipelineTriggerType | 'all';
}

export const DEFAULT_PIPELINE_FILTERS: PipelineFilterValues = {
  source: 'all',
  scope: 'all',
  trigger: 'all',
};

/** Field-wise, so a filter set back to Any counts as unfiltered again. */
export function pipelineFiltersActive(values: PipelineFilterValues): boolean {
  return (
    values.source !== 'all' ||
    values.scope !== 'all' ||
    values.trigger !== 'all'
  );
}

export const PIPELINE_SOURCE_LABELS: Readonly<
  Record<PipelineSourceBadgeKey, string>
> = {
  user: 'Custom',
  project: 'Project',
  bundled: 'Bundled',
  shared: 'Shared',
  curated: 'Curated',
};

export const PIPELINE_EXECUTION_SCOPE_LABELS: Readonly<
  Record<PipelineExecutionScope, string>
> = {
  global: 'Global',
  directory: 'Directory',
  worktree: 'Worktree',
};

export const PIPELINE_TRIGGER_LABELS: Readonly<
  Record<PipelineTriggerType, string>
> = {
  dispatch: 'Dispatch',
  plan_ready: 'Plan ready',
  task_ready: 'Task ready',
  workflow: 'Workflow',
};

/** Canonical render order for each filter dimension's options. */
export const PIPELINE_FILTER_SOURCES: readonly PipelineSourceBadgeKey[] =
  PIPELINE_SOURCE_BADGE_KEYS;
export const PIPELINE_FILTER_SCOPES: readonly PipelineExecutionScope[] =
  PIPELINE_EXECUTION_SCOPES;
// The Portal and Customize list only triggers that travel, so they never
// offer a `workflow` filter that could not match (CAN-5782). Desktop
// surfaces that can show `workflow` list it themselves.
export const PIPELINE_FILTER_TRIGGERS: readonly PipelineTriggerType[] =
  PORTABLE_PIPELINE_TRIGGER_TYPES;
