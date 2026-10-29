import {
  WORKER_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError, type CanopyDispatcher } from '../../index';
import { CANOPY_RUNTIME_QUERY_DEFINITIONS } from '../canopy-runtime';
import {
  createRuntimeProfileGraph,
  defineRuntimeModule,
  type RuntimeModule,
} from '../runtime-profile-graph';
import type { RuntimeService } from '../service-container';
import { serializingWorkerPair } from '../../runtime/__tests__/serializing-worker-pair';
import { canopyUnavailableError } from '../../runtime/errors';

const caller: CanopyCallerDescriptor = {
  principalId: 'test',
  clientInstanceId: 'client',
  authorityId: 'authority',
  interfaceKind: 'test',
  grants: ['core.runtime.read', 'worker.filesystem.read'],
};
const none = { queries: {}, instructions: {}, streams: {} };
const roots = {
  roots: [{ fileRootId: 'root', name: 'repo', kind: 'git-repo' as const }],
};
let log: string[] = [];
beforeEach(() => {
  log = [];
});
const service = (
  name: string,
  plane: RuntimeService['plane'],
): RuntimeService => ({
  name,
  plane,
  start: () => void log.push(`start ${name}`),
  stop: { 7: () => void log.push(`stop ${name}`) },
});
const files = (): RuntimeModule =>
  defineRuntimeModule({
    name: 'worker.filesystem',
    plane: 'worker',
    services: [service('files', 'worker')],
    definitions: { ...none, queries: WORKER_QUERY_DEFINITIONS },
    handlers: {
      ...none,
      queries: {
        'worker.filesystem.roots.list': () => roots,
        'worker.filesystem.directory.list': () => ({ entries: [] }),
      },
    },
  });
const store: RuntimeModule = {
  name: 'core.store',
  plane: 'core',
  services: [service('store', 'core')],
  definitions: none,
  handlers: none,
};
const create = (
  profile: 'core' | 'worker' | 'core+worker',
  modules: RuntimeModule[],
  workerCaller?: CanopyCallerDescriptor,
): ReturnType<typeof createRuntimeProfileGraph> =>
  createRuntimeProfileGraph({
    profile,
    modules,
    workerCaller,
    workerBinding:
      workerCaller === undefined ? undefined : serializingWorkerPair(),
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
    shutdownTimeoutMs: 50,
  });
const list = (dispatcher: CanopyDispatcher): Promise<unknown> =>
  dispatcher.query(
    'worker.filesystem.roots.list',
    { scope: { workspaceId: 'workspace' } },
    { caller },
  );
const kind = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CanopyOperationError ? error.payload.kind : 'thrown',
  );

it('drains admitted worker queries before closing the bundled binding', async () => {
  const module = files();
  let release = (): void => undefined;
  const result = new Promise<typeof roots>((resolve) => {
    release = (): void => resolve(roots);
  });
  const handler = jest.fn(() => result);
  const pair = serializingWorkerPair();
  const graph = createRuntimeProfileGraph({
    profile: 'core+worker',
    modules: [
      {
        ...module,
        handlers: {
          ...module.handlers,
          queries: {
            ...module.handlers.queries,
            'worker.filesystem.roots.list': handler,
          },
        },
      },
    ],
    workerCaller: caller,
    workerBinding: pair,
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
    shutdownTimeoutMs: 500,
  });
  await graph.start();
  const query = list(graph.dispatcher).catch((error: unknown) => error);
  await new Promise((resolve) => setImmediate(resolve));
  expect(handler).toHaveBeenCalledTimes(1);
  const shutdown = graph.shutdown('test');
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(pair.server.signal.aborted).toBe(false);
    release();
    expect(await query).toEqual(roots);
    await shutdown;
    expect(pair.server.signal.aborted).toBe(true);
  } finally {
    release();
    await shutdown;
  }
});

it.each(['core', 'worker', 'core+worker'] as const)(
  'constructs %s with isolated operations and seven shutdown phases',
  async (profile) => {
    const modules =
      profile === 'core'
        ? [store]
        : profile === 'worker'
          ? [files()]
          : [store, files()];
    const graph = create(profile, modules, caller);
    await graph.start();
    expect(graph.health().state).toBe('ready');
    if (profile === 'core')
      expect(await kind(list(graph.dispatcher))).toBe('capability_unavailable');
    else expect(await list(graph.dispatcher)).toEqual(roots);
    const health = graph.dispatcher.query(
      'core.runtime.health.get',
      {},
      { caller },
    );
    if (profile === 'worker')
      expect(await kind(health)).toBe('capability_unavailable');
    else
      expect(await health).toMatchObject({
        runtime: { profile, state: 'ready' },
      });
    expect(
      graph.operations.every(
        (op) => profile === 'core+worker' || op.plane === profile,
      ),
    ).toBe(true);
    expect((await graph.shutdown('test')).phases).toMatchObject(
      [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, status: 'completed' })),
    );
    expect(graph.dispatcher.state).toBe('closed');
    const names = modules.flatMap(
      (module) => module.services?.map(({ name }) => name) ?? [],
    );
    expect(log).toEqual([
      ...names.map((name) => `start ${name}`),
      ...names.reverse().map((name) => `stop ${name}`),
    ]);
  },
);

