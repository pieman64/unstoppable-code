import {
  API_PIPELINE_TRIGGER_TYPES,
  PIPELINE_EXECUTION_SCOPES,
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
};

/** Canonical render order for each filter dimension's options. */
export const PIPELINE_FILTER_SOURCES: readonly PipelineSourceBadgeKey[] =
  PIPELINE_SOURCE_BADGE_KEYS;
export const PIPELINE_FILTER_SCOPES: readonly PipelineExecutionScope[] =
  PIPELINE_EXECUTION_SCOPES;
export const PIPELINE_FILTER_TRIGGERS: readonly PipelineTriggerType[] =
  API_PIPELINE_TRIGGER_TYPES;
