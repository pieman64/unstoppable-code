import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  openPipelineExecutionFromUi,
  type OpenPipelineExecutionResult,
} from '@/lib/panels/open-pipeline-execution';

interface OpenOverviewPipelineExecutionOptions {
  projectId: string;
  worktreeId: string;
  executionId: string;
  jobId?: string;
  markSeen?: boolean;
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Opens an Overview run (or one of its jobs) in the run's own panel. The
 * listed worktree is an owner hint the opener checks against the run, and
 * an unread run is marked seen. The Activity panel is left as it is.
 */
export function openOverviewPipelineExecution({
  projectId,
  worktreeId,
  executionId,
  jobId,
  markSeen,
}: OpenOverviewPipelineExecutionOptions): Promise<OpenPipelineExecutionResult> {
  if (markSeen) {
    usePipelineRunsStore
      .getState()
      .markWorktreePipelineSeen(worktreeKey(projectId, worktreeId));
  }

  return openPipelineExecutionFromUi({
    executionId,
    owner: { projectId, worktreeId },
    ...(jobId !== undefined ? { target: { jobId } } : {}),
  });
}
