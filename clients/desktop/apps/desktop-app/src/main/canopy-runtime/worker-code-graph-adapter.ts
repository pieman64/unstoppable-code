import { randomUUID } from 'node:crypto';
import {
  codeGraphQueueUnavailableError,
  createCodeGraphBuildQueueWorker,
  createWorkerCodeGraphHandlers,
  projectCodeGraphBuildQueue as projectSchedulerQueue,
  type CodeGraphBuildQueueWorker,
  type WorkerCodeGraphHandlers,
} from '@canopy/core-runtime/node/code-graph';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  CanopyInstructionOptions,
  CanopyQueryOptions,
} from '@canopy/core-runtime';
import {
  WORKER_CODE_GRAPH_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerCodeGraphBuildCancelParams,
  type WorkerCodeGraphBuildCancelResult,
  type WorkerCodeGraphBuildParams,
  type WorkerCodeGraphBuildResult,
  type WorkerCodeGraphBuildQueue,
  type WorkerCodeGraphBuildQueueGetParams,
  type WorkerCodeGraphBuildQueueUpdateParams,
  type WorkerCodeGraphQueueItem,
} from '@canopy/protocol/canopy-core';
import type {
  CodeGraphBuildQueueStatus,
  CodeGraphReorderGenerationQueueResult,
} from '@canopy/code-graph/host/build-scheduler';
import type {
  CodeGraphGenerationQueueSnapshot,
  CodeGraphQueueEntry,
  CodeGraphReorderGenerationQueueRequest,
  CodeGraphReorderGenerationQueueResponse,
} from '@canopy/desktop-shared/types';
import { onDaemonCodeGraphRoute } from '../code-graph/daemon-code-graph-route-context';

/*
 * Registers the code-graph build queue controls (CAN-4149) on the desktop
 * dispatcher over Electron main's build scheduler, and projects the
 * `code-graph:*-generation-queue` channels over them. The scheduler loads on
 * the first call, because its host modules import back into main.
 */

/** The scheduler surface the build and queue operations need. */
export interface DesktopCodeGraphBuildQueue {
  build(
    graphScope: WorkerCodeGraphBuildParams['graphScope'],
  ): Promise<WorkerCodeGraphBuildResult>;
  queueStatus(): CodeGraphBuildQueueStatus;
  reorderQueue(
    request: CodeGraphReorderGenerationQueueRequest,
  ): CodeGraphReorderGenerationQueueResult;
  cancelQueueItem(
    queueItemId: string,
  ): Promise<CodeGraphQueueEntry['status'] | null>;
  cancelWorktree(workspaceId: string, worktreeId: string): Promise<number>;
}

/** Projects the scheduler's queue; see `@canopy/core-runtime/node/code-graph`. */
export const projectCodeGraphBuildQueue = projectSchedulerQueue;

export function createDesktopCodeGraphBuildQueueWorker(
  scheduler: DesktopCodeGraphBuildQueue,
  now: () => number = Date.now,
): CodeGraphBuildQueueWorker {
  return createCodeGraphBuildQueueWorker(scheduler, now);
}

export function createWorkerCodeGraphAdapter(
  load: () => Promise<DesktopCodeGraphBuildQueue> = () =>
    Promise.all([
      import('../code-graph/build-runner'),
      import('../code-graph/fingerprint-runner'),
      import('../lib/code-graph-worker-builds'),
      import('@canopy/code-graph/host/worktree-build-service'),
    ]).then(([runner, fingerprints, builds, generations]) => ({
      build: builds.buildCodeGraph,
      queueStatus: runner.getCodeGraphBuildQueueStatus,
      reorderQueue: runner.reorderCodeGraphGenerationQueue,
      cancelQueueItem: runner.cancelCodeGraphQueueItem,
      // As worktree cleanup does in process: generations still preparing,
      // then the fingerprint and every build of the key together, resolving
      // once each host has exited.
      cancelWorktree: async (workspaceId, worktreeId) => {
        const key = `${workspaceId}/${worktreeId}`;
        const unqueued = builds.abortPreparingCodeGraphBuilds(
          workspaceId,
          worktreeId,
        );
        const queued = runner
          .getCodeGraphBuildQueueStatus()
          .entries.filter(
            (entry) =>
              entry.scope === 'worktree' &&
              entry.worktreeId === worktreeId &&
              entry.workspaceIds.includes(workspaceId),
          ).length;
        await generations.cancelCodeGraphWorktreeHosts(key, {
          fingerprints: { cancel: fingerprints.cancelCodeGraphFingerprint },
          builds: { cancel: (buildKey) => runner.cancelBuild(buildKey) },
        });
        return unqueued + queued;
      },
    })),
): WorkerCodeGraphHandlers {
  let loading: Promise<WorkerCodeGraphHandlers> | undefined;
  const handlers = (): Promise<WorkerCodeGraphHandlers> =>
    (loading ??= load().then(
      (scheduler) =>
        createWorkerCodeGraphHandlers(
          createDesktopCodeGraphBuildQueueWorker(scheduler),
        ),
      (error: unknown) => {
        loading = undefined;
        throw codeGraphQueueUnavailableError(error);
      },
    ));
  return {
    queries: {
      'worker.codeGraph.buildQueue.get': async (params, context) =>
        (await handlers()).queries['worker.codeGraph.buildQueue.get'](
          params,
          context,
        ),
    },
    instructions: {
      'worker.codeGraph.build': (params, context) => {
        const inProcess = async (): Promise<WorkerCodeGraphBuildResult> =>
          (await handlers()).instructions['worker.codeGraph.build'](
            params,
            context,
          );
        const { graphScope } = params;
        // Only a renderer worktree build may take the daemon route (CAN-5089).
        return graphScope.kind === 'worktree'
          ? onDaemonCodeGraphRoute(
              (daemon) => daemon.buildCodeGraphInDaemon(graphScope),
              inProcess,
            )
          : inProcess();
      },
      'worker.codeGraph.buildQueue.update': async (params, context) =>
        (await handlers()).instructions['worker.codeGraph.buildQueue.update'](
          params,
          context,
        ),
      'worker.codeGraph.build.cancel': async (params, context) =>
        (await handlers()).instructions['worker.codeGraph.build.cancel'](
          params,
          context,
        ),
      'worker.codeGraph.builds.cancel': async (params, context) =>
        (await handlers()).instructions['worker.codeGraph.builds.cancel'](
          params,
          context,
        ),
    },
  };
}

