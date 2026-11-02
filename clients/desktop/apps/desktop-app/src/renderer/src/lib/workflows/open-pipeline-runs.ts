import { EMPTY_WORKFLOW_RUN_FILTERS } from '@canopy/ui-app/workflows';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';

/**
 * Opens a pipeline's runs: the Workflows Runs feed narrowed to its name.
 * Executions carry no locator that tells same-named pipelines apart.
 */
export function openPipelineRuns(name: string): void {
  const view = useWorkflowsViewStore.getState();
  view.setRunsScrollTop(0);
  view.setRunsQuery(name);
  view.setRunsFilters({ ...EMPTY_WORKFLOW_RUN_FILTERS, kind: 'pipeline' });
  useNavigationStore.getState().navigate('workflows');
}
