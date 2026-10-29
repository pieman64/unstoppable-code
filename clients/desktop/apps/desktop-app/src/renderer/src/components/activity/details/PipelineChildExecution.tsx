import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import type { JSX } from 'react';
import { DetailChevronIcon } from './DetailChevronIcon';
import { Tooltip } from '@canopy/ui-shared';
import { MaximizeIcon as AppCatalogMaximizeIcon } from '@canopy/ui-shared/icons/AppIcons';

function EnlargeIcon(): JSX.Element {
  return <AppCatalogMaximizeIcon width="14" height="14" aria-hidden="true" />;
}

interface PipelineChildExecutionProps {
  child: ExecutionSummary;
  stepId: string;
  expanded: boolean;
  onToggle: () => void;
  renderChildExecution: (executionId: string) => JSX.Element;
  onDrillIntoChild?: (childExecutionId: string, label: string) => void;
}

/**
 * Inline nested-pipeline controls shared by ordinary and matrix-variant steps.
 * Keeping one renderer preserves the same breadcrumb behavior for both.
 */
export function PipelineChildExecution({
  child,
  stepId,
  expanded,
  onToggle,
  renderChildExecution,
  onDrillIntoChild,
}: PipelineChildExecutionProps): JSX.Element {
  return (
    <>
      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-center gap-1 rounded-md px-2.5 py-1 text-2xs fg-info/80 transition hover:bg-fg-primary/[0.04] hover:fg-info"
        >
          <DetailChevronIcon open={expanded} />
          {child.pipeline_name}
        </button>
        {onDrillIntoChild !== undefined && (
          <Tooltip label="Open in full view">
            <button
              type="button"
              onClick={(): void =>
                onDrillIntoChild(child.id, child.pipeline_name)
              }
              aria-label={`Open ${child.pipeline_name} in full view`}
              data-testid={`pipeline-step-drill-${stepId}`}
              className="focus-ring shrink-0 rounded-md border bg-fg-primary/[0.04] p-1 fg-secondary transition hover:bg-fg-primary/[0.08] hover:fg-primary/80"
            >
              <EnlargeIcon />
            </button>
          </Tooltip>
        )}
      </div>
      {expanded && renderChildExecution(child.id)}
    </>
  );
}
