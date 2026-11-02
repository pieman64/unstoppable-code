import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';
import type { PipelineExecutionScope } from '@canopy/protocol/pipelines';
import type {
  PipelineRepoChoice,
  PipelinePluginCollectionRunContext,
} from '@/components/activity/PipelineTriggerModal';
import type { PipelineWatcherSelection } from '@/components/activity/usePipelineRunWatcher';
import { extractIpcErrorMessage } from '@/lib/errors';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';

/**
 * Resolved launch target for a `task_ready` pipeline run, decoupled from
 * worktree provisioning (Plan C / Task C4):
 *
 * - `new-worktree` — provisions a fresh worktree, then defers task-branch
 *   naming and the pipeline run itself until `worktree:git-ready`.
 * - `branch` — provisions a worktree from an existing branch (which already
 *   has a name), then defers the pipeline run the same way. No task-branch
 *   naming.
 * - `worktree` — runs immediately against an existing worktree's checkout.
 *   No worktree provisioning.
 * - `cowork` — runs immediately against the cowork workspace's root
 *   (`directory` execution scope). No worktree provisioning.
 */
export type TaskReadyPipelineLaunchTarget =
  | { kind: 'new-worktree'; baseWorktreeId?: string; baseBranch?: string }
  | { kind: 'branch'; branchName: string }
  | { kind: 'worktree'; worktreeId: string }
  | { kind: 'cowork' };

export interface TaskReadyPipelineLaunchContext {
  workspaceId: string;
  taskText: string;
  cwd: string;
  repoChoices: PipelineRepoChoice[];
  target: TaskReadyPipelineLaunchTarget;
  /**
   * Execution-scope filter hint passed straight through to
   * `TaskReadyPipelineModal`/`PipelineTriggerModal`. `worktree` for
   * `new-worktree`/`branch`/`worktree` targets (all resolve to a concrete
   * worktree-shaped checkout); `directory` for `cowork` (no worktree
   * concept).
   */
  executionScope: PipelineExecutionScope;
}

export interface UseTaskReadyPipelineLauncherResult {
  /** Set once `open` successfully resolves a cwd; renders `TaskReadyPipelineModal`. */
  ctx: TaskReadyPipelineLaunchContext | null;
  running: boolean;
  runError: string | null;
  watcherSelection: PipelineWatcherSelection | null;
  setWatcherSelection: Dispatch<
    SetStateAction<PipelineWatcherSelection | null>
  >;
  /**
   * Resolves a cwd for `target` and, if resolved, opens the pipeline picker
   * context. Returns `false` without any state change when the target can't
   * be resolved (e.g. an unknown workspace, a `worktree` target whose
   * worktree no longer exists, or a `cowork` target for a non-cowork
   * workspace) — callers use the return value to decide whether to also
   * dismiss their own "choose a task type" UI.
   */
  open: (
    workspaceId: string,
    taskText: string,
    target: TaskReadyPipelineLaunchTarget,
  ) => Promise<boolean>;
  /** No-ops while a run is in flight, matching the original inline handler. */
  close: () => void;
  /**
   * Runs the pipeline per `ctx.target.kind`:
   *
   * - `new-worktree` / `branch`: creates the worktree (from an existing
   *   branch for `branch`) and enqueues both the pipeline run and (only for
   *   `new-worktree`) task-branch naming, deferred until
   *   `worktree:git-ready` since the worktree directory does not exist on
   *   disk yet.
   * - `worktree` / `cowork`: runs the pipeline immediately via
   *   `window.pipelines.execute` against the already-resolved `ctx.cwd` — no
   *   worktree provisioning, no deferred enqueue.
   */
  /**
   * Resolves `true` only when the run was genuinely dispatched (immediate
   * execute succeeded, or the deferred enqueue registered); `false` leaves
   * the modal open showing `runError`, so callers must not treat the click
   * as consumed (e.g. the Home onboarding task-plan preset stays staged).
   */
  run: (
    pipelineId: string,
    pipeline: PipelineData,
    inputs: Record<string, string> | undefined,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
  ) => Promise<boolean>;
}

/**
 * Extracted from `WorktreeManager`'s `handleChoosePipeline` /
 * `handleTaskPipelineRun` (task_ready trigger) so the Home surface's
 * pipeline-mode send can open and run the `task_ready` pipeline picker flow
 * without duplicating the cwd-resolution and deferred-enqueue logic.
 */
