import type { JSX } from 'react';
import { useNavigationStore } from '@/stores/navigationStore';
import type { AutomationsPageBodyApi } from '../../../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../../../pages/PipelinesPage';
import { WorkflowEditHost } from '../WorkflowEditHost';

export interface PipelineShellHarnessProps {
  readonly pipelines: PipelinesPageListApi;
  readonly automations: AutomationsPageBodyApi;
}

/**
 * What `WorkflowsPage` draws for the pipeline edit shell suites (CAN-4072):
 * the shell while the navigation store has a target, else the Library.
 */
export function PipelineShellHarness({
  pipelines,
  automations,
}: PipelineShellHarnessProps): JSX.Element {
  const target = useNavigationStore((state) => state.workflowEdit);
  return target ? (
    <WorkflowEditHost
      target={target}
      pipelines={pipelines}
      automations={automations}
    />
  ) : (
    <div data-testid="harness-library" />
  );
}
