import {
  WORKER_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createRuntimeProfileGraph } from '../../kernel/runtime-profile-graph';
import { createCanopyDispatcher } from '../dispatcher';
import {
  connectLocalWorkerBinding,
  type LocalWorkerBindingClient,
} from '../local-worker-binding-client';
import { serveLocalWorkerBinding } from '../local-worker-binding-server';
import { createSupervisedLocalWorker } from '../supervised-local-worker';
import {
  createWorkerExecutorReceipts,
  WORKER_EXECUTOR_RECEIPTS_MAX,
} from '../worker-executor-receipts';
import { serializingWorkerPair } from './serializing-worker-pair';
import { WORKER_EXAMPLE_INSTRUCTIONS } from './worker-example-definitions';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'supervised',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.example.write', 'worker.filesystem.read'],
};
const definitions = {
  queries: {},
  instructions: WORKER_EXAMPLE_INSTRUCTIONS,
  streams: {},
};
const write = { daemonEpoch: 'epoch', sequence: 1 };
const keyed = (
  idempotencyKey: string,
): { metadata: { idempotencyKey: string } } => ({
  metadata: { idempotencyKey },
});
const WRITE = 'worker.example.write';

const pairs: ReturnType<typeof serializingWorkerPair>[] = [];
afterEach(() => {
  for (const pair of pairs.splice(0)) pair.client.close();
});

/** One worker process's worth: a receipt-recording dispatcher behind its own pair. */
function startWorker(
  handler: (params: typeof write) => Promise<typeof write> | typeof write = (
    params,
  ): typeof write => params,
): { client: LocalWorkerBindingClient; crash: () => void } {
  const pair = serializingWorkerPair();
  pairs.push(pair);
  const receipts = createWorkerExecutorReceipts(definitions.instructions);
  const dispatcher = createCanopyDispatcher({
    profile: 'worker',
    definitions,
    handlers: {
      queries: {},
      instructions: receipts.wrap({ [WRITE]: handler }),
      streams: {},
    },
    shutdownTimeoutMs: 0,
  });
  serveLocalWorkerBinding({
    dispatcher,
    definitions,
    caller,
    connection: pair.server,
    receipts,
  });
  const client = connectLocalWorkerBinding({
    definitions,
    caller,
    connection: pair.client,
  });
  return { client, crash: (): void => pair.server.close() };
}

