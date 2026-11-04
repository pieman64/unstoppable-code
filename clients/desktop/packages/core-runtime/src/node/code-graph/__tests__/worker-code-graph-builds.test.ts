import {
  WORKER_CODE_GRAPH_GRANTS,
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerCodeGraphBuildQueue,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyDispatcher } from '../../../runtime/types';
import { createWorkerExecutorReceipts } from '../../../runtime/worker-executor-receipts';
import {
  codeGraphBuildFailedError,
  codeGraphBuildRefusalOf,
  codeGraphBuildTimedOutError,
  createWorkerCodeGraphHandlers,
  type CodeGraphBuildQueueWorker,
} from '../worker-code-graph-builds';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'desktop-core',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [WORKER_CODE_GRAPH_GRANTS.read, WORKER_CODE_GRAPH_GRANTS.write],
};

const queue: WorkerCodeGraphBuildQueue = {
  revision: 4,
  items: [
    {
      queueItemId: 'running-item',
      graphScope: 'worktree',
      workspaceIds: ['alpha'],
      worktreeId: 'main',
      repositoryId: null,
      workspaceLabel: 'Alpha',
      label: 'main',
      trigger: 'refresh',
      priority: 'worktree',
      state: 'running',
      reorderable: false,
      enqueuedAt: '2026-11-02T10:00:00.000Z',
      startedAt: '2026-11-02T10:00:02.000Z',
      timing: { queueWaitMs: 2_000, runningMs: 5_000 },
    },
    {
      queueItemId: 'base-item',
      graphScope: 'workspace_base',
      workspaceIds: ['alpha', 'beta'],
      worktreeId: null,
      repositoryId: 'repo',
      workspaceLabel: null,
      label: 'repo',
      trigger: 'maintenance',
      priority: 'maintenance',
      state: 'queued',
      reorderable: true,
      enqueuedAt: '2026-11-02T10:00:01.000Z',
      startedAt: null,
      timing: { queueWaitMs: 6_000, runningMs: null },
    },
  ],
};

function harness(worker: CodeGraphBuildQueueWorker): CanopyDispatcher {
  const handlers = createWorkerCodeGraphHandlers(worker);
  const instructions = WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS;
  return createCanopyDispatcher({
    profile: 'core+worker',
    definitions: {
      queries: WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
      instructions,
      streams: {},
    },
    handlers: {
      queries: handlers.queries,
      instructions: createWorkerExecutorReceipts(instructions).wrap(
        handlers.instructions,
      ),
      streams: {},
    },
  });
}

function worker(
  overrides: Partial<CodeGraphBuildQueueWorker> = {},
): CodeGraphBuildQueueWorker {
  return {
    queue: () => queue,
    reorder: () => ({ ok: true, queue }),
    cancel: () => Promise.resolve(null),
    build: () => Promise.reject(new Error('Not built here.')),
    cancelWorktree: () => Promise.resolve(0),
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error.payload;
    throw error;
  }
  throw new Error('Expected a refusal.');
}

