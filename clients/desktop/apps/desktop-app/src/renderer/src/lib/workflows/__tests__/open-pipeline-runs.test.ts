import { EMPTY_WORKFLOW_RUN_FILTERS } from '@canopy/ui-app/workflows';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import { openPipelineRuns } from '../open-pipeline-runs';

describe('openPipelineRuns', () => {
  it('narrows the Runs feed to the pipeline and opens Workflows', () => {
    const navigate = jest
      .spyOn(useNavigationStore.getState(), 'navigate')
      .mockImplementation(() => {});
    useWorkflowsViewStore.getState().setRunsScrollTop(120);

    openPipelineRuns('Nightly build');

    const view = useWorkflowsViewStore.getState();
    expect(view.runsQuery).toBe('Nightly build');
    expect(view.runsFilters).toEqual({
      ...EMPTY_WORKFLOW_RUN_FILTERS,
      kind: 'pipeline',
    });
    expect(view.runsScrollTop).toBe(0);
    expect(navigate).toHaveBeenCalledWith('workflows');
    navigate.mockRestore();
  });
});