it('uses a host-bound worker caller and preserves both grant checks', async () => {
  const module = files();
  const seen = jest.fn(() => roots);
  module.handlers = {
    ...module.handlers,
    queries: {
      ...module.handlers.queries,
      'worker.filesystem.roots.list': seen,
    },
  };
  const graph = create('core+worker', [module], { ...caller, grants: [] });
  expect(await kind(list(graph.dispatcher))).toBe('permission_denied');
  expect(seen).not.toHaveBeenCalled();
  await graph.shutdown('test');
  const allowed = create('core+worker', [module], caller);
  const denied = allowed.dispatcher.query(
    'worker.filesystem.roots.list',
    { scope: {} },
    { caller: { ...caller, grants: [] } },
  );
  expect(await kind(denied)).toBe('permission_denied');
  expect(seen).not.toHaveBeenCalled();
  await allowed.shutdown('test');
});

it('requires an injected binding instead of falling back to worker handler calls', () => {
  expect(() =>
    createRuntimeProfileGraph({
      profile: 'core+worker',
      modules: [files()],
      workerCaller: caller,
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
    }),
  ).toThrow('workerBinding');
});

it('crosses the injected request and response binding before returning worker results', async () => {
  const pair = serializingWorkerPair();
  const graph = createRuntimeProfileGraph({
    profile: 'core+worker',
    modules: [files()],
    workerCaller: caller,
    ...{ workerBinding: pair },
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
  });
  try {
    expect(await list(graph.dispatcher)).toEqual(roots);
    expect(pair.client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'worker.filesystem.roots.list',
      }),
    );
    expect(pair.server.send).toHaveBeenCalledWith(
      expect.objectContaining({ result: roots }),
    );
  } finally {
    await graph.shutdown('test');
    pair.client.close();
  }
});

it('cannot bypass a failed binding to reach worker handlers', async () => {
  const pair = serializingWorkerPair();
  pair.client.send.mockRejectedValue(canopyUnavailableError());
  const module = files();
  const seen = jest.fn(() => roots);
  module.handlers = {
    ...module.handlers,
    queries: {
      ...module.handlers.queries,
      'worker.filesystem.roots.list': seen,
    },
  };
  const graph = createRuntimeProfileGraph({
    profile: 'core+worker',
    modules: [module],
    workerCaller: caller,
    workerBinding: pair,
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
  });
  try {
    expect(await kind(list(graph.dispatcher))).toBe('unavailable');
    expect(seen).not.toHaveBeenCalled();
  } finally {
    await graph.shutdown('test');
  }
});

it('preserves a bundled worker error payload across both envelopes', async () => {
  const module = files();
  const payload = {
    kind: 'not_found' as const,
    message: 'Missing root.',
    retry: { kind: 'never' as const },
    details: { fileRootId: 'missing' },
  };
  module.handlers = {
    ...module.handlers,
    queries: {
      ...module.handlers.queries,
      'worker.filesystem.roots.list': (): never => {
        throw new CanopyOperationError(payload, new Error('private cause'));
      },
    },
  };
  const graph = create('core+worker', [module], caller);
  try {
    await expect(list(graph.dispatcher)).rejects.toMatchObject({
      payload,
      runtimeCause: undefined,
    });
  } finally {
    await graph.shutdown('test');
  }
});

it('rejects foreign planes, SDKs, ownership mismatches, missing handlers and absent operations', () => {
  const reject = (
    profile: 'core' | 'worker' | 'core+worker',
    modules: RuntimeModule[],
    message: string,
  ): void => {
    expect(() => create(profile, modules)).toThrow(message);
  };
  reject('core', [files()], 'cannot host worker module');
  reject('worker', [store], 'cannot host core module');
  for (const profile of ['core', 'core+worker'] as const)
    reject(
      profile,
      [{ ...store, providerSdk: true }],
      'cannot carry a provider SDK',
    );
  reject('core+worker', [files()], 'require a workerCaller');
  reject(
    'core+worker',
    [{ ...files(), services: [service('store', 'core')] }],
    'cannot host core service',
  );
  reject(
    'core+worker',
    [{ ...files(), plane: 'core', services: [] }],
    'cannot register worker operation',
  );
  reject('core', [store, store], 'Duplicate operation owner');
  reject(
    'core',
    [{ ...store, handlers: files().handlers }],
    'must handle exactly its own',
  );
  reject(
    'worker',
    [{ ...files(), handlers: none }],
    'must handle exactly its own',
  );
  const health = CANOPY_RUNTIME_QUERY_DEFINITIONS['core.runtime.health.get'];
  for (const operation of ['core.absent.read', 'core.runtime.shadow'])
    reject(
      'core',
      [
        {
          ...store,
          definitions: { ...none, queries: { [operation]: health } },
          handlers: { ...none, queries: { [operation]: (): unknown => ({}) } },
        },
      ],
      'does not install',
    );
});

it('fails closed when the host supplies no principal resolver', async () => {
  const graph = create('core', []);
  await expect(
    graph.dispatcher.query('core.runtime.manifest.get', {}, { caller }),
  ).resolves.toMatchObject({ operations: [] });
  await graph.shutdown('test');
});
