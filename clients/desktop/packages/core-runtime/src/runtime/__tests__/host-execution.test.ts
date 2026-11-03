import {
  WORKER_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyHostExecution,
  type CanopyJsonRpcMessage,
  type CanopyOperationName,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../dispatcher';
import {
  createInProcessWorkerBinding,
  type WorkerBindingConnection,
} from '../in-process-worker-binding';
import type { CanopyHandlerContext } from '../types';
import { serializingWorkerPair } from './serializing-worker-pair';

// CAN-5496: `_execution` reaches a handler only on the operations that accept
// it, crosses the bundled worker pair beside `_meta`, and is never params.
const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'host-execution',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.filesystem.read', 'worker.git.read'],
};
const execution = {
  childEnvironment: { PATH: '/forwarded/bin', SSH_AUTH_SOCK: '/agent' },
};
const branchParams = {
  scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
  repository: { kind: 'checkout' as const },
};
const rootsParams = { scope: { workspaceId: 'workspace' } };
const definitions = {
  queries: WORKER_QUERY_DEFINITIONS,
  instructions: {},
  streams: {},
};

const pairs: ReturnType<typeof serializingWorkerPair>[] = [];
afterEach(() => {
  for (const pair of pairs.splice(0)) pair.client.close();
});

interface Seen {
  params: unknown;
  context: CanopyHandlerContext;
}

function workerDispatcher(
  seen: Seen[],
): ReturnType<typeof createCanopyDispatcher<typeof WORKER_QUERY_DEFINITIONS>> {
  const notExercised = (): never => {
    throw new Error('Not exercised.');
  };
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: WORKER_QUERY_DEFINITIONS,
    handlers: {
      'worker.filesystem.roots.list': (params, context) => {
        seen.push({ params, context });
        return { roots: [] };
      },
      'worker.filesystem.directory.list': notExercised,
      'worker.filesystem.file.read': notExercised,
      'worker.filesystem.search': notExercised,
      'worker.filesystem.link.resolve': notExercised,
      'worker.git.branch.list': (params, context) => {
        seen.push({ params, context });
        return { branches: [], defaultBranch: null, defaultBranchSource: null };
      },
      'worker.git.diff.get': notExercised,
      'worker.git.executable.get': notExercised,
      'worker.git.remote.get': notExercised,
      'worker.git.worktree.health.get': notExercised,
      'worker.script.execution.get': notExercised,
      'worker.script.execution.list': notExercised,
      'worker.pipeline.execution.get': notExercised,
    },
  });
}

