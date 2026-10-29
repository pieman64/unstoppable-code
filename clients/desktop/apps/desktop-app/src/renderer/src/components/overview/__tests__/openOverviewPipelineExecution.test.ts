/** @jest-environment jsdom */
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { openOverviewPipelineExecution } from '../openOverviewPipelineExecution';

const openPipelineExecutionFromUi = jest.fn(() =>
  Promise.resolve({ status: 'applied' }),
);

jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: unknown): Promise<unknown> =>
    openPipelineExecutionFromUi(request),
}));

describe('openOverviewPipelineExecution', () => {
  const markWorktreePipelineSeen = jest.fn();

  beforeEach(() => {
    openPipelineExecutionFromUi.mockClear();
    markWorktreePipelineSeen.mockClear();
    usePipelineRunsStore.setState({ markWorktreePipelineSeen });
    useActivityStore.setState({ panelExpanded: false });
    useChatStore.setState({ selectedWorktree: null });
  });

  it('opens the run panel at the clicked job with the listed owner as a hint', async () => {
    await openOverviewPipelineExecution({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      executionId: 'run-1',
      jobId: 'deploy',
      markSeen: true,
    });

    expect(markWorktreePipelineSeen).toHaveBeenCalledWith(
      'project-1/worktree-1',
    );
    expect(openPipelineExecutionFromUi).toHaveBeenCalledWith({
      executionId: 'run-1',
      owner: { projectId: 'project-1', worktreeId: 'worktree-1' },
      target: { jobId: 'deploy' },
    });
    // Navigation belongs to the opener; the Activity panel is left alone.
    expect(useActivityStore.getState().panelExpanded).toBe(false);
    expect(useChatStore.getState().selectedWorktree).toBeNull();
  });

  it('opens a read run without a job and without marking it seen', async () => {
    await openOverviewPipelineExecution({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      executionId: 'run-1',
    });

    expect(markWorktreePipelineSeen).not.toHaveBeenCalled();
    expect(openPipelineExecutionFromUi).toHaveBeenCalledWith({
      executionId: 'run-1',
      owner: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
  });
});