export function useTaskReadyPipelineLauncher(): UseTaskReadyPipelineLauncherResult {
  const projects = useProjectsStore((state) => state.projects);
  const [ctx, setCtx] = useState<TaskReadyPipelineLaunchContext | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [watcherSelection, setWatcherSelection] =
    useState<PipelineWatcherSelection | null>(null);

  const open = useCallback(
    async (
      workspaceId: string,
      taskText: string,
      target: TaskReadyPipelineLaunchTarget,
    ): Promise<boolean> => {
      const workspace = projects.find((p) => p.id === workspaceId);
      if (!workspace) return false;

      if (target.kind === 'cowork') {
        if (workspace.type !== 'cowork') return false;

        let cwd: string;
        try {
          cwd = await window.api.homeGetCoworkRoot({ workspaceId });
        } catch {
          return false;
        }
        if (!cwd) return false;

        setRunError(null);
        setCtx({
          workspaceId,
          taskText,
          cwd,
          repoChoices: [],
          target,
          executionScope: 'directory',
        });
        return true;
      }

      if (workspace.type === 'cowork') return false;

      if (target.kind === 'worktree') {
        const worktreeExists = workspace.worktrees.some(
          (worktree) => worktree.id === target.worktreeId,
        );
        if (!worktreeExists) return false;

        let cwd: string;
        try {
          cwd = await window.api.getWorktreePath({
            projectId: workspaceId,
            worktreeId: target.worktreeId,
          });
        } catch {
          return false;
        }
        if (!cwd) return false;

        setRunError(null);
        setCtx({
          workspaceId,
          taskText,
          cwd,
          repoChoices: [],
          target,
          executionScope: 'worktree',
        });
        return true;
      }

      // `new-worktree` / `branch` — resolve the workspace-level cwd (single-repo
      // uses `repoPath`; multi-repo uses `sourceRepoPath` plus its repo list),
      // same as the pre-decoupling behavior.
      let cwd: string | undefined;
      const repoChoices: PipelineRepoChoice[] = [];
      if (workspace.type === 'single-repo') {
        cwd = workspace.repoPath;
      } else if (workspace.type === 'multi-repo') {
        cwd = workspace.sourceRepoPath;
        if (workspace.sourceRepoPath) {
          repoChoices.push({
            repoId: WORKSPACE_ROOT_REPO_ID,
            repoName: WORKSPACE_ROOT_REPO_NAME,
          });
        }
        for (const repo of workspace.repos) {
          repoChoices.push({ repoId: repo.id, repoName: repo.name });
        }
      }
      if (!cwd) return false;

      setRunError(null);
      setCtx({
        workspaceId,
        taskText,
        cwd,
        repoChoices,
        target,
        executionScope: 'worktree',
      });
      return true;
    },
    [projects],
  );

  const close = useCallback((): void => {
    if (running) return;
    setCtx(null);
    setRunError(null);
    setWatcherSelection(null);
  }, [running]);

  /**
   * Runs `pipeline` immediately against `ctx.cwd` (the `worktree`/`cowork`
   * target kinds — no worktree provisioning). Mirrors `ChatInput`'s
   * `handlePipelineRun` (`plan_ready`) execute-request shape.
   *
   * Unlike the deferred path, navigation happens only AFTER a successful
   * execute: `HomeSurface` (the modal host) unmounts when the app navigates
   * away from the Home page, so navigating first would destroy the modal and
   * silently swallow any `runError`.
   */
  const runImmediately = useCallback(
    async (
      cwd: string,
      target: Extract<
        TaskReadyPipelineLaunchTarget,
        { kind: 'worktree' | 'cowork' }
      >,
      workspaceId: string,
      taskText: string,
      pipelineId: string,
      pipeline: PipelineData,
      inputs: Record<string, string> | undefined,
      pluginCollectionContext: PipelinePluginCollectionRunContext,
    ): Promise<boolean> => {
      try {
        const result = await window.pipelines.execute(pipeline.content, {
          cwd,
          pipelineFilePath:
            pipeline.info.source === 'project'
              ? pipeline.info.filePath
              : undefined,
          repoPath: pipeline.info.source === 'project' ? cwd : undefined,
          pipelineId,
          ...(target.kind === 'worktree'
            ? { projectId: workspaceId, worktreeId: target.worktreeId }
            : {}),
          eventName: 'task_ready',
          eventData: { task_ready: { task_text: taskText } },
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
          pluginCollectionPreferences: pluginCollectionContext.preferences,
          modelConfig: pluginCollectionContext.modelConfig,
          ...(pluginCollectionContext.pipelinePreferenceLocator
            ? {
                pipelinePreferenceLocator:
                  pluginCollectionContext.pipelinePreferenceLocator,
              }
            : {}),
          ...(pipeline.info.source === 'shared' &&
          pipeline.info.serverId &&
          pipeline.info.remoteId
            ? {
                sharedPipeline: {
                  serverId: pipeline.info.serverId,
                  remoteId: pipeline.info.remoteId,
                },
              }
            : {}),
        });

        if (!result.success) {
          setRunning(false);
          setRunError(result.error ?? 'Workflow execution failed');
          return false;
        }

        // Worktree runs surface on the worktree's pipeline card (Code page);
        // cowork runs have no worktree card, so land on the Pipelines page
        // executions list instead.
        if (target.kind === 'worktree') {
          useChatStore
            .getState()
            .selectWorktree(workspaceId, target.worktreeId);
        }
        useNavigationStore
          .getState()
          .navigate(target.kind === 'cowork' ? 'workflows-library' : 'main');

        setRunning(false);
        setCtx(null);
        setWatcherSelection(null);
        // The Home onboarding suggestions module completes its
        // "Create a Task Plan" entry on any successful task_ready dispatch.
        return true;
      } catch (err: unknown) {
        setRunning(false);
        setRunError(extractIpcErrorMessage(err));
        return false;
      }
    },
    [],
  );

  const run = useCallback(
    async (
      pipelineId: string,
      pipeline: PipelineData,
      inputs: Record<string, string> | undefined,
      selectedRepoId: string | undefined,
      pluginCollectionContext: PipelinePluginCollectionRunContext,
    ): Promise<boolean> => {
      if (!ctx) return false;

      setRunning(true);
      setRunError(null);

      if (ctx.target.kind === 'worktree' || ctx.target.kind === 'cowork') {
        return runImmediately(
          ctx.cwd,
          ctx.target,
          ctx.workspaceId,
          ctx.taskText,
          pipelineId,
          pipeline,
          inputs,
          pluginCollectionContext,
        );
      }

      const target = ctx.target;

      try {
        // Create (and auto-select — `createWorktree`'s default) the worktree
        // BEFORE navigating, matching `dispatchHomeSend`'s new-worktree
        // ordering (Task G1 fix round 2): navigating first would show the
        // Code page's no-selection/stale-selection state behind the picker
        // modal for the duration of the IPC round-trip, and a creation
        // failure would strand the user there instead of leaving them where
        // they launched from with `runError` shown in the modal.
        const created = await useProjectsStore
          .getState()
          .createWorktree(ctx.workspaceId, {
            suppressStartPage: true,
            ...(target.kind === 'branch'
              ? { existingBranch: target.branchName }
              : {}),
            ...(target.kind === 'new-worktree' && target.baseWorktreeId
              ? { baseWorktreeId: target.baseWorktreeId }
              : {}),
            ...(target.kind === 'new-worktree' && target.baseBranch
              ? { baseBranch: target.baseBranch }
              : {}),
            // Registration means the row exists and the projects store has
            // selected it. Activate that usable UI immediately rather than
            // waiting for persistence and post-create refreshes.
            onRegistered: () => useNavigationStore.getState().navigate('main'),
          });
        if (!created) {
          setRunning(false);
          setRunError('Failed to create worktree');
          return false;
        }
        // Phase A returned a `git-pending` worktree row. Defer both the
        // task-branch naming (new-worktree only — an existing branch already
        // has a name) and the pipeline execution until the
        // `worktree:git-ready` event arrives — the worktree directory does
        // not exist on disk yet so probing it would fail.
        if (target.kind === 'new-worktree') {
          useProjectsStore
            .getState()
            .enqueuePendingTaskBranchNaming(
              ctx.workspaceId,
              created.id,
              ctx.taskText,
            );
        }

        usePipelineRunsStore.getState().enqueuePendingExecution({
          projectId: ctx.workspaceId,
          worktreeId: created.id,
          pipelineId,
          pipelineContent: pipeline.content,
          ...(selectedRepoId ? { selectedRepoId } : {}),
          eventName: 'task_ready',
          eventData: { task_ready: { task_text: ctx.taskText } },
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
          pluginCollectionPreferences: pluginCollectionContext.preferences,
          modelConfig: pluginCollectionContext.modelConfig,
          ...(pluginCollectionContext.pipelinePreferenceLocator
            ? {
                pipelinePreferenceLocator:
                  pluginCollectionContext.pipelinePreferenceLocator,
              }
            : {}),
          ...(pipeline.info.source === 'shared' &&
          pipeline.info.serverId &&
          pipeline.info.remoteId
            ? {
                sharedPipeline: {
                  serverId: pipeline.info.serverId,
                  remoteId: pipeline.info.remoteId,
                },
              }
            : {}),
          pipelineName: pipeline.info.name,
          taskText: ctx.taskText,
          ...(watcherSelection
            ? {
                watcherDestination: watcherSelection.destination,
                ...(watcherSelection.followUpInstruction
                  ? {
                      watcherFollowUpInstruction:
                        watcherSelection.followUpInstruction,
                    }
                  : {}),
              }
            : {}),
        });

        setRunning(false);
        setCtx(null);
        setWatcherSelection(null);
        // Deferred enqueue still counts as a dispatched task_ready run for
        // the Home onboarding suggestions module.
        return true;
      } catch (err: unknown) {
        setRunning(false);
        setRunError(
          err instanceof Error ? err.message : 'Failed to execute workflow',
        );
        return false;
      }
    },
    [ctx, watcherSelection, runImmediately],
  );

  return {
    ctx,
    running,
    runError,
    watcherSelection,
    setWatcherSelection,
    open,
    close,
    run,
  };
}