// --- The generation queue channels over the dispatcher ----------------------

export interface WorkerCodeGraphDispatcher {
  query(
    name: 'worker.codeGraph.buildQueue.get',
    params: WorkerCodeGraphBuildQueueGetParams,
    options: CanopyQueryOptions,
  ): Promise<WorkerCodeGraphBuildQueue>;
  instruction(
    name: 'worker.codeGraph.buildQueue.update',
    params: WorkerCodeGraphBuildQueueUpdateParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerCodeGraphBuildQueue>;
  instruction(
    name: 'worker.codeGraph.build.cancel',
    params: WorkerCodeGraphBuildCancelParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerCodeGraphBuildCancelResult>;
  instruction(
    name: 'worker.codeGraph.build',
    params: WorkerCodeGraphBuildParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerCodeGraphBuildResult>;
}

function queueEntry(item: WorkerCodeGraphQueueItem): CodeGraphQueueEntry {
  return {
    id: item.queueItemId,
    scope: item.graphScope === 'worktree' ? 'worktree' : 'workspace-shadow',
    workspaceIds: [...item.workspaceIds],
    ...(item.workspaceLabel === null
      ? {}
      : { workspaceLabel: item.workspaceLabel }),
    ...(item.worktreeId === null ? {} : { worktreeId: item.worktreeId }),
    ...(item.repositoryId === null ? {} : { repositoryId: item.repositoryId }),
    ...(item.label === null ? {} : { label: item.label }),
    trigger: item.trigger,
    queuedAt: Date.parse(item.enqueuedAt),
    startedAt: item.startedAt === null ? null : Date.parse(item.startedAt),
    status: item.state,
    reorderable: item.reorderable,
  };
}

/** The renderer's queue snapshot of a worker queue. */
export function generationQueueSnapshot(
  queue: WorkerCodeGraphBuildQueue,
): CodeGraphGenerationQueueSnapshot {
  return { revision: queue.revision, entries: queue.items.map(queueEntry) };
}

function readCaller(caller: CanopyCallerDescriptor): CanopyCallerDescriptor {
  return { ...caller, grants: [WORKER_CODE_GRAPH_GRANTS.read] };
}

function writeCaller(caller: CanopyCallerDescriptor): CanopyCallerDescriptor {
  return { ...caller, grants: [WORKER_CODE_GRAPH_GRANTS.write] };
}

/** `code-graph:get-generation-queue` over `worker.codeGraph.buildQueue.get`. */
export async function readGenerationQueue(
  dispatcher: WorkerCodeGraphDispatcher,
  caller: CanopyCallerDescriptor,
): Promise<CodeGraphGenerationQueueSnapshot> {
  return generationQueueSnapshot(
    await dispatcher.query(
      'worker.codeGraph.buildQueue.get',
      {},
      { caller: readCaller(caller) },
    ),
  );
}

/**
 * `code-graph:reorder-generation-queue` over
 * `worker.codeGraph.buildQueue.update`. A refusal keeps the channel's
 * envelope: a changed queue answers `conflict` with the current snapshot,
 * and a wrong order `invalid-request` with the scheduler's message.
 */
export async function reorderGenerationQueue(
  dispatcher: WorkerCodeGraphDispatcher,
  caller: CanopyCallerDescriptor,
  request: CodeGraphReorderGenerationQueueRequest,
): Promise<CodeGraphReorderGenerationQueueResponse> {
  try {
    return generationQueueSnapshot(
      await dispatcher.instruction(
        'worker.codeGraph.buildQueue.update',
        {
          expectedRevision: request.revision,
          orderedQueueItemIds: request.orderedQueuedEntryIds,
        },
        {
          caller: writeCaller(caller),
          metadata: { idempotencyKey: randomUUID() },
        },
      ),
    );
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    if (error.payload.code === 'worker.codeGraph.queueChanged')
      return {
        ok: false,
        code: 'conflict',
        message: error.payload.message,
        snapshot: await readGenerationQueue(dispatcher, caller),
      };
    if (error.payload.kind === 'invalid_argument')
      return {
        ok: false,
        code: 'invalid-request',
        message:
          error.payload.code === 'worker.codeGraph.queueOrderInvalid'
            ? error.payload.message
            : 'The generation queue reorder request is invalid.',
      };
    throw error;
  }
}

/**
 * `code-graph:build-worktree` and `code-graph:build-workspace` over
 * `worker.codeGraph.build`, holding only the write grant. Refusals stay
 * typed so each channel keeps its envelope.
 */
export function buildCodeGraphThroughWorker(
  dispatcher: WorkerCodeGraphDispatcher,
  caller: CanopyCallerDescriptor,
  graphScope: WorkerCodeGraphBuildParams['graphScope'],
): Promise<WorkerCodeGraphBuildResult> {
  return dispatcher.instruction(
    'worker.codeGraph.build',
    { graphScope },
    {
      caller: writeCaller(caller),
      metadata: { idempotencyKey: randomUUID() },
    },
  );
}
