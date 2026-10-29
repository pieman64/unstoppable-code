import type { PipelineTriggerType } from '@canopy/desktop-shared/types/pipeline';
import {
  PIPELINE_FILTER_TRIGGERS,
  PIPELINE_TRIGGER_LABELS,
} from '@canopy/ui-shared/lib';

export interface TriggerMeta {
  label: string;
  description: string;
  badgeClass: string;
}

/**
 * Display metadata for each pipeline trigger type. The order in
 * {@link TRIGGER_TYPES} is the canonical order used to render the trigger
 * filter dropdown.
 */
export const TRIGGER_META: Record<PipelineTriggerType, TriggerMeta> = {
  dispatch: {
    label: PIPELINE_TRIGGER_LABELS.dispatch,
    description: 'Manually triggered via the UI or API',
    badgeClass: 'bg-accent-subtle fg-accent',
  },
  plan_ready: {
    label: PIPELINE_TRIGGER_LABELS.plan_ready,
    description: 'Runs when an agent plan is approved',
    badgeClass: 'bg-warning-subtle fg-warning',
  },
  task_ready: {
    label: PIPELINE_TRIGGER_LABELS.task_ready,
    description: 'Runs when a task definition is ready for planning',
    badgeClass: 'bg-info-subtle fg-info',
  },
};

export const TRIGGER_TYPES: readonly PipelineTriggerType[] =
  PIPELINE_FILTER_TRIGGERS;

export function getTriggerMeta(type: string): TriggerMeta | null {
  switch (type) {
    case 'dispatch':
      return TRIGGER_META.dispatch;
    case 'plan_ready':
      return TRIGGER_META.plan_ready;
    case 'task_ready':
      return TRIGGER_META.task_ready;
    default:
      return null;
  }
}