describe('dispatcher', () => {
  it('gives an accepting operation a frozen copy, and others none', async () => {
    const seen: Seen[] = [];
    const dispatcher = workerDispatcher(seen);
    await dispatcher.query('worker.git.branch.list', branchParams, {
      caller,
      execution,
    });
    await dispatcher.query('worker.git.branch.list', branchParams, { caller });
    const [withEnvironment, without] = seen;
    expect(withEnvironment?.context.execution).toEqual(execution);
    expect(withEnvironment?.context.execution).not.toBe(execution);
    expect(
      Object.isFrozen(withEnvironment?.context.execution?.childEnvironment),
    ).toBe(true);
    expect(withEnvironment?.context.metadata).toEqual({});
    expect(without?.context).not.toHaveProperty('execution');
  });

  it('refuses execution on an operation that does not accept it, before the handler', async () => {
    const seen: Seen[] = [];
    await expect(
      workerDispatcher(seen).query(
        'worker.filesystem.roots.list',
        rootsParams,
        {
          caller,
          execution,
        },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(seen).toEqual([]);
  });

  it('refuses execution on worker.git.diff.get before its handler (CAN-4729)', async () => {
    // Its handler here throws a plain error, which answers `internal`.
    await expect(
      workerDispatcher([]).query(
        'worker.git.diff.get',
        {
          scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
          repoId: '__workspace_root__',
          base: 'HEAD',
          head: 'WORKTREE',
        },
        { caller, execution },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  });

  it.each([
    ['a key with =', { childEnvironment: { 'A=B': 'sentinel-value' } }],
    ['a NUL value', { childEnvironment: { A: 'sentinel-value\0' } }],
    ['an extra member', { childEnvironment: {}, sentinel: 'sentinel-value' }],
    ['a non-object environment', { childEnvironment: 'sentinel-value' }],
  ])('refuses %s with fixed text', async (_, invalid) => {
    const seen: Seen[] = [];
    const error = await workerDispatcher(seen)
      .query('worker.git.branch.list', branchParams, {
        caller,
        // Untyped peers reach the dispatcher too.
        execution: invalid as unknown as CanopyHostExecution,
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(JSON.stringify(error)).not.toContain('sentinel-value');
    expect(seen).toEqual([]);
  });
});

describe('bundled worker binding', () => {
  function bound(seen: Seen[]): {
    binding: ReturnType<typeof createInProcessWorkerBinding>;
    pair: ReturnType<typeof serializingWorkerPair>;
  } {
    const pair = serializingWorkerPair();
    pairs.push(pair);
    const binding = createInProcessWorkerBinding({
      dispatcher: workerDispatcher(seen),
      definitions,
      caller,
      pair,
    });
    return { binding, pair };
  }

  it('carries execution beside _meta to the worker, never in params', async () => {
    const seen: Seen[] = [];
    const { binding, pair } = bound(seen);
    const metadata = { traceparent: 'trace' };
    const forward = binding.forwarders.queries['worker.git.branch.list'];
    if (!forward) throw new Error('No forwarder.');
    await forward(branchParams, {
      metadata,
      signal: new AbortController().signal,
      execution,
    });
    const [request] = pair.client.send.mock.calls.map(([message]) => message);
    expect(request).toMatchObject({
      method: 'worker.git.branch.list',
      params: { ...branchParams, _meta: metadata, _execution: execution },
    });
    expect(seen[0]?.params).toEqual(branchParams);
    expect(seen[0]?.context.execution).toEqual(execution);
    expect(seen[0]?.context.metadata).toEqual(metadata);
  });

  it('refuses execution for an operation that does not accept it, before sending', async () => {
    const seen: Seen[] = [];
    const { binding, pair } = bound(seen);
    await expect(
      binding.query('worker.filesystem.roots.list', rootsParams, { execution }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(pair.client.send).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  /** A worker side driven by raw frames, as an untrusted peer would send them. */
  function rawWorker(seen: Seen[]): {
    send(message: CanopyJsonRpcMessage): Promise<void>;
    receive(): Promise<CanopyJsonRpcMessage>;
  } {
    const pair = serializingWorkerPair();
    pairs.push(pair);
    const idle: WorkerBindingConnection = {
      signal: new AbortController().signal,
      send: () => Promise.resolve(),
      receive: () => new Promise(() => undefined),
      close: () => undefined,
    };
    createInProcessWorkerBinding({
      dispatcher: workerDispatcher(seen),
      definitions,
      caller,
      pair: { client: idle, server: pair.server },
    });
    return pair.client;
  }

  it.each<[string, CanopyOperationName, object, unknown]>([
    [
      'an invalid execution',
      'worker.git.branch.list',
      branchParams,
      { childEnvironment: { 'A=B': 'x' } },
    ],
    [
      'execution on an operation that does not accept it',
      'worker.filesystem.roots.list',
      rootsParams,
      execution,
    ],
  ])(
    'answers %s from a raw peer with invalid_argument',
    async (_, method, params, value) => {
      const seen: Seen[] = [];
      const peer = rawWorker(seen);
      await peer.send({
        jsonrpc: '2.0',
        id: 'raw-1',
        method,
        params: { ...params, _execution: value },
      });
      const reply = await peer.receive();
      expect(reply).toMatchObject({
        id: 'raw-1',
        error: { data: { kind: 'invalid_argument' } },
      });
      expect(seen).toEqual([]);
    },
  );
});
