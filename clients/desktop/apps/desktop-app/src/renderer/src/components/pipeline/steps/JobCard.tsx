import { type JSX, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import type { Job, Step } from '@canopy/desktop-shared/types/pipeline';
import { normalizeNeeds } from '@canopy/desktop-shared/types/pipeline';
import type { Selection } from '../../../hooks/usePipelineEditor';
import { Badge, Count } from '@canopy/ui-shared/components';
import { StepCard } from './StepCard';
import { DragHandleIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Button } from '@canopy/ui-shared/components';
import {
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
  PlusIcon as AppCatalogPlusIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { EmptyStateRow } from '@canopy/ui-shared/components';

interface JobCardProps {
  jobId: string;
  job: Job;
  selection: Selection;
  onSelectJob: (jobId: string) => void;
  onSelectStep: (jobId: string, stepIndex: number) => void;
  onAddStep: (jobId: string) => void;
  onDeleteStep: (jobId: string, stepIndex: number) => void;
  readonly?: boolean;
}

export function JobCard({
  jobId,
  job,
  selection,
  onSelectJob,
  onSelectStep,
  onAddStep,
  onDeleteStep,
  readonly = false,
}: JobCardProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);

  const isSelected = selection.type === 'job' && selection.jobId === jobId;

  const needs: string[] = normalizeNeeds(job.needs);

  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `job:${jobId}`,
    data: { type: 'job', jobId },
  });

  const { setNodeRef: setDropRef } = useDroppable({
    id: `job-drop:${jobId}`,
    data: { type: 'job-drop', jobId },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const sortableStepIds: string[] = job.steps.map(
    (_: Step, i: number): string => `${jobId}:step:${i}`,
  );

  return (
    <div
      ref={setSortableRef}
      style={style}
      className={`border rounded-lg overflow-hidden transition-[border-color,box-shadow,opacity] ${
        isSelected
          ? 'border-line-accent ring-1 ring-line-accent'
          : 'hover:border-line-accent/30'
      }`}
    >
      {/* Job header */}
      <div
        onClick={() => onSelectJob(jobId)}
        className="flex items-center gap-2 px-3 py-2 bg-secondary/50 cursor-pointer"
      >
        {/* Drag handle */}
        {!readonly && (
          <button
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab active:cursor-grabbing p-0.5 fg-secondary hover:fg-primary touch-none"
            onClick={(e) => e.stopPropagation()}
          >
            <DragHandleIcon size="sm" />
          </button>
        )}

        {/* Collapse toggle */}
        <Button
          variant="ghost-quiet"
          size="compact"
          iconOnly
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed(!collapsed);
          }}
          aria-label={collapsed ? 'Expand job' : 'Collapse job'}
          aria-expanded={!collapsed}
        >
          <AppCatalogChevronRightMediumIcon
            size="sm"
            className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
        </Button>

        {/* Job name */}
        <span className="text-s font-medium fg-primary truncate flex-1">
          {job.name || jobId}
        </span>

        {/* Dependency pills */}
        {needs.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            {needs.map((dep: string) => (
              <Badge key={dep}>{dep}</Badge>
            ))}
          </div>
        )}

        {/* Step count badge */}
        <Count value={job.steps.length} className="shrink-0" />

        {/* Add step button */}
        {!readonly && (
          <Button
            variant="ghost-quiet"
            size="compact"
            iconOnly
            onClick={(e) => {
              e.stopPropagation();
              onAddStep(jobId);
            }}
            aria-label="Add step"
          >
            <AppCatalogPlusIcon size="sm" />
          </Button>
        )}
      </div>

      {/* Job body (steps) */}
      {!collapsed && (
        <div ref={setDropRef} className="px-2 py-2 space-y-1.5 min-h-10">
          {job.steps.length === 0 ? (
            <EmptyStateRow title="No steps yet" />
          ) : (
            <SortableContext
              items={sortableStepIds}
              strategy={verticalListSortingStrategy}
            >
              {job.steps.map((step: Step, index: number) => (
                <StepCard
                  key={sortableStepIds[index]}
                  step={step}
                  stepIndex={index}
                  jobId={jobId}
                  selected={
                    selection.type === 'step' &&
                    selection.jobId === jobId &&
                    selection.stepIndex === index
                  }
                  onSelect={() => onSelectStep(jobId, index)}
                  onDelete={() => onDeleteStep(jobId, index)}
                  readonly={readonly}
                />
              ))}
            </SortableContext>
          )}
        </div>
      )}
    </div>
  );
}
