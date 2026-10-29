import { authorizePipelineReplay } from './pipeline-replay-authorization';
import { pipelineSpeedError } from './codex-speed';
import { access, stat } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import {
  loadExecutionState,
  resumePipeline,
  type ExecutionOptions,
  type ExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type { PipelineScalar } from '@canopy/desktop-shared/types/pipeline';
import { resolveEnvironmentForRuntime } from '@canopy/desktop-shared/lib/user-environment';
import { sendToAllWindows } from '../lib/window-send';
import { resolveLinearToken } from '../lib/linear-auth';
import { readPreferencesFile } from '../lib/preferences-store';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { readEnvironmentConfig } from '../lib/user-environment-store';
import { getCachedClaudeAuthStatusObserved } from '../auth/provider-auth-state';
import { getEffectiveClaudeWorkerModePreferences } from '../lib/claude-tui-workers';
import { getObservabilityService } from '../observability';
import { getResourceMonitorService } from '../resource-monitor';
import { buildPipelinePreferenceEnv } from './preference-env';
import { getPipelineAdvisorService } from './pipeline-advisor';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import { enqueueKnownPrFastRefresh } from '../lib/github-poller';
import {
  getActiveExecutionHandle,
  hasActiveExecution,
  releaseExecutionReservation,
  reserveExecution,
  trackExecution,
} from './pipeline-execution-registry';
import { buildPipelineBaseBranchEnv } from './worktree-base-branch-env';
import { recordPipelineUsageEvent } from './pipeline-usage-events';
import {
  cancelPendingTransientRetryTimer,
  notePipelineExecutionEvent,
} from './transient-error-retry-scheduler';
import { broadcastPipelineExecutionEvent } from './pipeline-execution-event-broadcaster';

export interface ResumePipelineExecutionFromMainRequest {
  executionId: string;
  statusReasonIds?: string[];
  inputAnswers?: Record<string, PipelineScalar>;
  pauseResponses?: ExecutionOptions['pauseResponses'];
  inputs?: ExecutionOptions['inputs'];
  repoPath?: string;
  cwd?: string;
  env?: Record<string, string>;
  allowStaleNoop?: boolean;
  transientRetryOwnToken?: number;
  initiationSource: 'user' | 'automation' | 'portal';
  /**
   * Opts a trusted caller into changing attribution for the remaining
   * execution. Internal recovery callers leave this unset so a user-started
   * run stays attended across retries and maintenance resumes.
   */
  persistInitiationSource?: boolean;
  portalCommandId?: string;
  getWindow: () => BrowserWindow | null;
  onEvent?: ExecutionOptions['onEvent'];
  onStepOutput?: ExecutionOptions['onStepOutput'];
}

export type ResumePipelineExecutionFromMainResult =
  | { status: 'started'; state: ExecutionState }
  | { status: 'stale-noop'; state: ExecutionState }
  | { status: 'already-running'; state: ExecutionState };

const STATUS_REASON_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function exists(target: string, directory = false): Promise<boolean> {
  try {
    if (directory) return (await stat(target)).isDirectory();
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveStoredCwd(state: ExecutionState): Promise<string> {
  if (state.target?.scope === 'directory') {
    if (await exists(state.target.path, true)) return state.target.path;
    throw new Error(
      `Directory target path does not exist: ${state.target.path}`,
    );
  }
  if (state.target?.scope === 'worktree') {
    if (await exists(state.target.path, true)) return state.target.path;
    throw new Error(
      `Worktree target "${state.target.workspace_id}/${state.target.worktree_id}" no longer exists`,
    );
  }
  if (state.project_id && state.worktree_id) {
    try {
      const cwd = resolveWorktreeCwd(state.project_id, state.worktree_id);
      if (await exists(cwd)) return cwd;
    } catch {
      if (state.scope === 'worktree') {
        throw new Error(
          `Worktree target "${state.project_id}/${state.worktree_id}" no longer exists`,
        );
      }
    }
  }
  return state.cwd;
}

async function runtimeEnvironment(workspaceId?: string): Promise<{
  env: Record<string, string>;
  secretEnv: Record<string, string>;
}> {
  try {
    const { data } = await readEnvironmentConfig();
    const resolved = resolveEnvironmentForRuntime(data, {
      runtime: 'pipeline',
      ...(workspaceId ? { workspaceId } : {}),
    });
    return {
      env: resolved.publicApplied,
      secretEnv: resolved.secretApplied,
    };
  } catch {
    return { env: {}, secretEnv: {} };
  }
}

async function terminalMode(
  preferred: 'canopy' | 'terminal',
): Promise<boolean> {
  if (preferred !== 'terminal') return false;
  return (
    await getCachedClaudeAuthStatusObserved('pipeline-terminal-mode', {
      forceRefresh: true,
    })
  ).authenticated;
}

export async function resumePipelineExecutionFromMain(
  request: ResumePipelineExecutionFromMainRequest,
): Promise<ResumePipelineExecutionFromMainResult> {
  if (request.statusReasonIds) {
    if (request.statusReasonIds.length === 0) {
      throw new Error('statusReasonIds must contain at least one reason ID');
    }
    if (
      new Set(request.statusReasonIds).size !== request.statusReasonIds.length
    ) {
      throw new Error('statusReasonIds must not contain duplicate reason IDs');
    }
    if (
      request.statusReasonIds.some(
        (reasonId) => !STATUS_REASON_ID_PATTERN.test(reasonId),
      )
    ) {
      throw new Error('statusReasonIds contains a malformed reason ID');
    }
  }
  cancelPendingTransientRetryTimer(
    request.executionId,
    request.transientRetryOwnToken,
  );
  // Defer the runtime to break the canopy-tools/worktree-actions ->
  // pipeline-resume-service -> execution-runtime -> canopy-tools/worktree-actions
  // initialization cycle during unrelated main-process module loads.
  const { createElectronExecutionRuntime } =
    await import('./execution-runtime');
  const runtime = createElectronExecutionRuntime(request.getWindow);
  runtime.resourceMonitor = getResourceMonitorService();
  const state = await loadExecutionState(
    request.executionId,
    runtime.executionsDir,
  );
  if (!state) throw new Error(`Execution "${request.executionId}" not found`);
  const speedError = pipelineSpeedError(state.model_config);
  if (speedError) throw new Error(speedError);
  const continuationInitiationSource = request.persistInitiationSource
    ? request.initiationSource
    : state.initiation_source;

  if (hasActiveExecution(request.executionId)) {
    const active = getActiveExecutionHandle(request.executionId);
    if (active?.resumePaused) {
      const activeState = active.getState();
      const activeSpeedError = pipelineSpeedError(activeState.model_config);
      if (activeSpeedError) throw new Error(activeSpeedError);
      const hasPauseResponses = (request.pauseResponses?.length ?? 0) > 0;
      let activeReasonIds =
        request.statusReasonIds ??
        (hasPauseResponses
          ? []
          : activeState.status_reasons
              .filter((reason) => reason.kind !== 'input_required')
              .map((reason) => reason.id));
      if (request.allowStaleNoop && request.statusReasonIds) {
        const currentIds = new Set(
          activeState.status_reasons.map((reason) => reason.id),
        );
        if (activeState.shutdown_checkpoint) {
          currentIds.add(activeState.shutdown_checkpoint.id);
        }
        activeReasonIds = activeReasonIds.filter((id) => currentIds.has(id));
        if (activeReasonIds.length === 0 && !hasPauseResponses) {
          return { status: 'stale-noop', state: activeState };
        }
      }
      if (activeReasonIds.length === 0 && !hasPauseResponses) {
        return { status: 'already-running', state: activeState };
      }
      const authorization = await authorizePipelineReplay(activeState);
      const resumedJobIds = new Set<string>();
      for (const reasonId of activeReasonIds) {
        const reason = activeState.status_reasons.find(
          (candidate) => candidate.id === reasonId,
        );
        if (reason) resumedJobIds.add(reason.source.job_id);
      }
      for (const response of request.pauseResponses ?? []) {
        resumedJobIds.add(response.job_id);
      }
      const resumedJobsSettledOrPaused = (
        candidateState: ExecutionState,
      ): boolean =>
        resumedJobIds.size > 0 &&
        Array.from(resumedJobIds).every((jobId) => {
          const jobStatus = candidateState.jobs[jobId]?.status;
          if (
            jobStatus === 'success' ||
            jobStatus === 'failure' ||
            jobStatus === 'cancelled' ||
            jobStatus === 'skipped'
          ) {
            return true;
          }
          return (
            candidateState.pending_pauses?.some(
              (checkpoint) => checkpoint.job_id === jobId,
            ) === true ||
            candidateState.status_reasons.some(
              (reason) => reason.source.job_id === jobId,
            )
          );
        });
      let observerDisposer: (() => void) | undefined;
      let observersRemoved = false;
      const removeObservers = (): void => {
        if (observersRemoved) return;
        observersRemoved = true;
        observerDisposer?.();
      };
      if (request.onEvent || request.onStepOutput) {
        if (!active.addObservers) {
          throw new Error(
            `Execution "${request.executionId}" cannot attach resume observers`,
          );
        }
        const onEvent: NonNullable<ExecutionOptions['onEvent']> = (event) => {
          try {
            request.onEvent?.(event);
          } finally {
            if (
              event.state.status === 'success' ||
              event.state.status === 'failure' ||
              event.state.status === 'cancelled' ||
              resumedJobsSettledOrPaused(event.state) ||
              (resumedJobIds.size === 0 && event.type === 'execution.paused')
            ) {
              removeObservers();
            }
          }
        };
        observerDisposer = active.addObservers({
          onEvent,
          onStepOutput: request.onStepOutput,
        });
      }
      try {
        const resumedState = authorization
          ? await active.resumePaused(
              activeReasonIds,
              request.pauseResponses,
              continuationInitiationSource,
              request.portalCommandId,
              authorization,
            )
          : request.portalCommandId
            ? await active.resumePaused(
                activeReasonIds,
                request.pauseResponses,
                continuationInitiationSource,
                request.portalCommandId,
              )
            : await active.resumePaused(
                activeReasonIds,
                request.pauseResponses,
                continuationInitiationSource,
              );
        if (
          resumedState.status === 'success' ||
          resumedState.status === 'failure' ||
          resumedState.status === 'cancelled' ||
          resumedJobsSettledOrPaused(resumedState)
        ) {
          removeObservers();
        }
        return { status: 'started', state: resumedState };
      } catch (error) {
        removeObservers();
        throw error;
      }
    }
    return { status: 'already-running', state: active?.getState() ?? state };
  }
  let selectedReasonIds = request.statusReasonIds;
  if (request.allowStaleNoop && request.statusReasonIds?.length) {
    const activeIds = new Set(state.status_reasons.map((reason) => reason.id));
    if (state.shutdown_checkpoint) {
      activeIds.add(state.shutdown_checkpoint.id);
    }
    selectedReasonIds = request.statusReasonIds.filter((id) =>
      activeIds.has(id),
    );
    if (selectedReasonIds.length === 0) {
      return { status: 'stale-noop', state };
    }
  }
  if (
    request.allowStaleNoop &&
    (state.status === 'success' ||
      state.status === 'failure' ||
      state.status === 'cancelled')
  ) {
    return { status: 'stale-noop', state };
  }

  const resource = getResourceMonitorService().reservePipelineExecutionStart();
  let ownsExecutionReservation = false;
  try {
    reserveExecution(request.executionId);
    ownsExecutionReservation = true;
    const preferences = await readPreferencesFile();
    const linearToken = await resolveLinearToken();
    const cwd = request.cwd ?? (await resolveStoredCwd(state));
    const baseBranchEnv = await buildPipelineBaseBranchEnv({
      cwd,
      projectId: state.project_id,
      worktreeId: state.worktree_id,
    });
    const runtimeEnv = await runtimeEnvironment(state.project_id);
    const secretEnv = { ...runtimeEnv.secretEnv };
    if (linearToken) secretEnv[brandEnvName('LINEAR_API_KEY')] = linearToken;
    const authorization = await authorizePipelineReplay(state);
    const handle = await resumePipeline(request.executionId, {
      ...authorization,
      cwd,
      statusReasonIds: selectedReasonIds,
      inputAnswers: request.inputAnswers,
      pauseResponses: request.pauseResponses,
      inputs: request.inputs,
      repoPath: request.repoPath,
      initiationSource: continuationInitiationSource,
      ...(request.portalCommandId
        ? { portalCommandId: request.portalCommandId }
        : {}),
      agentTerminalMode: await terminalMode(
        getEffectiveClaudeWorkerModePreferences(preferences).pipelinesMode,
      ),
      env: {
        ...runtimeEnv.env,
        ...(await buildPipelinePreferenceEnv(preferences)),
        ...baseBranchEnv,
        ...(request.env ?? {}),
      },
      secretEnv: Object.keys(secretEnv).length ? secretEnv : undefined,
      runtime,
      onEvent: (event) => {
        notePipelineExecutionEvent(event, request.getWindow);
        getObservabilityService().syncPipelineExecutionState(event.state);
        recordPipelineUsageEvent(event);
        if (
          event.type === 'execution.paused' ||
          event.state.status === 'success' ||
          event.state.status === 'failure' ||
          event.state.status === 'cancelled'
        ) {
          void Promise.resolve(
            getAppAdvisorWatcherService().handlePipelineTerminalEvent(event),
          ).catch(() => undefined);
        }
        if (
          (event.type === 'execution.completed' ||
            event.type === 'execution.failed') &&
          (event.state.status === 'success' ||
            event.state.status === 'failure') &&
          event.state.project_id &&
          event.state.worktree_id
        ) {
          void enqueueKnownPrFastRefresh(
            event.state.project_id,
            event.state.worktree_id,
          ).catch(() => undefined);
        }
        broadcastPipelineExecutionEvent(event);
        request.onEvent?.(event);
      },
      onStepOutput: (event) => {
        getObservabilityService().observePipelineOutput(event);
        sendToAllWindows(PIPELINE_CHANNELS.STEP_OUTPUT_EVENT, event);
        request.onStepOutput?.(event);
      },
    });
    trackExecution(handle);
    ownsExecutionReservation = false;
    getPipelineAdvisorService().watchExecution({
      handle,
      runtime,
      getWindow: request.getWindow,
    });
    return { status: 'started', state: handle.getState() };
  } catch (error) {
    if (ownsExecutionReservation) {
      releaseExecutionReservation(request.executionId);
    }
    throw error;
  } finally {
    resource.release();
  }
}
