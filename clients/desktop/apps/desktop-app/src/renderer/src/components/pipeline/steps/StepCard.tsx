import type { JSX } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Step } from '@canopy/execution-engine/types/pipeline';
import { PipelineStepRow } from '@canopy/ui-app';
import { Button } from '@canopy/ui-shared/components';
import {
  CloseIcon as AppCatalogCloseIcon,
  DragHandleIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { stepKind, stepLabel, stepSummary } from './stepDisplay';

interface StepCardProps {
  step: Step;
  stepIndex: number;
  jobId: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  readonly?: boolean;
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
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `${jobId}:step:${stepIndex}`,
  });

  return (
    <PipelineStepRow
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      name={stepLabel(step, stepIndex)}
      kind={stepKind(step)}
      summary={stepSummary(step)}
      selected={selected}
      onSelect={onSelect}
      actions={
        readonly ? undefined : (
          <>
            <button
              {...attributes}
              {...listeners}
              aria-label="Reorder step"
              className="focus-ring flex size-7 items-center justify-center rounded-full cursor-grab active:cursor-grabbing fg-secondary hover:fg-primary touch-none"
            >
              <DragHandleIcon size="sm" />
            </button>
            <Button
              variant="ghost-quiet"
              size="compact"
              iconOnly
              onClick={onDelete}
              aria-label="Delete step"
            >
              <AppCatalogCloseIcon size="sm" />
            </Button>
          </>
        )
      }
    />
  );
}
