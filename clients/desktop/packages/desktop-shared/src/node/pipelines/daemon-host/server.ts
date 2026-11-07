import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { ConnectedExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import type {
  PipelineHostErrorCode,
  PipelineHostLaunch,
  PipelineHostMessage,
  PipelineHostRequest,
  PipelineHostRequestMessage,
} from '@canopy/core-runtime/node/pipeline/host';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type {
  ExecutionState,
  Pipeline,
  PipelinePreferenceLocator,
} from '@canopy/desktop-shared/types/pipeline';
import { getCanopyDataDir } from '../../../canopy-paths';
import { classifyDaemonPipeline } from '../daemon-eligibility';
import { projectPipelineExecution } from '../execution-projection';
import { cancelPipelineExecution, executePipeline } from '../executor';
import { recoverOrphanedPipelineExecutions } from '../executor/crash-recovery';
import {
  loadExecutionState,
  normalizeAgentChatAddress,
  normalizeCuratedPipelineSource,
  normalizeExecutionInitiator,
  normalizeSharedPipelineSource,
  requestExecutionCancellation,
} from '../executor/execution-state';
import {
  configurePipelineOwnerFence,
  type PipelineOwnerInspector,
} from '../executor/owner-fence';
import type {
  ExecutionHandle,
  ExecutionOptions,
  ExecutionResourceMonitor,
  ExecutionResourceRegistrationHandle,
  ExecutionRuntime,
} from '../executor/types';
import { createDaemonPipelineRuntime } from './runtime';

export interface ServePipelineHostOptions {
  readonly channel: ConnectedExecutionHostChannel;
  /** Process start identity for the owner fence; null on hosts that cannot prove it. */
  readonly inspectProcess: PipelineOwnerInspector | null;
}

const DRAIN_TIMEOUT_MS = 10_000;

const TERMINAL: ReadonlySet<ExecutionState['status']> = new Set<
  ExecutionState['status']
>(['success', 'failure', 'cancelled']);

function isSettled(state: ExecutionState): boolean {
  return state.status === 'paused' || TERMINAL.has(state.status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestMessage(value: unknown): value is PipelineHostRequestMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    isRecord(value.request) &&
    typeof value.request.op === 'string'
  );
}

/** One line on stderr, without the launch, environment or inputs. */
function warn(message: string): void {
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', message, details: null })}\n`,
  );
}

function eventFor(state: ExecutionState): string {
  if (state.status === 'cancelled') return 'execution.cancelled';
  if (state.status === 'failure') return 'execution.failed';
  if (state.status === 'success') return 'execution.completed';
  if (state.status === 'paused') return 'execution.paused';
  return 'execution.updated';
}

/** A launch's preference locator; anything else is dropped. */
function parsePreferenceLocator(
  value: unknown,
): PipelinePreferenceLocator | undefined {
  if (!isRecord(value) || typeof value.value !== 'string') return undefined;
  const locatorValue = value.value;
  if (value.type === 'file' || value.type === 'shared')
    return { type: value.type, value: locatorValue };
  if (
    value.type !== 'stored' ||
    (value.source !== 'bundled' &&
      value.source !== 'user' &&
      value.source !== 'curated')
  )
    return undefined;
  return {
    type: 'stored',
    source: value.source,
    value: locatorValue,
    ...(typeof value.contentHash === 'string' && {
      contentHash: value.contentHash,
    }),
  };
}

/** Whether `dataRoot` is the data root this host resolves for itself. */
async function isOwnDataRoot(dataRoot: string): Promise<boolean> {
  try {
    const [own, sent] = await Promise.all([
      realpath(getCanopyDataDir()),
      realpath(dataRoot),
    ]);
    return own === sent;
  } catch {
    return false;
  }
}

interface LiveRun {
  readonly handle: ExecutionHandle;
  readonly runtime: ExecutionRuntime;
}

