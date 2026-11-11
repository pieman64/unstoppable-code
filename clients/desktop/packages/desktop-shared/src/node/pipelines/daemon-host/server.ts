import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { ConnectedExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import type {
  PipelineHostErrorCode,
  PipelineHostLauncherCommand,
  PipelineHostLaunch,
  PipelineHostMessage,
  PipelineHostRequest,
  PipelineHostRequestMessage,
} from '@canopy/core-runtime/node/pipeline/host';
import type { WorkerPipelineHostRequest } from '@canopy/protocol/canopy-core';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type {
  ExecutionState,
  Pipeline,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import { setBrandEnv } from '@canopy/execution-engine/brand/env';
import { applyModelRegistrySnapshot } from '@canopy/execution-engine/builtin-actions/_lib/model-registry';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { normalizeAgentModelConfig } from '../../../types';
import { classifyDaemonPipeline } from '../daemon-eligibility';
import { normalizeExecutionModelAliasPreferences } from '../executor/model-alias-preferences';
import { normalizePipelinePluginCollectionPreferences } from '../plugin-collection-store';
import { parseLaunchPluginCollections } from './plugin-collections';
import { listPipelineExecutionPage } from '../execution-list';
import {
  projectPipelineExecution,
  projectPipelineExecutionView,
} from '@canopy/execution-engine/node/pipelines/execution-projection';
import { cancelPipelineExecution, executePipeline } from '../executor';
import { recoverOrphanedPipelineExecutions } from '../executor/crash-recovery';
import {
  listExecutionSummaries,
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
} from '@canopy/execution-engine/node/pipelines/executor/owner-fence';
import type {
  ExecutionHandle,
  ExecutionOptions,
  ExecutionResourceMonitor,
  ExecutionResourceRegistrationHandle,
  ExecutionRuntime,
} from '../executor/types';
import {
  createDaemonHostStepPort,
  type DaemonHostStepPort,
} from './host-steps';
import type { CodexRuntimeService } from '../../codex-runtime';
import {
  acquireDaemonPipelineCodexRuntime,
  shutdownDaemonPipelineCodexRuntime,
} from './codex-runtime';
import {
  createPipelineOwnerClient,
  type PipelineOwnerClientHost,
} from './owner-client';
import { createDaemonPipelineOwnerPorts } from './owner-ports';
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
  /** Withdraws the run's pending owner requests (CAN-5095). */
  readonly ownerRequests?: AbortController;
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
  /**
   * Each run until its executor settles. A run leaves `runs` on its outcome
   * event but still writes under the data root until then; checkpoint and
   * exit wait for it.
   */
  const finishing = new Map<ExecutionHandle, Promise<void>>();
  /** Executions started `ownerBound`; only they take host steps and `pause` (CAN-5771). */
  const ownerBound = new Set<string>();
  let hostSteps: DaemonHostStepPort | null = null;
  /** Owner requests of model steps (CAN-5095). */
  let ownerRequests: PipelineOwnerClientHost | null = null;
  let codexMcpLauncher: PipelineHostLauncherCommand | null = null;
  let dataRoot: string | null = null;
  /** The provider CLIs the host's first model-step launch named (D21). */
  let providerBinaries: { claude: string; codex: string } | null = null;
  let bundledResourcesDir: string | null = null;

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
    if (runs.size > 0 || admitting.size > 0 || finishing.size > 0) return;
    const pending = exitRequests.splice(0);
    if (pending.length === 0) return;
    void shutdownDaemonPipelineCodexRuntime()
      .catch(() => warn('The pipeline host could not stop its Codex runtime.'))
      .finally(() => {
        for (const id of pending) respond(id, null);
        channel.exit(0);
      });
  };

  /** Points the host's provider CLIs at the app's own, once (D21); false for other paths. */
  const useProviderBinaries = (binaries: {
    claude: string;
    codex: string;
  }): boolean => {
    if (providerBinaries)
      return (
        providerBinaries.claude === binaries.claude &&
        providerBinaries.codex === binaries.codex
      );
    providerBinaries = { ...binaries };
    setBrandEnv(process.env, 'CLAUDE_BINARY_PATH', binaries.claude);
    setBrandEnv(process.env, 'CODEX_BINARY_PATH', binaries.codex);
    return true;
  };

  /** Points the host's builtin skills at the app's own resources, once (CAN-5832); false for another folder. */
  const useBundledResources = (dir: string): boolean => {
    if (bundledResourcesDir !== null) return bundledResourcesDir === dir;
    bundledResourcesDir = dir;
    setBrandEnv(process.env, 'BUNDLED_RESOURCES_DIR', dir);
    return true;
  };

  const forget = (executionId: string, handle: ExecutionHandle): void => {
    if (runs.get(executionId)?.handle !== handle) return;
    runs.delete(executionId);
    ownerBound.delete(executionId);
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
    const isOwnerBound = launch.ownerBound === true;
    const launcher = codexMcpLauncher;
    const configuredRoot = dataRoot ?? path.dirname(dir);
    const runOwnerRequests = isOwnerBound ? new AbortController() : undefined;
    // The run's collections as its core resolved them (CAN-5832); a snapshot
    // that does not parse or names an MCP server refuses the launch.
    const pluginCollections =
      isOwnerBound && launch.pluginCollectionSnapshots
        ? parseLaunchPluginCollections(launch.pluginCollectionSnapshots)
        : undefined;
    if (pluginCollections === null) return fail(id, 'start_failed');
    const runtime = createDaemonPipelineRuntime({
      executionsDir: dir,
      bundledActionsDir: launch.bundledActionsDir,
      processEnvironment,
      ...(pluginCollections && { pluginCollections }),
      onStepNotifications: (stepId, notifications): void => {
        for (const { title, body } of notifications)
          post({
            kind: 'notification',
            executionId: params.executionId,
            stepId,
            title,
            body,
          });
      },
      ...(launch.nodeProcess && { nodeProcess: launch.nodeProcess }),
      resourceMonitor,
      worktree,
      ...(isOwnerBound && hostSteps && { pipelineHostActions: hostSteps }),
      // Model ports only for a launch with model steps: Electron main answers
      // owner requests only for those (CAN-5095), and every other step must
      // not wait on it, as an unbound launch does not.
      ...(isOwnerBound &&
        ownerRequests &&
        launch.providerBinaries && {
          owner: createDaemonPipelineOwnerPorts(ownerRequests, {
            executionId: params.executionId,
            owner: params.owner,
            ...(runOwnerRequests && { signal: runOwnerRequests.signal }),
            ...(launch.codexEnvironment && {
              codexEnvironment: launch.codexEnvironment,
            }),
          }),
          ...(launcher && {
            codexRuntime: (): CodexRuntimeService =>
              acquireDaemonPipelineCodexRuntime({
                dataRoot: configuredRoot,
                mcpLauncher: launcher,
                onProcess: (event) => post({ kind: 'process', ...event }),
              }),
          }),
        }),
    });
    let pipeline: Pipeline;
    try {
      pipeline = parsePipelineText(JSON.stringify(launch.pipeline));
    } catch {
      return fail(id, 'start_failed');
    }
    // Model steps resolve against their core's model registry; a later launch's wins.
    if (
      isOwnerBound &&
      launch.modelCatalog &&
      !applyModelRegistrySnapshot(launch.modelCatalog)
    )
      return fail(id, 'start_failed');
    const classification = classifyDaemonPipeline(
      pipeline,
      {
        runtime,
        repoPath: launch.repoPath ?? launch.cwd,
        // The run's aliases as its core resolved them at launch (CAN-5832).
        ...(isOwnerBound &&
          launch.modelAliasResolutions && {
            modelAliases: launch.modelAliasResolutions,
          }),
        ...(pluginCollections && {
          pluginCollections: new Set(Object.keys(pluginCollections)),
        }),
      },
      {
        hostSteps: isOwnerBound ? 'owner' : 'refuse',
        modelSteps: isOwnerBound ? 'claude_codex' : 'refuse',
      },
    );
    if (!classification.eligible)
      return fail(
        id,
        classification.reason === 'host_step' ||
          classification.reason === 'host_paths' ||
          classification.reason === 'host_inputs'
          ? 'host_steps'
          : 'model_steps',
      );
    if (classification.modelSteps > 0) {
      // Model steps run the app's own CLIs (D21), Codex ones the run's Codex environment (D20).
      if (
        !launch.modelCatalog ||
        !launch.providerBinaries ||
        !useProviderBinaries(launch.providerBinaries) ||
        !launch.bundledResourcesDir ||
        !useBundledResources(launch.bundledResourcesDir)
      )
        return fail(id, 'start_failed');
      if (
        classification.modelHarnesses.includes('codex') &&
        (!launch.codexEnvironment || !launcher)
      )
        return fail(id, 'start_failed');
    }
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
      ...(classification.modelSteps > 0 && {
        modelConfig: normalizeAgentModelConfig(launch.modelConfig),
        agentTerminalMode: false,
      }),
      ...(pluginCollections &&
        launch.pluginCollectionPreferences !== undefined && {
          pluginCollectionPreferences:
            normalizePipelinePluginCollectionPreferences(
              launch.pluginCollectionPreferences,
            ),
        }),
      ...(launch.modelAliasPreferences !== undefined && {
        // The executor's own normalizer: a run's reset entries must survive.
        modelAliasPreferences: normalizeExecutionModelAliasPreferences(
          launch.modelAliasPreferences,
        ),
      }),
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
          attempt: event.attempt,
          ...(event.iteration !== undefined && { iteration: event.iteration }),
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
    const finished = started
      .waitForCompletion()
      .then(
        () => forget(executionId, started),
        () => {
          warn('A workflow run ended with an executor error.');
          const failed = started.getState();
          if (TERMINAL.has(failed.status)) publish(executionId, failed);
          forget(executionId, started);
        },
      )
      .finally(() => {
        finishing.delete(started);
        settleExits();
      })
      .catch(() => warn('The pipeline host could not retire a workflow run.'));
    finishing.set(started, finished);
    const state = started.getState();
    if (!isSettled(state)) {
      runs.set(executionId, {
        handle: started,
        runtime,
        ...(runOwnerRequests && { ownerRequests: runOwnerRequests }),
      });
      if (isOwnerBound) ownerBound.add(executionId);
    }
    respond(id, projectPipelineExecution(state));
  };

  /** The stored state, or the live run's while it isn't terminal. */
  const currentState = async (
    dir: string,
    executionId: string,
  ): Promise<ExecutionState | null> => {
    const stored = await loadExecutionState(executionId, dir);
    return stored && TERMINAL.has(stored.status)
      ? stored
      : (runs.get(executionId)?.handle.getState() ?? stored);
  };

  const get = async (
    id: number,
    dir: string,
    executionId: string,
    detail: boolean,
  ): Promise<void> => {
    const state = await currentState(dir, executionId);
    if (state === null) return respond(id, null);
    respond(
      id,
      detail
        ? projectPipelineExecutionView(state, { detail: true })
        : projectPipelineExecution(state),
    );
  };

  const cancel = async (
    id: number,
    dir: string,
    executionId: string,
    mode: 'finalize' | 'drain',
  ): Promise<void> => {
    const live = runs.get(executionId)?.handle;
    const ownerRequests = runs.get(executionId)?.ownerRequests;
    try {
      if (mode === 'drain') {
        if (live) {
          await requestExecutionCancellation(executionId, dir);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS);
          });
          const cancelling = live.cancel();
          // A step waiting on its owner ends only once that request does.
          ownerRequests?.abort();
          const outcome = await Promise.race([cancelling, timedOut]);
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
      ownerRequests?.abort();
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
    // Runs that already reported their outcome still clear their cancellation
    // marker under the data root; the answer waits for them too.
    const retiring = [...finishing]
      .filter(([handle]) => !live.includes(handle))
      .map(([, finished]) => finished);
    const pausing = live.map((handle) =>
      handle.pauseForShutdown
        ? handle.pauseForShutdown()
        : Promise.reject(new Error('The run cannot pause.')),
    );
    // A step waiting on its owner pauses only once that request ends; the
    // supervisor has already withdrawn its relays, so nothing would settle it.
    ownerRequests?.close();
    const settled = await Promise.allSettled(pausing);
    await Promise.allSettled(retiring);
    // Its app-servers end before the answer, so nothing outlives the checkpoint (D17).
    await shutdownDaemonPipelineCodexRuntime().catch(() =>
      warn('The pipeline host could not stop its Codex runtime.'),
    );
    if (settled.some((result) => result.status === 'rejected'))
      return fail(id, 'checkpoint_failed');
    respond(id, { checkpointedCount: live.length });
  };

  /** Pauses the owner-bound runs named: their owner is gone (CAN-5771). Admission stays open. */
  const pause = async (
    id: number,
    executionIds: string[],
    reason: 'owner_lost' | undefined,
  ): Promise<void> => {
    const live = executionIds
      .filter((executionId) => ownerBound.has(executionId))
      .flatMap((executionId) => {
        const run = runs.get(executionId);
        return run ? [run] : [];
      });
    const pausing = live.map(({ handle }) => {
      // A remote owner's loss records its own reason (CAN-6102).
      const paused =
        reason === 'owner_lost'
          ? handle.pauseForOwnerLoss?.()
          : handle.pauseForShutdown?.();
      return paused ?? Promise.reject(new Error('The run cannot pause.'));
    });
    for (const run of live) run.ownerRequests?.abort();
    const settled = await Promise.allSettled(pausing);
    if (settled.some((result) => result.status === 'rejected'))
      return fail(id, 'checkpoint_failed');
    respond(id, { pausedCount: live.length });
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
      dataRoot = request.dataRoot;
      codexMcpLauncher = request.codexMcpLauncher ?? null;
      const hostChannel = {
        raise: (hostRequest: WorkerPipelineHostRequest): void =>
          post({ kind: 'hostRequest', request: hostRequest }),
        withdraw: (executionId: string, requestId: string): void =>
          post({ kind: 'hostRequestWithdrawn', executionId, requestId }),
      };
      hostSteps ??= createDaemonHostStepPort(hostChannel);
      ownerRequests ??= createPipelineOwnerClient(hostChannel);
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
        return get(id, dir, request.executionId, request.detail === true);
      case 'list':
        return respond(
          id,
          await listPipelineExecutionPage(
            await listExecutionSummaries(dir),
            (executionId) => currentState(dir, executionId),
            request.query,
          ),
        );
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
        await checkpoint(id);
        hostSteps?.close();
        return;
      case 'hostSettled': {
        const { requestId, settlement } = request;
        if (
          !ownerRequests?.settle(requestId, settlement) &&
          settlement.kind !== 'owner'
        )
          hostSteps?.settle(requestId, settlement);
        return respond(id, null);
      }
      case 'pause':
        return pause(id, request.executionIds, request.reason);
      case 'exit':
        admissionOpen = false;
        hostSteps?.close();
        ownerRequests?.close();
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
