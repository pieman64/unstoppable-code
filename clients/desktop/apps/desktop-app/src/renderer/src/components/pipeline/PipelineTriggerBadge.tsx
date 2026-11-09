import { type JSX } from 'react';
import { ActionTooltip } from '@canopy/ui-shared';
import type { PipelineTriggerType } from '@canopy/execution-engine/types/pipeline';
import {
  TriggerIcon,
  WorkflowIcon,
  type IconSize,
} from '@canopy/ui-shared/icons/AppIcons';
import { PlanModeIcon, TaskIcon } from '@canopy/ui-shared/icons';
import { getTriggerMeta } from './pipeline-trigger-meta';

interface TriggerBadgeProps {
  type: PipelineTriggerType;
}

interface PipelineTriggerTypeIconProps {
  type: PipelineTriggerType;
  size?: IconSize;
}

/**
 * Glyph for a pipeline trigger type. Shared so every surface that renders a
 * trigger uses the same icon vocabulary as the pipelines table.
 */
export function PipelineTriggerTypeIcon({
  type,
  size = 'sm',
}: PipelineTriggerTypeIconProps): JSX.Element {
  if (type === 'dispatch') return <TriggerIcon size={size} />;
  if (type === 'task_ready') return <TaskIcon size={size} />;
  if (type === 'workflow') return <WorkflowIcon size={size} />;
  return <PlanModeIcon size={size} />;
}

export function TriggerBadge({ type }: TriggerBadgeProps): JSX.Element {
  const meta = getTriggerMeta(type);

  if (!meta) {
    return <></>;
  }

  return (
    <ActionTooltip title={meta.label} description={meta.description}>
      <button
        type="button"
        aria-label={`${meta.label}: ${meta.description}`}
        className={`focus-ring shrink-0 inline-flex items-center justify-center w-5 h-5 rounded ${meta.badgeClass}`}
      >
        <PipelineTriggerTypeIcon type={type} />
      </button>
    </ActionTooltip>
  );
}
