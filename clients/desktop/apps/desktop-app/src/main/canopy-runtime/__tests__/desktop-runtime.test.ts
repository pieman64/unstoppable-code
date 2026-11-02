import {
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  canopyStreamFrameType,
  composeCanopyOperationEnvelopes,
  type CanopyJsonRpcNotification,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import {
  createInMemoryFramedPair,
  runCanopyJournalConformance,
  type CanopyFramedConnection,
} from '@canopy/core-transport';
import {
  createDesktopRuntime,
  getActiveDesktopRuntimeIfAccepting,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

import {
  desktopJournalTarget,
  framedCaller,
  serveFramedRuntime,
} from './framed-runtime-bridge';

jest.mock('../../services/files-service', () => ({
  listFileTreeRoots: jest.fn(),
  listFileTreeDirectory: jest.fn(),
}));

const HEALTH = 'core.runtime.health.get';
const EVENTS = 'core.runtime.events';
const health = composeCanopyOperationEnvelopes(
  HEALTH,
  CORE_TRANSPORT_QUERY_DEFINITIONS[HEALTH],
);
const events = composeCanopyOperationEnvelopes(
  EVENTS,
  CORE_TRANSPORT_STREAM_DEFINITIONS[EVENTS],
);
const healthResult = CORE_TRANSPORT_QUERY_DEFINITIONS[HEALTH].result;
const caller = framedCaller;

async function connect(
  runtime: DesktopCanopyDispatcher,
): Promise<CanopyFramedConnection> {
  const { client, server } = await createInMemoryFramedPair();
  void serveFramedRuntime(runtime, server);
  return client;
}
async function request(
  client: CanopyFramedConnection,
  method: typeof HEALTH | typeof EVENTS,
  params: { cursor?: CanopyStreamCursor | null },
): Promise<unknown> {
  await client.send({ jsonrpc: '2.0', id: 1, method, params });
  const response = await client.receive();
  (method === HEALTH ? health : events).response.parse(response);
  return 'result' in response ? response.result : response;
}
async function notification(
  client: CanopyFramedConnection,
): Promise<CanopyJsonRpcNotification & { type: string | null }> {
  const message = await client.receive();
  events.notification?.parse(message);
  if (!('method' in message) || 'id' in message)
    throw new Error('Expected a notification.');
  return { ...message, type: canopyStreamFrameType(EVENTS, message) };
}
const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('desktop runtime kernel over in-memory framing', () => {
  it('serves health and resumes journal-cursored events through shutdown', async () => {
    const runtime = createDesktopRuntime();
    await settle();
    const first = await connect(runtime);
    const status = healthResult.parse(await request(first, HEALTH, {}));
    const { daemonEpoch } = status.runtime;
    expect(status).toEqual({
      runtime: {
        runtimeId: 'local-desktop',
        hostId: 'local-desktop',
        authorityId: 'local-desktop',
        profile: 'core+worker',
        daemonEpoch,
        protocolVersions: [1],
        state: 'ready',
      },
      checks: [],
    });
    const ready: CanopyStreamCursor = { daemonEpoch, sequence: 1 };

    await request(first, EVENTS, { cursor: null });
    expect(await notification(first)).toMatchObject({
      type: 'item',
      params: { cursor: ready, item: { event: 'ready' } },
    });

    const second = await connect(runtime);
    expect(await request(second, EVENTS, { cursor: ready })).toMatchObject({
      acceptedCursor: ready,
    });
    const stopping = runtime.shutdown();
    expect(runtime.isShuttingDown()).toBe(true);
    expect(getActiveDesktopRuntimeIfAccepting()).toBeNull();
    await stopping;
    for (const client of [first, second]) {
      expect(await notification(client)).toMatchObject({
        type: 'item',
        params: {
          cursor: { daemonEpoch, sequence: 2 },
          item: { event: 'stopping', runtime: { state: 'stopping' } },
        },
      });
      expect(await notification(client)).toMatchObject({
        type: 'end',
        params: { cursor: { daemonEpoch, sequence: 2 }, outcome: 'completed' },
      });
      client.close();
    }
    expect(runtime.state).toBe('closed');
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it('refuses late legacy reads while draining admitted work', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = (): void => resolve();
    });
    const runtime = createDesktopRuntime({
      services: {
        listFileTreeRoots: async () => {
          await gate;
          return { roots: [] };
        },
        listFileTreeDirectory: () => Promise.resolve({ entries: [] }),
      },
      shutdownTimeoutMs: 1_000,
    });
    await settle();
    const params = { scope: { workspaceId: 'project-1', worktreeId: 'wt-1' } };
    const read = {
      caller: { ...caller, grants: ['worker.filesystem.read' as const] },
    };
    const admitted = runtime.queryFileTreeRootsForLegacyIpc(params, read);
    const stopping = runtime.shutdown();

    await expect(
      runtime.queryFileTreeRootsForLegacyIpc(params, read),
    ).rejects.toMatchObject({
      payload: { kind: 'unavailable', message: 'The runtime is unavailable.' },
    });
    await expect(runtime.query(HEALTH, {}, { caller })).resolves.toEqual(
      expect.objectContaining({ checks: [] }),
    );
    release();
    await expect(admitted).resolves.toMatchObject({
      legacyResult: { roots: [] },
    });
    await expect(stopping).resolves.toBeUndefined();
  });
});

runCanopyJournalConformance({
  name: 'desktop in-memory framing',
  createPair: createInMemoryFramedPair,
  target: desktopJournalTarget,
  describe,
  it,
});
