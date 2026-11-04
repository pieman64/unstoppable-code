import {
  CanopyOperationError,
  createCanopyDispatcher,
  createWorkerExecutorReceipts,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import {
  WORKER_CODE_GRAPH_GRANTS,
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  createWorkerCodeGraphAdapter,
  type DesktopCodeGraphBuildQueue,
} from '../worker-code-graph-adapter';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'desktop-core',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [WORKER_CODE_GRAPH_GRANTS.read, WORKER_CODE_GRAPH_GRANTS.write],
};

function dispatcherOver(
  load: () => Promise<DesktopCodeGraphBuildQueue>,
): CanopyDispatcher {
  const adapter = createWorkerCodeGraphAdapter(load);
  const instructions = WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS;
  return createCanopyDispatcher({
    profile: 'core+worker',
    definitions: {
      queries: WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
      instructions,
      streams: {},
    },
    handlers: {
      queries: adapter.queries,
      instructions: createWorkerExecutorReceipts(instructions).wrap(
        adapter.instructions,
      ),
      streams: {},
    },
  });
}

async function payloadOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error.payload;
    throw error;
  }
  throw new Error('Expected a refusal.');
}

const scheduler: DesktopCodeGraphBuildQueue = {
  build: () => Promise.reject(new Error('Not built here.')),
  queueStatus: () => ({ revision: 2, entries: [] }),
  reorderQueue: () => ({ revision: 3, entries: [] }),
  cancelQueueItem: () => Promise.resolve(null),
  cancelWorktree: () => Promise.resolve(0),
};

describe('worker.codeGraph adapter', () => {
  it('answers every control with a retryable unavailable error when the scheduler cannot load', async () => {
    const dispatcher = dispatcherOver(() =>
      Promise.reject(new Error('scheduler module failed')),
    );
    const unavailable = {
      kind: 'unavailable',
      code: 'worker.codeGraph.queueUnavailable',
    };

    await expect(
      payloadOf(
        dispatcher.query('worker.codeGraph.buildQueue.get', {}, { caller }),
      ),
    ).resolves.toMatchObject(unavailable);
    await expect(
      payloadOf(
        dispatcher.instruction(
          'worker.codeGraph.buildQueue.update',
          { expectedRevision: 2, orderedQueueItemIds: [] },
          { caller, metadata: { idempotencyKey: 'update-1' } },
        ),
      ),
    ).resolves.toMatchObject(unavailable);
    await expect(
      payloadOf(
        dispatcher.instruction(
          'worker.codeGraph.build',
          { graphScope: { kind: 'workspace_base', workspaceId: 'w' } },
          { caller, metadata: { idempotencyKey: 'build-1' } },
        ),
      ),
    ).resolves.toMatchObject(unavailable);
    await expect(
      payloadOf(
        dispatcher.instruction(
          'worker.codeGraph.build.cancel',
          { queueItemId: 'item' },
          { caller, metadata: { idempotencyKey: 'cancel-1' } },
        ),
      ),
    ).resolves.toMatchObject(unavailable);
  });

  it('loads the scheduler again after a failed load', async () => {
    const load = jest
      .fn<Promise<DesktopCodeGraphBuildQueue>, []>()
      .mockRejectedValueOnce(new Error('not yet'))
      .mockResolvedValue(scheduler);
    const dispatcher = dispatcherOver(load);

    await expect(
      payloadOf(
        dispatcher.query('worker.codeGraph.buildQueue.get', {}, { caller }),
      ),
    ).resolves.toMatchObject({ code: 'worker.codeGraph.queueUnavailable' });
    await expect(
      dispatcher.query('worker.codeGraph.buildQueue.get', {}, { caller }),
    ).resolves.toEqual({ revision: 2, items: [] });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
