import {
  encodeCanopyError,
  type CoreRuntimeInitializeResult,
  type WorkerFilesystemRootsListResult,
} from '@canopy/protocol/canopy-core';
import {
  createInMemoryFramedPair,
  type CanopyFramedConnection,
} from '@canopy/core-transport';
import { settleW4LateReleases } from './w4-acquisition';
import {
  runW4FilesystemCaseOverBinding,
  runW4FilesystemControlChecks,
  runW4FilesystemParity,
} from './w4-filesystem-parity';
import * as desktopRuntime from '../desktop-runtime';
import {
  startW4DispatcherHost,
  createW4FakeDaemonBinding,
  createW4ParitySession,
  inMemoryParityBinding,
  type W4ParityBackend,
  type W4ParityEndpoint,
  type W4ParitySessionOptions,
} from './w4-parity-harness';

runW4FilesystemParity(inMemoryParityBinding);
runW4FilesystemParity(createW4FakeDaemonBinding().binding);

const ROOTS = 'worker.filesystem.roots.list';
const SCOPE = { workspaceId: 'workspace-1', worktreeId: 'worktree-1' };

runW4FilesystemControlChecks(inMemoryParityBinding);

afterEach(() => settleW4LateReleases());
afterAll(() => settleW4LateReleases());

describe('W4 filesystem fixture drivers', () => {
  it('provisions the selected backend through every driver hook', async () => {
    const fake = createW4FakeDaemonBinding();
    await runW4FilesystemCaseOverBinding(
      fake.binding,
      'roots: every kind in service order',
    );
    expect(Object.fromEntries(fake.hookCalls)).toEqual({
      'filesystem.serve': 1,
      'filesystem.serviceInputs': 1,
    });
  });
});

const EXTERNAL_INITIALIZE: CoreRuntimeInitializeResult = {
  runtime: {
    runtimeId: 'external-runtime',
    hostId: 'external-host',
    authorityId: 'external-daemon',
    profile: 'core+worker',
    daemonEpoch: 'external-epoch',
    protocolVersions: [1],
    state: 'ready',
    buildVersion: 'external-build',
  },
  selectedProtocolVersion: 1,
  capabilities: { operations: [ROOTS], events: [], streams: [] },
  limits: {},
  authentication: { required: true, methods: [] },
};
const EXTERNAL_ROOTS: WorkerFilesystemRootsListResult = {
  roots: [
    { fileRootId: 'external-sentinel', name: 'External', kind: 'git-repo' },
  ],
};

/** A daemon-owned server: no desktop runtime stands behind it. */
async function serveExternalDaemon(
  server: CanopyFramedConnection,
  refuseInitialize: boolean,
): Promise<void> {
  for (;;) {
    const message = await server.receive().catch(() => null);
    if (!message) return;
    if (!('method' in message) || !('id' in message)) continue;
    const { id, method } = message;
    const result =
      method === ROOTS
        ? EXTERNAL_ROOTS
        : method === 'core.runtime.initialize' && !refuseInitialize
          ? EXTERNAL_INITIALIZE
          : null;
    const reply = result
      ? { jsonrpc: '2.0' as const, id, result }
      : {
          jsonrpc: '2.0' as const,
          id,
          error: encodeCanopyError({
            kind: 'permission_denied',
            message: 'External daemon refused.',
            retry: { kind: 'never' },
          }),
        };
    const sent = await server.send(reply).then(
      () => true,
      () => false,
    );
    if (!sent) return;
  }
}

interface ExternalState {
  server?: CanopyFramedConnection;
  options: W4ParitySessionOptions[];
  closes: number;
}

