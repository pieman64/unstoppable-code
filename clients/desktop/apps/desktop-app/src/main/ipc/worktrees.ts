import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type ArchiveWorktreeResponse,
  type ArchiveWorktreeRequest,
  type CreateWorktreeResponse,
  type CreateWorktreeRequest,
  type DiffStats,
  type DiffStatsRequest,
  type DiffStatsBatchRequest,
  type DiffStatsBatchResponseItem,
  type WorktreeHealthCheckRequest,
  type WorktreeHealthCheckResponse,
  type ListBranchesRequest,
  type ListBranchesResponse,
  type SwitchBranchRequest,
  type SwitchBranchResponse,
  type CreateBranchRequest,
  type CreateBranchResponse,
  type RenameBranchRequest,
  type RenameBranchResponse,
  type ScheduleTaskBranchNamingRequest,
  type SetWorktreeBranchGroupingRequest,
  type SetWorktreeHiddenRequest,
  type SetWorktreeLabelRequest,
  type SetWorktreePinnedRequest,
  type ReorderWorktreesRequest,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import {
  checkoutBranch,
  createBranchAndCheckout,
  getDiffStats,
  listBranches,
} from '../lib/git';
import { getWorkspaceWorktreeRepoDir } from '../lib/paths';
import { resolveFreshDefaultBranch } from '../lib/git-default-branch';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { scheduleBranchNaming } from '../lib/worktree-chat-turn';
import { validateAbsolutePath, validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import { registerIpcHandler } from './register';
import { archiveWorktree } from '../lib/worktree-archive';
import { assertMutuallyExclusiveWorktreeBaseSources } from './worktree-create-validation';
import { resolveEffectiveBaseBranchForRepo } from '../lib/worktree-base-branches';
import {
  aggregateMultiRepoDiffStats as aggregateMultiRepoDiffStatsService,
  getWorktreeStats,
} from '../lib/worktree-service';
import { createWorktreeFromSelection } from '../lib/worktree-creation';
import { resolveWorktreeCreationSelection } from '../lib/worktree-creation-selection';
import { mapWithConcurrency } from '../lib/concurrency';
import { retryWorktreeHealthCheck } from '../lib/worktree-health';
import { startProjectWorktreePostCreateSetup } from '../lib/project-worktree-runtime';
import { sendToWindow } from '../lib/window-send';
import {
  renameWorktreeBranch,
  WorktreeBranchRenameRefusedError,
} from '../lib/worktree-branch-rename';
import { moveWorktree, updateWorktree } from '../lib/worktree-update';
import { recordWorktreeCrudTelemetry } from '../lib/desktop-telemetry';
import { nudgeCodeGraphRefreshAfterDiffStats } from '../lib/code-graph-scheduler';
import { getForegroundWorktreeKey } from '../lib/github-poller';
import { getActiveChatIds } from '../agents/session-manager';
import {
  invalidateWorktreeDiffStats,
  primeWorktreeDiffStats,
  refreshWorktreeDiffStats,
  removeCachedWorktreeDiffStats,
} from '../services/worktree-diff-stats-cache';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';

function refreshCachedDiffStats(workspaceId: string, worktreeId: string): void {
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  invalidateWorktreeDiffStats(workspaceId, worktreeId);
  trackDetachedWork(() => refreshWorktreeDiffStats(workspaceId, worktreeId));
}

/**
 * The periodic diff-stats batch sweeps every worktree in every workspace; the
 * code-graph fingerprint nudge behind it runs several git subprocesses plus
 * dirty-file hashing per worktree. Restrict that background cost to worktrees
 * whose graph freshness can matter soon: the foreground (selected) worktree
 * and worktrees with an active or queued agent turn. Everything else gets its
 * graph refreshed when it next becomes foreground/active or when an agent
 * explicitly calls BuildOrUpdateCodeGraph.
 */
function shouldNudgeCodeGraphForWorktree(
  projectId: string,
  worktreeId: string,
): boolean {
  // Defensive: the nudge gate is best-effort and must never disturb the
  // diff-stats result it rides along with (the batch item's catch would
  // otherwise replace real stats with the zeroed fallback).
  try {
    if (getForegroundWorktreeKey() === `${projectId}/${worktreeId}`) {
      return true;
    }
    return getActiveChatIds(projectId, worktreeId).length > 0;
  } catch {
    return false;
  }
}

function validateOptionalRepoId(
  repoId: string | undefined,
  label = 'repoId',
): void {
  if (repoId !== undefined && repoId !== WORKSPACE_ROOT_REPO_ID) {
    validateId(repoId, label);
  }
}

function validateWorktreeOrder(
  worktreeOrder: string[] | undefined,
  label: string,
): void {
  if (!worktreeOrder) {
    return;
  }
  for (let index = 0; index < worktreeOrder.length; index += 1) {
    validateId(worktreeOrder[index], `${label}[${index}]`);
  }
}

// Each item fans out into several git subprocesses. Keep the outer batch
// serial so loading a large worktree fleet cannot synchronously spawn dozens
// of children in one main-process turn and starve IPC heartbeats.
const DIFF_STATS_BATCH_CONCURRENCY = 1;

function resolveWorktreeRepoPath(request: {
  projectId: string;
  worktreeId: string;
  repoId?: string;
}): string {
  if (request.repoId === WORKSPACE_ROOT_REPO_ID) {
    return resolveWorktreeCwd(request.projectId, request.worktreeId);
  }

  if (request.repoId) {
    return getWorkspaceWorktreeRepoDir(
      request.projectId,
      request.worktreeId,
      request.repoId,
    );
  }

  return resolveWorktreeCwd(request.projectId, request.worktreeId);
}

export function registerWorktreeHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  registerIpcHandler(
    IPC_CHANNELS.worktreeCreate,
    async (
      _event,
      request: CreateWorktreeRequest,
    ): Promise<CreateWorktreeResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      assertMutuallyExclusiveWorktreeBaseSources(request);
      if (request.baseWorktreeId) {
        validateId(request.baseWorktreeId, 'baseWorktreeId');
      }
      const response = (
        await createWorktreeFromSelection({
          workspaceId: request.projectId,
          workspaceKind: 'single-repo',
          ...resolveWorktreeCreationSelection(
            {
              baseWorktreeId: request.baseWorktreeId,
              baseBranch: request.baseBranch,
              existingBranch: request.existingBranch,
              branchName: request.branchName,
              suggestedBranch: request.suggestedBranch,
            },
            'single-repo',
          ),
          sidebarItemGroupId: request.sidebarItemGroupId,
          existingWorktreeIds: request.existingWorktreeIds,
          startPostCreateSetup: true,
          startProjectPostCreateSetup: startProjectWorktreePostCreateSetup,
          getWindow,
          deferGitSetup: true,
          onGitReady: (payload): void => {
            refreshCachedDiffStats(payload.projectId, payload.worktreeId);
            const window = getWindow();
            if (!window) {
              return;
            }
            sendToWindow(window, IPC_CHANNELS.worktreeGitReady, payload);
          },
          onGitFailed: (payload): void => {
            const window = getWindow();
            if (!window) {
              return;
            }
            sendToWindow(window, IPC_CHANNELS.worktreeGitFailed, payload);
          },
        })
      ).response;
      recordWorktreeCrudTelemetry({
        action: 'create',
        workspaceId: request.projectId,
        source: 'single_repo',
      });
      return response;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeScheduleTaskBranchNaming,
    (_event, request: ScheduleTaskBranchNamingRequest): void => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      if (request.chatId) {
        validateId(request.chatId, 'chatId');
      }
      validateOptionalRepoId(request.selectedRepoId, 'selectedRepoId');
      if (request.text.trim().length === 0) {
        return;
      }
      const cwd = resolveWorktreeCwd(request.projectId, request.worktreeId);
      scheduleBranchNaming({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        text: request.text,
        cwd,
        getWindow,
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeSetHidden,
    async (_event, request: SetWorktreeHiddenRequest): Promise<void> => {
      validateId(request.projectId, 'projectId');
      await updateWorktree({
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
        patch: { hidden: request.hidden },
      });
      recordWorktreeCrudTelemetry({
        action: 'update',
        workspaceId: request.projectId,
        source: 'hidden',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeReorder,
    async (_event, request: ReorderWorktreesRequest): Promise<void> => {
      await moveWorktree({
        workspaceId: request.workspaceId,
        activeWorktreeId: request.activeWorktreeId,
        overWorktreeId: request.overWorktreeId,
      });
      refreshCachedDiffStats(request.workspaceId, request.activeWorktreeId);
      refreshCachedDiffStats(request.workspaceId, request.overWorktreeId);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeSetLabel,
    async (_event, request: SetWorktreeLabelRequest): Promise<void> => {
      validateId(request.projectId, 'projectId');
      await updateWorktree({
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
        patch: { label: request.label ?? null },
      });
      recordWorktreeCrudTelemetry({
        action: 'update',
        workspaceId: request.projectId,
        source: 'label',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeSetPinned,
    async (_event, request: SetWorktreePinnedRequest): Promise<void> => {
      validateId(request.projectId, 'projectId');
      await updateWorktree({
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
        patch: { pinned: request.pinned },
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeSetBranchGrouping,
    async (
      _event,
      request: SetWorktreeBranchGroupingRequest,
    ): Promise<void> => {
      validateId(request.projectId, 'projectId');
      await updateWorktree({
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
        patch: { branchGroupingOverride: request.override },
        ...(request.worktreeOrder
          ? { worktreeOrder: request.worktreeOrder }
          : {}),
      });
      recordWorktreeCrudTelemetry({
        action: 'update',
        workspaceId: request.projectId,
        source: 'branch-grouping',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeArchive,
    async (
      _event,
      request: ArchiveWorktreeRequest,
    ): Promise<ArchiveWorktreeResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      validateAbsolutePath(request.repoPath, 'repoPath');
      validateWorktreeOrder(
        request.remainingWorktreeOrder,
        'remainingWorktreeOrder',
      );
      validateWorktreeOrder(
        request.expectedRemainingWorktreeOrder,
        'expectedRemainingWorktreeOrder',
      );

      const response = await archiveWorktree({
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
        source: 'single_repo',
        expectedKind: 'single-repo',
        expectedCreatedAt: request.expectedCreatedAt,
        expectedBranchName: request.expectedBranchName,
        deleteBranch: request.deleteBranch,
        lockAfterArchive: request.lockAfterArchive,
        deleteWithoutRetentionIfMissing:
          request.deleteWithoutRetentionIfMissing,
        remainingWorktreeOrder: request.remainingWorktreeOrder,
        expectedRemainingWorktreeOrder: request.expectedRemainingWorktreeOrder,
        repoPath: request.repoPath,
      });
      removeCachedWorktreeDiffStats(request.projectId, request.worktreeId);
      return response;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeDiffStats,
    async (_event, request: DiffStatsRequest): Promise<DiffStats> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');

      const worktreePath = resolveWorktreeCwd(
        request.projectId,
        request.worktreeId,
      );

      if (isMultiRepoWorkspace(request.projectId)) {
        const result = await aggregateMultiRepoDiffStatsService(
          request.projectId,
          request.worktreeId,
          worktreePath,
        );
        nudgeCodeGraphRefreshAfterDiffStats(
          request.projectId,
          request.worktreeId,
        );
        return result.stats;
      }

      const effectiveBaseBranch = await resolveEffectiveBaseBranchForRepo({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        repoPath: worktreePath,
      });
      const stats = await getDiffStats(
        worktreePath,
        effectiveBaseBranch.branch ?? undefined,
      );
      nudgeCodeGraphRefreshAfterDiffStats(
        request.projectId,
        request.worktreeId,
      );
      return stats;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeDiffStatsBatch,
    async (
      _event,
      request: DiffStatsBatchRequest,
    ): Promise<DiffStatsBatchResponseItem[]> => {
      const results = await mapWithConcurrency(
        request.worktrees,
        DIFF_STATS_BATCH_CONCURRENCY,
        async (worktree): Promise<DiffStatsBatchResponseItem> => {
          try {
            validateId(worktree.projectId, 'projectId');
            validateId(worktree.worktreeId, 'worktreeId');
            if (worktree.mode === 'diff_only') {
              const cached = await refreshWorktreeDiffStats(
                worktree.projectId,
                worktree.worktreeId,
              );
              return {
                projectId: worktree.projectId,
                worktreeId: worktree.worktreeId,
                insertions: cached?.insertions ?? 0,
                deletions: cached?.deletions ?? 0,
                mode: 'diff_only',
              };
            }
            const stats = await getWorktreeStats(
              worktree.projectId,
              worktree.worktreeId,
              {
                skipFetch: request.skipFetch,
                source: request.source ?? 'user-explicit',
              },
            );
            primeWorktreeDiffStats(worktree.projectId, worktree.worktreeId, {
              insertions: stats.insertions,
              deletions: stats.deletions,
            });
            if (
              shouldNudgeCodeGraphForWorktree(
                worktree.projectId,
                worktree.worktreeId,
              )
            ) {
              nudgeCodeGraphRefreshAfterDiffStats(
                worktree.projectId,
                worktree.worktreeId,
              );
            }
            return stats;
          } catch {
            return {
              projectId: worktree.projectId,
              worktreeId: worktree.worktreeId,
              insertions: 0,
              deletions: 0,
              ...(worktree.mode === 'diff_only'
                ? { mode: 'diff_only' as const }
                : {}),
            };
          }
        },
      );

      return results;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeHealthCheck,
    async (
      _event,
      request: WorktreeHealthCheckRequest,
    ): Promise<WorktreeHealthCheckResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      return retryWorktreeHealthCheck(request.projectId, request.worktreeId);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeRenameBranch,
    async (
      _event,
      request: RenameBranchRequest,
    ): Promise<RenameBranchResponse> => {
      validateId(request.projectId, 'projectId');
      try {
        await renameWorktreeBranch({
          source: 'desktop',
          workspaceId: request.projectId,
          worktreeId: request.worktreeId,
          ...(request.repoId !== undefined ? { repoId: request.repoId } : {}),
          newBranchName: request.newBranchName,
        });
      } catch (error) {
        // The checkout's branch was renamed even when its row is gone.
        if (
          error instanceof WorktreeBranchRenameRefusedError &&
          error.reason === 'not-found'
        ) {
          refreshCachedDiffStats(request.projectId, request.worktreeId);
        }
        throw error;
      }
      refreshCachedDiffStats(request.projectId, request.worktreeId);

      return { success: true, newBranchName: request.newBranchName };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeListBranches,
    async (
      _event,
      request: ListBranchesRequest,
    ): Promise<ListBranchesResponse> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateOptionalRepoId(request.repoId);

      return listBranches(resolveWorktreeRepoPath(request), {
        resolveDefaultBranch: resolveFreshDefaultBranch,
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeSwitchBranch,
    async (
      _event,
      request: SwitchBranchRequest,
    ): Promise<SwitchBranchResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      validateOptionalRepoId(request.repoId);

      await checkoutBranch(
        resolveWorktreeRepoPath(request),
        request.branchName,
      );
      refreshCachedDiffStats(request.projectId, request.worktreeId);

      return { success: true, branchName: request.branchName };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeCreateBranch,
    async (
      _event,
      request: CreateBranchRequest,
    ): Promise<CreateBranchResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      validateOptionalRepoId(request.repoId);

      const newBranchName = request.newBranchName.trim();
      if (!newBranchName || newBranchName.startsWith('-')) {
        throw new Error('Invalid new branch name');
      }

      const baseBranch = (request.baseBranch ?? '').trim();
      if (!baseBranch || baseBranch.startsWith('-')) {
        throw new Error('Invalid base branch');
      }

      const startPoint = request.baseBranchIsRemote
        ? `origin/${baseBranch}`
        : baseBranch;
      const branchName = await createBranchAndCheckout(
        resolveWorktreeRepoPath(request),
        newBranchName,
        startPoint,
      );
      refreshCachedDiffStats(request.projectId, request.worktreeId);

      return { success: true, branchName };
    },
  );
}