describe('supervised local worker', () => {
  it('fails calls as unavailable, directed, while no worker is attached', async () => {
    const supervised = createSupervisedLocalWorker({ definitions });
    expect(supervised.attached()).toBe(false);
    await expect(
      supervised.transport.instruction(WRITE, write, keyed('k')),
    ).rejects.toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_idempotency_key' } },
    });
    // It never crossed to any worker, so it never arrived.
    await expect(supervised.transport.receipt(WRITE, 'k')).resolves.toBeNull();
  });

  it('routes to the attached worker and answers its receipts', async () => {
    const supervised = createSupervisedLocalWorker({ definitions });
    supervised.attach(startWorker().client);
    await expect(
      supervised.transport.instruction(WRITE, write, keyed('k')),
    ).resolves.toEqual(write);
    await expect(supervised.transport.receipt(WRITE, 'k')).resolves.toEqual({
      state: 'completed',
      result: write,
    });
  });

  it('answers unavailable, never not-started, for work sent to a worker that has gone', async () => {
    const supervised = createSupervisedLocalWorker({ definitions });
    const first = startWorker(() => new Promise(() => undefined));
    supervised.attach(first.client);
    const sent = supervised.transport.instruction(WRITE, write, keyed('k'));
    first.crash();
    await expect(sent).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    expect(supervised.attached()).toBe(false);
    supervised.attach(startWorker().client);
    expect(supervised.attached()).toBe(true);
    await expect(
      supervised.transport.receipt(WRITE, 'k'),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    await expect(
      supervised.transport.receipt(WRITE, 'other'),
    ).resolves.toBeNull();
    // Once the core records its outcome, the key is forgotten.
    supervised.transport.releaseReceipt(WRITE, 'k');
    await expect(supervised.transport.receipt(WRITE, 'k')).resolves.toBeNull();
  });

  it('asks the attached worker for a key it dropped while that key still runs', async () => {
    const supervised = createSupervisedLocalWorker({ definitions });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    supervised.attach(
      startWorker(async (params) => {
        if (params.sequence === 0) await held;
        return params;
      }).client,
    );
    const first = supervised.transport.instruction(
      WRITE,
      { ...write, sequence: 0 },
      keyed('first'),
    );
    // One more than the tracker keeps, so the running first key is dropped.
    for (let sequence = 1; sequence <= WORKER_EXECUTOR_RECEIPTS_MAX; sequence++)
      await supervised.transport.instruction(
        WRITE,
        { ...write, sequence },
        keyed(`k${sequence}`),
      );
    const receipt = supervised.transport.receipt(WRITE, 'first');
    release();
    await expect(first).resolves.toEqual({ ...write, sequence: 0 });
    await expect(receipt).resolves.toEqual({
      state: 'completed',
      result: { ...write, sequence: 0 },
    });
    // A key no worker received is still null while the dropping worker lives.
    await expect(
      supervised.transport.receipt(WRITE, 'never'),
    ).resolves.toBeNull();
  });

  it('serves a core+worker graph whose worker module lives behind it', async () => {
    const files = {
      queries: {
        'worker.filesystem.roots.list':
          WORKER_QUERY_DEFINITIONS['worker.filesystem.roots.list'],
      },
      instructions: {},
      streams: {},
    };
    const pair = serializingWorkerPair();
    pairs.push(pair);
    const worker = createRuntimeProfileGraph({
      profile: 'worker',
      identity: { runtimeId: 'w', hostId: 'h', authorityId: 'authority' },
      modules: [
        {
          name: 'worker.filesystem',
          plane: 'worker',
          definitions: files,
          handlers: {
            queries: {
              'worker.filesystem.roots.list': (): { roots: never[] } => ({
                roots: [],
              }),
            },
            instructions: {},
            streams: {},
          },
        },
      ],
      phaseDeadlineMs: 1_000,
    });
    if (worker.executor === null) throw new Error('Expected an executor.');
    serveLocalWorkerBinding({
      dispatcher: worker.dispatcher,
      definitions: worker.executor.definitions,
      receipts: worker.executor.receipts,
      caller,
      connection: pair.server,
    });
    const supervised = createSupervisedLocalWorker({ definitions: files });
    const core = createRuntimeProfileGraph({
      profile: 'core+worker',
      identity: { runtimeId: 'c', hostId: 'h', authorityId: 'authority' },
      modules: [],
      supervisedWorker: {
        modules: [{ name: 'worker.filesystem', definitions: files }],
        worker: supervised,
      },
      phaseDeadlineMs: 1_000,
    });
    const scope = { scope: { workspaceId: 'workspace' } };
    await expect(
      core.dispatcher.query('worker.filesystem.roots.list', scope, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    supervised.attach(
      connectLocalWorkerBinding({
        definitions: files,
        caller,
        connection: pair.client,
      }),
    );
    await expect(
      core.dispatcher.query('worker.filesystem.roots.list', scope, { caller }),
    ).resolves.toEqual({ roots: [] });
    expect(core.localWorker).toBe(supervised.transport);
    expect(core.operations.map(({ name, plane }) => [name, plane])).toEqual(
      expect.arrayContaining([['worker.filesystem.roots.list', 'worker']]),
    );
    expect(() =>
      createRuntimeProfileGraph({
        profile: 'core',
        identity: { runtimeId: 'c', hostId: 'h', authorityId: 'authority' },
        modules: [],
        supervisedWorker: { modules: [], worker: supervised },
        phaseDeadlineMs: 1_000,
      }),
    ).toThrow('Runtime profile core cannot supervise a worker');
  });
});