/** Serves one pipeline host over its execution host channel (CAN-5086). */
export function servePipelineHost(options: ServePipelineHostOptions): void {
  const { channel } = options;
  let executionsDir: string | null = null;
  let admissionOpen = true;
  let lastBundledActionsDir = '';
  const runs = new Map<string, LiveRun>();
  const exitRequests: number[] = [];
  /** Starts admitted but not yet answered; checkpoint and exit wait for them. */
  const admitting = new Set<Promise<void>>();

  const post = (message: PipelineHostMessage): void => {
    channel.postMessage(message);
  };
  const respond = (id: number, value: unknown): void => {
    post({ kind: 'response', id, ok: true, value });
  };
  /** Tells the run's streams about a state no executor event reported. */
  const publish = (executionId: string, state: ExecutionState): void => {
    post({
      kind: 'execution',
      executionId,
      event: eventFor(state),
      execution: projectPipelineExecution(state),
    });
  };
  const fail = (id: number, code: PipelineHostErrorCode): void => {
    post({
      kind: 'response',
      id,
      ok: false,
      error: { code, message: 'The pipeline host refused the request.' },
    });
  };

  const resourceMonitor: ExecutionResourceMonitor = {
    registerProcess(registration): ExecutionResourceRegistrationHandle {
      const processGroupId = registration.processGroupId ?? registration.pid;
      if (processGroupId === undefined)
        return { update(): void {}, unregister(): void {} };
      post({
        kind: 'process',
        state: 'started',
        id: registration.id,
        processGroupId,
      });
      let exited = false;
      return {
        update(): void {},
        unregister(): void {
          if (exited) return;
          exited = true;
          post({ kind: 'process', state: 'exited', id: registration.id });
        },
      };
    },
    registerWorkItem(): ExecutionResourceRegistrationHandle {
      return { update(): void {}, unregister(): void {} };
    },
  };

  const settleExits = (): void => {
    if (runs.size > 0 || admitting.size > 0) return;
    const pending = exitRequests.splice(0);
    if (pending.length === 0) return;
    for (const id of pending) respond(id, null);
    channel.exit(0);
  };

  const forget = (executionId: string, handle: ExecutionHandle): void => {
    if (runs.get(executionId)?.handle !== handle) return;
    runs.delete(executionId);
    settleExits();
  };

  const runtimeFor = (dir: string, executionId: string): ExecutionRuntime =>
    runs.get(executionId)?.runtime ??
    createDaemonPipelineRuntime({
      executionsDir: dir,
      bundledActionsDir: lastBundledActionsDir,
      processEnvironment: {},
    });

  const start = async (
    id: number,
    dir: string,
    hostLaunch: PipelineHostLaunch,
  ): Promise<void> => {
    if (!admissionOpen) return fail(id, 'closed');
    const { params, launch, processEnvironment } = hostLaunch;
    // Daemon runs are worktree runs the daemon verified (D6, D17).
    if (
      params.runScope !== 'worktree' ||
      params.workspaceId === null ||
      params.worktreeId === null
    )
      return fail(id, 'start_failed');
    const worktree = {
      workspaceId: params.workspaceId,
      worktreeId: params.worktreeId,
      path: launch.cwd,
    };
    lastBundledActionsDir = launch.bundledActionsDir;
    const runtime = createDaemonPipelineRuntime({
      executionsDir: dir,
      bundledActionsDir: launch.bundledActionsDir,
      processEnvironment,
      ...(launch.nodeProcess && { nodeProcess: launch.nodeProcess }),
      resourceMonitor,
      worktree,
    });
    let pipeline: Pipeline;
    try {
      pipeline = parsePipelineText(JSON.stringify(launch.pipeline));
    } catch {
      return fail(id, 'start_failed');
    }
    const classification = classifyDaemonPipeline(pipeline, {
      runtime,
      repoPath: launch.repoPath ?? launch.cwd,
    });
    if (!classification.eligible) return fail(id, 'model_steps');
    const { executionId } = params;
    let handle: ExecutionHandle | null = null;
    const executionOptions: ExecutionOptions = {
      cwd: launch.cwd,
      pipelineId: params.pipelineId,
      scope: params.runScope,
      target: {
        scope: 'worktree',
        workspace_id: worktree.workspaceId,
        worktree_id: worktree.worktreeId,
        path: worktree.path,
        created: false,
      },
      executionCheckoutRoot: launch.executionCheckoutRoot,
      env: { ...launch.env },
      secretEnv: Object.keys(launch.secretEnv).length
        ? { ...launch.secretEnv }
        : undefined,
      inputs: launch.inputs,
      pipelineFileDir: launch.pipelineFileDir,
      pipelineDataDir: launch.pipelineDataDir,
      assetsDir: launch.assetsDir,
      assetPaths: launch.assetPaths,
      repoPath: launch.repoPath,
      runtime,
      executionId,
      projectId: worktree.workspaceId,
      worktreeId: worktree.worktreeId,
      pipelinePreferenceLocator: parsePreferenceLocator(
        launch.pipelinePreferenceLocator,
      ),
      sharedPipelineSource: normalizeSharedPipelineSource(
        launch.sharedPipelineSource,
      ),
      curatedPipelineSource: normalizeCuratedPipelineSource(
        launch.curatedPipelineSource,
      ),
      executionContext: params.owner ?? undefined,
      initiationSource:
        params.initiationSource === 'unknown'
          ? undefined
          : params.initiationSource,
      initiator: normalizeExecutionInitiator(launch.initiator),
      agentOrigin: normalizeAgentChatAddress(launch.agentOrigin),
      onEvent: (event): void => {
        if (event.executionId !== executionId) return;
        post({
          kind: 'execution',
          executionId,
          event: event.type,
          execution: projectPipelineExecution(event.state),
        });
        if (handle && isSettled(event.state)) forget(executionId, handle);
      },
      onStepOutput: (event): void => {
        // Output dropped under congestion stays in the persisted step log.
        if (event.executionId !== executionId || channel.congested()) return;
        post({
          kind: 'output',
          executionId,
          jobId: event.jobId,
          stepId: event.stepId,
          stream: event.stream,
          text: event.data,
        });
      },
    };
    try {
      handle = await executePipeline(pipeline, executionOptions);
    } catch {
      warn('The pipeline host could not start a workflow run.');
      return fail(id, 'start_failed');
    }
    const started = handle;
    // The executor rejects completion only on its own failure; observe it so
    // that failure never ends the host.
    void started.waitForCompletion().then(
      () => forget(executionId, started),
      () => {
        warn('A workflow run ended with an executor error.');
        const failed = started.getState();
        if (TERMINAL.has(failed.status)) publish(executionId, failed);
        forget(executionId, started);
      },
    );
    const state = started.getState();
    if (!isSettled(state)) runs.set(executionId, { handle: started, runtime });
    respond(id, projectPipelineExecution(state));
  };

  const get = async (
    id: number,
    dir: string,
    executionId: string,
  ): Promise<void> => {
    const stored = await loadExecutionState(executionId, dir);
    const state =
      stored && TERMINAL.has(stored.status)
        ? stored
        : (runs.get(executionId)?.handle.getState() ?? stored);
    respond(id, state ? projectPipelineExecution(state) : null);
  };

  const cancel = async (
    id: number,
    dir: string,
    executionId: string,
    mode: 'finalize' | 'drain',
  ): Promise<void> => {
    const live = runs.get(executionId)?.handle;
    try {
      if (mode === 'drain') {
        if (live) {
          await requestExecutionCancellation(executionId, dir);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS);
          });
          const outcome = await Promise.race([live.cancel(), timedOut]);
          clearTimeout(timer);
          if (outcome === 'timeout') return fail(id, 'drain_timed_out');
          return respond(id, projectPipelineExecution(outcome));
        }
        const stored = await loadExecutionState(executionId, dir);
        if (stored && TERMINAL.has(stored.status))
          return respond(id, projectPipelineExecution(stored));
        const cancelled = await cancelPipelineExecution(
          executionId,
          runtimeFor(dir, executionId),
          { allowRecoveredFallback: false },
        );
        publish(executionId, cancelled);
        return respond(id, projectPipelineExecution(cancelled));
      }
      if (live) void live.cancel().catch(() => undefined);
      const cancelled = await cancelPipelineExecution(
        executionId,
        runtimeFor(dir, executionId),
      );
      // A live run's executor reports its own cancellation.
      if (!live) publish(executionId, cancelled);
      return respond(id, projectPipelineExecution(cancelled));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Execution "${executionId}" not found`
      )
        return fail(id, 'not_found');
      return fail(id, 'cancel_failed');
    }
  };

  const checkpoint = async (id: number): Promise<void> => {
    admissionOpen = false;
    await Promise.allSettled([...admitting]);
    const live = [...runs.values()].map(({ handle }) => handle);
    const settled = await Promise.allSettled(
      live.map((handle) =>
        handle.pauseForShutdown
          ? handle.pauseForShutdown()
          : Promise.reject(new Error('The run cannot pause.')),
      ),
    );
    if (settled.some((result) => result.status === 'rejected'))
      return fail(id, 'checkpoint_failed');
    respond(id, { checkpointedCount: live.length });
  };

  const handle = async (
    id: number,
    request: PipelineHostRequest,
  ): Promise<void> => {
    if (request.op === 'configure') {
      // The host never overrides its data root: it refuses another one.
      if (!(await isOwnDataRoot(request.dataRoot))) return fail(id, 'closed');
      executionsDir = path.join(request.dataRoot, 'pipeline-executions');
      await configurePipelineOwnerFence(options.inspectProcess);
      return respond(id, null);
    }
    const dir = executionsDir;
    if (dir === null) return fail(id, 'closed');
    switch (request.op) {
      case 'start': {
        const admitted = start(id, dir, request.start);
        const settle = (): void => {
          admitting.delete(admitted);
          settleExits();
        };
        admitting.add(admitted);
        void admitted.then(settle, settle);
        return admitted;
      }
      case 'get':
        return get(id, dir, request.executionId);
      case 'cancel':
        return cancel(id, dir, request.executionId, request.mode);
      case 'sweep': {
        const errors = await recoverOrphanedPipelineExecutions(
          request.executionIds,
          dir,
        );
        return respond(id, { failureCount: errors.length });
      }
      case 'checkpoint':
        return checkpoint(id);
      case 'exit':
        admissionOpen = false;
        exitRequests.push(id);
        return settleExits();
    }
  };

  channel.on('message', (event) => {
    const message = event.data;
    if (!isRequestMessage(message)) return;
    handle(message.id, message.request).catch(() => {
      warn('The pipeline host could not answer a request.');
      fail(message.id, 'closed');
    });
  });
}
