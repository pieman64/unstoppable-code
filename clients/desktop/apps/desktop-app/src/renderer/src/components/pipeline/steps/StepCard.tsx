import type { JSX } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Step } from '@canopy/desktop-shared/types/pipeline';
import { PipelineDragHandleIcon } from './PipelinePanelPrimitives';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';

interface StepCardProps {
  step: Step;
  stepIndex: number;
  jobId: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  readonly?: boolean;
}

interface CategoryStyle {
  bg: string;
  text: string;
  label: string;
}

function getCategory(step: Step): CategoryStyle {
  if (step.uses) {
    return { bg: 'bg-info-subtle', text: 'fg-info', label: 'Action' };
  }
  if (step.run) {
    return { bg: 'bg-warning-subtle', text: 'fg-warning', label: 'Script' };
  }
  return {
    bg: 'bg-secondary',
    text: 'fg-secondary',
    label: 'Incomplete',
  };
}

function getSubtitle(step: Step): string {
  if (step.uses) {
    return step.uses;
  }
  if (step.run) {
    const firstLine = step.run.split('\n')[0];
    return firstLine || '';
  }
  return 'Not configured';
}

export function StepCard({
  step,
  stepIndex,
  jobId,
  selected,
  onSelect,
  onDelete,
  readonly = false,
}: StepCardProps): JSX.Element {
  const sortableId = `${jobId}:step:${stepIndex}`;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: sortableId,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const category = getCategory(step);
  const label = step.name || step.id || `Step ${stepIndex + 1}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={`card-surface flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-all ${
        selected
          ? 'ring-2 ring-line-accent border-line-accent'
          : 'hover:border-line-accent/30'
      }`}
    >
      {/* Drag handle */}
      {!readonly && (
        <button
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab active:cursor-grabbing p-0.5 fg-secondary hover:fg-primary touch-none"
          onClick={(e): void => e.stopPropagation()}
        >
          <PipelineDragHandleIcon />
        </button>
      )}

      {/* Step info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-s font-medium fg-primary truncate">
            {label}
          </span>
          <span
            className={`shrink-0 px-1.5 py-0.5 text-3xs font-medium rounded ${category.bg} ${category.text}`}
          >
            {category.label}
          </span>
        </div>
        {/* Action refs are recorded; a script's first line is blocked. */}
        <p
          className={`${step.uses ? '' : POSTHOG_REPLAY_BLOCK_CLASS} text-xs fg-secondary truncate mt-0.5`}
        >
          {getSubtitle(step)}
        </p>
      </div>

      {/* Delete */}
      {!readonly && (
        <button
          onClick={(e): void => {
            e.stopPropagation();
            onDelete();
          }}
          className="shrink-0 p-1 fg-secondary hover:fg-destructive transition-colors rounded"
        >
          <AppCatalogCloseIcon width="14" height="14" />
        </button>
      )}
    </div>
  );
}