describe('worker.codeGraph build queue controls', () => {
  it('serves the queue with its classes and diagnostic timing', async () => {
    const dispatcher = harness(worker());

    await expect(
      dispatcher.query('worker.codeGraph.buildQueue.get', {}, { caller }),
    ).resolves.toEqual(queue);
  });

  it('refuses a caller without the read grant', async () => {
    const dispatcher = harness(worker());

    await expect(
      refusal(
        dispatcher.query(
          'worker.codeGraph.buildQueue.get',
          {},
          { caller: { ...caller, grants: [WORKER_CODE_GRAPH_GRANTS.write] } },
        ),
      ),
    ).resolves.toMatchObject({ kind: 'permission_denied' });
  });

  it('reorders queued items under the expected revision', async () => {
    const reorder = jest.fn<
      ReturnType<CodeGraphBuildQueueWorker['reorder']>,
      Parameters<CodeGraphBuildQueueWorker['reorder']>
    >(() => ({ ok: true, queue }));
    const dispatcher = harness(worker({ reorder }));

    await expect(
      dispatcher.instruction(
        'worker.codeGraph.buildQueue.update',
        { expectedRevision: 4, orderedQueueItemIds: ['base-item'] },
        { caller, metadata: { idempotencyKey: 'key-reorder' } },
      ),
    ).resolves.toEqual(queue);
    expect(reorder).toHaveBeenCalledWith(4, ['base-item']);
  });

  it('refuses a stale revision as a conflict to refresh and a wrong order as invalid', async () => {
    const changed = harness(
      worker({
        reorder: () => ({
          ok: false,
          refusal: 'changed',
          message: 'The generation queue changed. Reload it and try again.',
        }),
      }),
    );
    await expect(
      refusal(
        changed.instruction(
          'worker.codeGraph.buildQueue.update',
          { expectedRevision: 3, orderedQueueItemIds: ['base-item'] },
          { caller, metadata: { idempotencyKey: 'key-changed' } },
        ),
      ),
    ).resolves.toEqual({
      kind: 'conflict',
      code: 'worker.codeGraph.queueChanged',
      message: 'The generation queue changed. Reload it and try again.',
      retry: { kind: 'after_refresh', resource: 'worker.codeGraph.buildQueue' },
    });

    const invalid = harness(
      worker({
        reorder: () => ({
          ok: false,
          refusal: 'invalid-order',
          message: 'The reorder contains an unknown or non-queued generation.',
        }),
      }),
    );
    await expect(
      refusal(
        invalid.instruction(
          'worker.codeGraph.buildQueue.update',
          { expectedRevision: 4, orderedQueueItemIds: ['running-item'] },
          { caller, metadata: { idempotencyKey: 'key-invalid' } },
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'invalid_argument',
      code: 'worker.codeGraph.queueOrderInvalid',
      message: 'The reorder contains an unknown or non-queued generation.',
    });
  });

  it('cancels a queued or running item once its host has exited', async () => {
    let exited = false;
    const dispatcher = harness(
      worker({
        cancel: async (queueItemId) => {
          await Promise.resolve();
          exited = true;
          return { queueItemId, canceledState: 'running' };
        },
      }),
    );

    await expect(
      dispatcher.instruction(
        'worker.codeGraph.build.cancel',
        { queueItemId: 'running-item' },
        { caller, metadata: { idempotencyKey: 'key-cancel' } },
      ),
    ).resolves.toEqual({
      queueItemId: 'running-item',
      canceledState: 'running',
    });
    expect(exited).toBe(true);
  });

  it('refuses to cancel an item that is not queued or running', async () => {
    const dispatcher = harness(worker());

    await expect(
      refusal(
        dispatcher.instruction(
          'worker.codeGraph.build.cancel',
          { queueItemId: 'finished-item' },
          { caller, metadata: { idempotencyKey: 'key-missing' } },
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'not_found',
      code: 'worker.codeGraph.queueItemNotFound',
    });
  });

  it('refuses a cancel without the write grant before reaching the worker', async () => {
    const cancel = jest.fn<
      ReturnType<CodeGraphBuildQueueWorker['cancel']>,
      Parameters<CodeGraphBuildQueueWorker['cancel']>
    >(() => Promise.resolve(null));
    const dispatcher = harness(worker({ cancel }));

    await expect(
      refusal(
        dispatcher.instruction(
          'worker.codeGraph.build.cancel',
          { queueItemId: 'running-item' },
          {
            caller: { ...caller, grants: [WORKER_CODE_GRAPH_GRANTS.read] },
            metadata: { idempotencyKey: 'key-denied' },
          },
        ),
      ),
    ).resolves.toMatchObject({ kind: 'permission_denied' });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('replays a keyed reorder retry instead of reordering again, and refuses the key with other parameters', async () => {
    const reorder = jest.fn<
      ReturnType<CodeGraphBuildQueueWorker['reorder']>,
      Parameters<CodeGraphBuildQueueWorker['reorder']>
    >(() => ({ ok: true, queue }));
    const dispatcher = harness(worker({ reorder }));
    const options = { caller, metadata: { idempotencyKey: 'reorder-once' } };
    const params = { expectedRevision: 4, orderedQueueItemIds: ['base-item'] };

    await expect(
      dispatcher.instruction(
        'worker.codeGraph.buildQueue.update',
        params,
        options,
      ),
    ).resolves.toEqual(queue);
    await expect(
      dispatcher.instruction(
        'worker.codeGraph.buildQueue.update',
        params,
        options,
      ),
    ).resolves.toEqual(queue);
    expect(reorder).toHaveBeenCalledTimes(1);

    await expect(
      refusal(
        dispatcher.instruction(
          'worker.codeGraph.buildQueue.update',
          { expectedRevision: 5, orderedQueueItemIds: ['base-item'] },
          options,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'conflict',
      code: 'worker.codeGraph.idempotencyKeyReused',
    });
    expect(reorder).toHaveBeenCalledTimes(1);
  });

  it('joins a keyed cancel retry while the first is still waiting for the host', async () => {
    let finish: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cancel = jest.fn<
      ReturnType<CodeGraphBuildQueueWorker['cancel']>,
      Parameters<CodeGraphBuildQueueWorker['cancel']>
    >(async (queueItemId) => {
      await exited;
      return { queueItemId, canceledState: 'running' };
    });
    const dispatcher = harness(worker({ cancel }));
    const options = { caller, metadata: { idempotencyKey: 'cancel-once' } };
    const params = { queueItemId: 'running-item' };

    const first = dispatcher.instruction(
      'worker.codeGraph.build.cancel',
      params,
      options,
    );
    const retry = dispatcher.instruction(
      'worker.codeGraph.build.cancel',
      params,
      options,
    );
    finish();

    await expect(Promise.all([first, retry])).resolves.toEqual([
      { queueItemId: 'running-item', canceledState: 'running' },
      { queueItemId: 'running-item', canceledState: 'running' },
    ]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('builds through the worker, replays a keyed retry and redacts an untyped failure', async () => {
    const built = {
      kind: 'workspace_base' as const,
      repositories: [{ repositoryId: 'repo', outcome: 'built' as const }],
    };
    const build = jest.fn<
      ReturnType<CodeGraphBuildQueueWorker['build']>,
      Parameters<CodeGraphBuildQueueWorker['build']>
    >(() => Promise.resolve(built));
    const dispatcher = harness(worker({ build }));
    const params = {
      graphScope: { kind: 'workspace_base' as const, workspaceId: 'alpha' },
    };
    const options = { caller, metadata: { idempotencyKey: 'build-once' } };

    await expect(
      dispatcher.instruction('worker.codeGraph.build', params, options),
    ).resolves.toEqual(built);
    await expect(
      dispatcher.instruction('worker.codeGraph.build', params, options),
    ).resolves.toEqual(built);
    expect(build).toHaveBeenCalledTimes(1);

    const failing = harness(
      worker({
        build: () => Promise.reject(new Error('opening /private/graph.db')),
      }),
    );
    const payload = await refusal(
      failing.instruction('worker.codeGraph.build', params, {
        caller,
        metadata: { idempotencyKey: 'build-fails' },
      }),
    );
    expect(payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.codeGraph.buildFailed',
      details: { failure: 'internal' },
    });
    expect(JSON.stringify(payload)).not.toContain('/private/');
  });

  it("passes a scheduler's background request to the worker and refuses one also requested by an agent", async () => {
    const build = jest.fn<
      ReturnType<CodeGraphBuildQueueWorker['build']>,
      Parameters<CodeGraphBuildQueueWorker['build']>
    >(() =>
      Promise.resolve({
        kind: 'workspace_base' as const,
        repositories: [],
      }),
    );
    const dispatcher = harness(worker({ build }));
    const graphScope = {
      kind: 'worktree' as const,
      workspaceId: 'alpha',
      worktreeId: 'feature',
      mode: 'incremental' as const,
      background: {
        trigger: 'refresh' as const,
        observedFingerprint: { value: 'f'.repeat(64), observedMs: 9 },
      },
    };

    await dispatcher.instruction(
      'worker.codeGraph.build',
      { graphScope },
      { caller, metadata: { idempotencyKey: 'background' } },
    );
    expect(build).toHaveBeenCalledWith(graphScope);

    const payload = await refusal(
      dispatcher.instruction(
        'worker.codeGraph.build',
        { graphScope: { ...graphScope, requestedBy: 'agent' as const } },
        { caller, metadata: { idempotencyKey: 'background-agent' } },
      ),
    );
    expect(payload).toMatchObject({ kind: 'invalid_argument' });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('decodes a build refusal through the dispatcher, with its failure reason', async () => {
    const params = {
      graphScope: { kind: 'workspace_base' as const, workspaceId: 'alpha' },
    };
    const refused = (error: CanopyOperationError): Promise<unknown> =>
      harness(worker({ build: () => Promise.reject(error) }))
        .instruction('worker.codeGraph.build', params, {
          caller,
          metadata: { idempotencyKey: `refused-${error.payload.code}` },
        })
        .catch((thrown: unknown) => thrown);

    expect(
      codeGraphBuildRefusalOf(
        await refused(codeGraphBuildFailedError('worker_exit')),
      ),
    ).toEqual({
      code: 'worker.codeGraph.buildFailed',
      failure: 'worker_exit',
      message: 'The code graph build failed.',
    });
    expect(
      codeGraphBuildRefusalOf(await refused(codeGraphBuildTimedOutError())),
    ).toEqual({
      code: 'worker.codeGraph.buildTimedOut',
      message: 'Code graph generation timed out.',
    });
    expect(codeGraphBuildRefusalOf(new Error('plain'))).toBeNull();
  });
});