function externalBackend(refuseInitialize: boolean): {
  backend: W4ParityBackend;
  state: ExternalState;
} {
  const unprovisioned = (): Promise<never> =>
    Promise.reject(new Error('Not provisioned.'));
  const state: ExternalState = { options: [], closes: 0 };
  const backend: W4ParityBackend = {
    expected: { operations: [ROOTS], streams: [] },
    filesystem: { serve: unprovisioned, serviceInputs: unprovisioned },
    chat: { commit: unprovisioned, restart: unprovisioned },
    async connect(options) {
      state.options.push(options);
      const pair = await createInMemoryFramedPair();
      state.server = pair.server;
      const serving = serveExternalDaemon(pair.server, refuseInitialize);
      return {
        connection: pair.client,
        async close(): Promise<void> {
          state.closes += 1;
          pair.server.close();
          await serving;
        },
      };
    },
    shutdown: () => Promise.resolve(),
  };
  return { backend, state };
}

describe('W4 session lifecycle over a binding-owned endpoint', () => {
  it('talks only to the endpoint and closes it once across repeated disconnects', async () => {
    const { backend, state } = externalBackend(false);
    const options = { mutateResult: jest.fn() };
    const session = await createW4ParitySession(backend, options);
    expect(state.options).toEqual([options]);
    try {
      expect(session.client.identity).toMatchObject({
        authorityId: 'external-daemon',
        buildVersion: 'external-build',
      });
      await expect(
        session.client.query(ROOTS, { scope: SCOPE }),
      ).resolves.toEqual(EXTERNAL_ROOTS);
      expect(state.closes).toBe(0);
      await Promise.all([session.disconnect(), session.disconnect()]);
    } finally {
      await session.disconnect();
    }
    expect(state.closes).toBe(1);
    expect(state.server?.signal.aborted).toBe(true);
    expect(session.client.signal.aborted).toBe(true);
    expect(options.mutateResult).not.toHaveBeenCalled();
  });

  it('activates before publishing and releases activation before closing the client', async () => {
    const { backend } = externalBackend(false);
    const connect = backend.connect.bind(backend);
    const released = jest.fn();
    const activate = jest.fn((client: { signal: AbortSignal }) =>
      Promise.resolve({
        close: (): Promise<void> => {
          expect(client.signal.aborted).toBe(false);
          released();
          return Promise.resolve();
        },
      }),
    );
    backend.connect = async (options): Promise<W4ParityEndpoint> => ({
      ...(await connect(options)),
      activate,
    });
    const session = await createW4ParitySession(backend);
    try {
      expect(activate).toHaveBeenCalledTimes(1);
    } finally {
      await session.disconnect();
    }
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('tears the endpoint down when the handshake fails', async () => {
    const { backend, state } = externalBackend(true);
    await expect(createW4ParitySession(backend)).rejects.toMatchObject({
      payload: { kind: 'permission_denied' },
    });
    expect(state.closes).toBe(1);
    expect(state.server?.signal.aborted).toBe(true);
  });
});

it.each([false, true])(
  'rolls back runtime when the history subscription fails (cleanup fails: %s)',
  async (failCleanup) => {
    const primary = new Error('history subscription failed');
    const cleanup = new Error('runtime cleanup failed');
    const runtime = desktopRuntime.createDesktopRuntime();
    const shutdown = runtime.shutdown.bind(runtime);
    const factory = jest
      .spyOn(desktopRuntime, 'createDesktopRuntime')
      .mockReturnValue(runtime);
    const subscribe = jest
      .spyOn(runtime, 'openStream')
      .mockRejectedValue(primary);
    const stop = jest
      .spyOn(runtime, 'shutdown')
      .mockImplementation(async () => {
        await shutdown();
        if (failCleanup) throw cleanup;
      });
    try {
      const acquisition = startW4DispatcherHost('failed-history-hold');
      if (failCleanup)
        await expect(acquisition).rejects.toMatchObject({
          errors: [primary, cleanup],
        });
      else await expect(acquisition).rejects.toBe(primary);
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(runtime.isShuttingDown()).toBe(true);
    } finally {
      factory.mockRestore();
      subscribe.mockRestore();
      stop.mockRestore();
      await shutdown();
    }
  },
);
