import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  WORKTREE_SUMMARY_BATCH_SIZE_LIMIT,
  type WorktreeSummaryData,
  type WorktreeSummaryLoadBatchRequest,
  type WorktreeSummaryLoadBatchResponse,
  type WorktreeSummaryLoadRequest,
  type WorktreeSummaryRefreshRequest,
} from '@canopy/desktop-shared/types';
import { readWorktreeSummary } from '../lib/worktree-summary-persistence';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';
import { refreshWorktreeSummary } from '../services/worktree-summary-service';

const SUMMARY_BATCH_CONCURRENCY = 8;

function summaryKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

async function readWorktreeSummaryBatch(
  requests: WorktreeSummaryLoadRequest[],
): Promise<WorktreeSummaryLoadBatchResponse> {
  const uniqueRequests = Array.from(
    new Map(
      requests.map((request) => [
        summaryKey(request.projectId, request.worktreeId),
        request,
      ]),
    ).values(),
  );
  const response: WorktreeSummaryLoadBatchResponse = {};
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < uniqueRequests.length) {
      const request = uniqueRequests[nextIndex];
      nextIndex += 1;
      if (!request) {
        return;
      }
      response[summaryKey(request.projectId, request.worktreeId)] =
        await readWorktreeSummary(request.projectId, request.worktreeId);
    }
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(SUMMARY_BATCH_CONCURRENCY, uniqueRequests.length),
      },
      () => worker(),
    ),
  );
  return response;
}

export function registerWorktreeSummaryHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  registerIpcHandler<[WorktreeSummaryLoadRequest], WorktreeSummaryData | null>(
    IPC_CHANNELS.worktreeSummaryLoad,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      // Cowork workspaces have summaries too (workspaces/{id}/summaries/
      // home.json); the scheduler summarizes folder activity instead of git
      // diffs for them.
      return readWorktreeSummary(request.projectId, request.worktreeId);
    },
  );

  registerIpcHandler<
    [WorktreeSummaryLoadBatchRequest],
    WorktreeSummaryLoadBatchResponse
  >(IPC_CHANNELS.worktreeSummaryLoadBatch, async (_event, request) => {
    if (
      !request ||
      !Array.isArray(request.worktrees) ||
      request.worktrees.length > WORKTREE_SUMMARY_BATCH_SIZE_LIMIT
    ) {
      throw new Error('invalid-summary-batch');
    }
    for (const worktree of request.worktrees) {
      validateId(worktree.projectId, 'projectId');
      validateId(worktree.worktreeId, 'worktreeId');
    }
    return readWorktreeSummaryBatch(request.worktrees);
  });

  registerIpcHandler<[WorktreeSummaryRefreshRequest], void>(
    IPC_CHANNELS.worktreeSummaryRefresh,
    (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      refreshWorktreeSummary(request.projectId, request.worktreeId, getWindow);
    },
  );
}
