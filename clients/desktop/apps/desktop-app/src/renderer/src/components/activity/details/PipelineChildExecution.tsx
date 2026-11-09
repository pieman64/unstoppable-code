import type { ExecutionSummary } from '@canopy/execution-engine/types/pipeline';
import type { JSX } from 'react';
import { Tooltip } from '@canopy/ui-shared';
import { MaximizeIcon as AppCatalogMaximizeIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Button, Disclosure } from '@canopy/ui-shared/components';

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
  // The drill-in action sits at the end of the toggle's row, centred on it,
  // while the child run opens full width under both.
  return (
    <div className="relative">
      <Disclosure
        open={expanded}
        onOpenChange={onToggle}
        label={child.pipeline_name}
        dataTestId={`pipeline-step-child-${stepId}`}
      >
        {renderChildExecution(child.id)}
      </Disclosure>
      {onDrillIntoChild !== undefined && (
        <div className="absolute -top-1 right-0">
          <Tooltip label="Open in full view">
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={(): void =>
                onDrillIntoChild(child.id, child.pipeline_name)
              }
              aria-label={`Open ${child.pipeline_name} in full view`}
              data-testid={`pipeline-step-drill-${stepId}`}
            >
              <AppCatalogMaximizeIcon size="sm" aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
