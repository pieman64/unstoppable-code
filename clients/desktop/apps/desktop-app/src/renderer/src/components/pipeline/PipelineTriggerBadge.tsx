import { type JSX, useId } from 'react';
import type { PipelineTriggerType } from '@canopy/desktop-shared/types/pipeline';
import { TriggerIcon } from '@canopy/ui-shared/icons/AppIcons';
import { PlanModeIcon, TaskIcon } from '@canopy/ui-shared/icons';
import { getTriggerMeta } from './pipeline-trigger-meta';

interface TriggerBadgeProps {
  type: PipelineTriggerType;
}

interface PipelineTriggerTypeIconProps {
  type: PipelineTriggerType;
  size?: number;
}

/**
 * Glyph for a pipeline trigger type. Shared so every surface that renders a
 * trigger uses the same icon vocabulary as the pipelines table.
 */
export function PipelineTriggerTypeIcon({
  type,
  size = 12,
}: PipelineTriggerTypeIconProps): JSX.Element {
  if (type === 'dispatch') return <TriggerIcon width={size} height={size} />;
  if (type === 'task_ready') return <TaskIcon width={size} height={size} />;
  return <PlanModeIcon width={size} height={size} />;
}

export function TriggerBadge({ type }: TriggerBadgeProps): JSX.Element {
  const meta = getTriggerMeta(type);
  const tooltipId = useId();

  if (!meta) {
    return <></>;
  }

  return (
    <span className="relative inline-flex group/trigger">
      <button
        type="button"
        aria-describedby={tooltipId}
        aria-label={`${meta.label}: ${meta.description}`}
        className={`focus-ring shrink-0 inline-flex items-center justify-center w-5 h-5 rounded ${meta.badgeClass}`}
      >
        <PipelineTriggerTypeIcon type={type} />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5
          hidden group-hover/trigger:flex group-focus-within/trigger:flex flex-col items-center
          w-max max-w-48 px-2.5 py-1.5 rounded-md
          bg-popover shadow-tooltip fg-primary
          z-dropdown"
      >
        <span className="text-2xs font-medium leading-tight">{meta.label}</span>
        <span className="text-3xs fg-secondary leading-snug mt-0.5">
          {meta.description}
        </span>
      </span>
    </span>
  );
}
