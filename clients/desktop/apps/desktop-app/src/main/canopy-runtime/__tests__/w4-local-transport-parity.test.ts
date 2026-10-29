import { lstat } from 'node:fs/promises';
import * as desktopRuntime from '../desktop-runtime';
import {
  W4_CHAT_FOREIGN_SCENARIO,
  W4_CHAT_RESUME_SCENARIO,
  runW4ChatControlChecks,
  runW4ChatParity,
  runW4ChatScenario,
  type W4ChatScenarioName,
} from './w4-chat-parity';
import {
  W4_PLANTED_DIVERGENCES,
  assertW4PlantedDivergence,
  runW4FilesystemParity,
  runW4FilesystemControlChecks,
} from './w4-filesystem-parity';
import {
  acquireW4Within,
  settleW4LateReleases,
  w4Gate,
} from './w4-acquisition';
import {
  W4_CHAT_SCOPE,
  createW4ParitySession,
  type W4DispatcherHost,
  type W4ParityEndpoint,
} from './w4-parity-harness';
import {
  createW4LocalTransportBinding,
  type W4LocalTransportOptions,
} from './w4-local-transport-binding';

const ROOTS_SCOPE = { workspaceId: 'workspace-1', worktreeId: 'worktree-1' };
const SETUP_EVENTS = ['authenticated', 'initialized', 'activated'];

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error(`Condition not met: ${label}`);
}

/** Authentication, initialization and the lease all completed before `fault`. */
function expectSetupBefore(events: readonly string[], fault: string): number {
  const at = events.indexOf(fault);
  expect(at).toBeGreaterThan(-1);
  for (const event of SETUP_EVENTS) {
    expect(events.indexOf(event)).toBeGreaterThan(-1);
    expect(events.indexOf(event)).toBeLessThan(at);
  }
  return at;
}

function isAbortable(value: unknown): value is { signal: AbortSignal } {
  return (
    value instanceof Object &&
    'signal' in value &&
    value.signal instanceof AbortSignal
  );
}

/**
 * A binding whose fixture host records what it served, so a test can prove
 * every owned listener, accepted stream and subscription is gone afterwards.
 */
function recordedBinding(options: W4LocalTransportOptions = {}): {
  binding: ReturnType<typeof createW4LocalTransportBinding>;
  events: string[];
  hosts: W4DispatcherHost[];
  assertReleased: () => Promise<void>;
  reset: () => void;
} {
  const events: string[] = [];
  const paths: string[] = [];
  const accepted: Array<{ signal: AbortSignal }> = [];
  const hosts: W4DispatcherHost[] = [];
  const binding = createW4LocalTransportBinding({
    ...options,
    onHost: (host) => {
      hosts.push(host);
      options.onHost?.(host);
    },
    observe: (event, value) => {
      events.push(event);
      if (event === 'listener' && typeof value === 'string') paths.push(value);
      if (event === 'accepted' && isAbortable(value)) accepted.push(value);
      options.observe?.(event, value);
    },
  });
  return {
    binding,
    events,
    hosts,
    assertReleased: async (): Promise<void> => {
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths)
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(accepted.length).toBeGreaterThan(0);
      expect(accepted.every(({ signal }) => signal.aborted)).toBe(true);
      expect(events.filter((event) => event === 'host-closed')).toHaveLength(
        hosts.length,
      );
      expect(hosts.map((host) => host.subscribers())).toEqual(
        hosts.map(() => 0),
      );
    },
    reset: (): void => {
      events.length = 0;
      paths.length = 0;
      accepted.length = 0;
      hosts.length = 0;
    },
  };
}

const posix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;
posix('W4 POSIX fixture socket transport', () => {
  afterEach(() => settleW4LateReleases());
  afterAll(() => settleW4LateReleases());
  runW4FilesystemParity(createW4LocalTransportBinding());
  runW4ChatParity(createW4LocalTransportBinding());

  describe('chat negative controls through the endpoint', () => {
    const chatControls = recordedBinding();
    beforeEach(() => chatControls.reset());
    runW4ChatControlChecks(chatControls.binding, {
      reached: (fault) => {
        chatControls.events.push(`fault:${fault}`);
      },
      assertReady: async (fault) => {
        expectSetupBefore(chatControls.events, `fault:${fault}`);
        await chatControls.assertReleased();
      },
    });
  });

  it.each<
    [
      string,
      W4LocalTransportOptions,
      W4ChatScenarioName,
      string | RegExp,
      string,
    ]
  >([
    [
      'resume cursor at the facade input',
      { stripCursor: true },
      W4_CHAT_RESUME_SCENARIO,
      'Condition not met: redelivery',
      'cursor-stripped',
    ],
    [
      'suppressed refusal terminal',
      { refusalFault: 'suppress' },
      W4_CHAT_FOREIGN_SCENARIO,
      'Condition not met: recovered live open',
      'refusal-fault',
    ],
    [
      'refusal terminal with a reclassified code',
      { refusalFault: 'reclassify-code' },
      W4_CHAT_FOREIGN_SCENARIO,
      'Condition not met: recovered live open',
      'refusal-fault',
    ],
    [
      'refusal terminal with a reclassified kind',
      { refusalFault: 'reclassify-kind' },
      W4_CHAT_FOREIGN_SCENARIO,
      'Condition not met: recovered live open',
      'refusal-fault',
    ],
    [
      'corrupted refresh directive',
      { refusalFault: 'corrupt-directive' },
      W4_CHAT_FOREIGN_SCENARIO,
      /^Unexpected refusal terminal payload: .*"resource":"core\.chat\.transcript\.page\.get"/,
      'refusal-fault',
    ],
  ])(
    'detects an ignored %s after successful endpoint setup',
    async (_fault, options, scenario, failure, reached) => {
      const recorded = recordedBinding(options);
      await expect(
        runW4ChatScenario(recorded.binding, scenario),
      ).rejects.toThrow(failure);
      expectSetupBefore(recorded.events, reached);
      await recorded.assertReleased();
    },
  );

  describe('W4 fixture authentication', () => {
    it('refuses a foreign secret and closes the pre-authentication stream', async () => {
      const recorded = recordedBinding({ presentForeignSecret: true });
      const backend = await recorded.binding.start();
      try {
        await expect(createW4ParitySession(backend)).rejects.toThrow();
        expect(recorded.events).toContain('accepted');
        expect(recorded.events).not.toContain('authenticated');
      } finally {
        await backend.shutdown();
      }
      await recorded.assertReleased();
    });

    it('closes a pre-authentication stream whose handshake fails on the server', async () => {
      const recorded = recordedBinding({
        checkpoint: (stage) => {
          if (stage === 'authenticate')
            throw new Error('planted authenticate failure');
        },
      });
      const healthy = await createW4LocalTransportBinding().start();
      const session = await createW4ParitySession(healthy);
      try {
        const backend = await recorded.binding.start();
        try {
          await expect(createW4ParitySession(backend)).rejects.toThrow();
          expect(recorded.events).not.toContain('authenticated');
        } finally {
          await backend.shutdown();
        }
        await recorded.assertReleased();
        await expect(
          session.client.query('worker.filesystem.roots.list', {
            scope: ROOTS_SCOPE,
          }),
        ).resolves.toEqual({ roots: [] });
      } finally {
        try {
          await session.disconnect();
        } finally {
          await healthy.shutdown();
        }
      }
    });
  });

  describe('W4 fixture restart', () => {
    it('cancels an in-flight connect and refuses connects while restarting', async () => {
      const connecting = w4Gate();
      const restarting = w4Gate();
      const resume = w4Gate();
      let stall = 'plane';
      const recorded = recordedBinding({
        checkpoint: async (stage) => {
          if (stage !== stall) return;
          (stage === 'plane' ? connecting : restarting).resolve();
          await resume.promise;
        },
      });
      const backend = await recorded.binding.start();
      try {
        const setup = createW4ParitySession(backend);
        const rejected = expect(setup).rejects.toThrow();
        await connecting.promise;
        stall = 'restart';
        const restart = backend.chat.restart();
        await restarting.promise;
        // The stalled connect was cancelled without its gate opening.
        await acquireW4Within(rejected, () => undefined, 'cancelled connect');
        await expect(backend.connect({})).rejects.toThrow(
          'W4 host is restarting.',
        );
        await expect(backend.chat.restart()).rejects.toThrow(
          'W4 host is already restarting.',
        );
        resume.resolve();
        await restart;
        expect(recorded.events).toContain('restarted');
        const session = await createW4ParitySession(backend);
        try {
          await expect(
            session.client.query('worker.filesystem.roots.list', {
              scope: ROOTS_SCOPE,
            }),
          ).resolves.toEqual({ roots: [] });
        } finally {
          await session.disconnect();
        }
      } finally {
        resume.resolve();
        await backend.shutdown();
      }
      await recorded.assertReleased();
    });

    it('stops the whole host after a partial restart and keeps unrelated endpoints usable', async () => {
      const recorded = recordedBinding({
        checkpoint: (stage) => {
          if (stage === 'restart') throw new Error('planted restart failure');
        },
      });
      const healthy = await createW4LocalTransportBinding().start();
      const unrelated = await createW4ParitySession(healthy);
      try {
        const backend = await recorded.binding.start();
        try {
          const session = await createW4ParitySession(backend);
          await expect(backend.chat.restart()).rejects.toThrow(
            'planted restart failure',
          );
          await until(() => session.client.signal.aborted, 'session closed');
          expect(recorded.events).toContain('host-closed');
          expect(recorded.events).not.toContain('restarted');
          await expect(backend.connect({})).rejects.toThrow();
          await expect(backend.chat.commit()).rejects.toThrow();
          await session.disconnect();
        } finally {
          await backend.shutdown();
        }
        await recorded.assertReleased();
        await expect(
          unrelated.client.query('worker.filesystem.roots.list', {
            scope: ROOTS_SCOPE,
          }),
        ).resolves.toEqual({ roots: [] });
      } finally {
        try {
          await unrelated.disconnect();
        } finally {
          await healthy.shutdown();
        }
      }
    });
  });

  it('stops the whole host when the replacement runtime fails inside restart', async () => {
    const recorded = recordedBinding();
    const backend = await recorded.binding.start();
    try {
      const session = await createW4ParitySession(backend);
      const planted = new Error('planted replacement history failure');
      const create = desktopRuntime.createDesktopRuntime;
      const factory = jest
        .spyOn(desktopRuntime, 'createDesktopRuntime')
        .mockImplementationOnce((options) => {
          const runtime = create(options);
          jest.spyOn(runtime, 'openStream').mockRejectedValueOnce(planted);
          return runtime;
        });
      try {
        await expect(backend.chat.restart()).rejects.toBe(planted);
        expect(factory).toHaveBeenCalledTimes(1);
      } finally {
        factory.mockRestore();
      }
      await until(() => session.client.signal.aborted, 'session closed');
      expect(recorded.events).toContain('host-closed');
      expect(recorded.events).not.toContain('restarted');
      await expect(backend.connect({})).rejects.toThrow();
      await session.disconnect();
    } finally {
      await backend.shutdown();
    }
    await recorded.assertReleased();
  });

  it.each(['restart checkpoint', 'replacement runtime'])(
    'does not revive the host when shutdown overtakes the %s',
    async (stage) => {
      const entered = w4Gate();
      const resume = w4Gate();
      const recorded = recordedBinding({
        checkpoint: async (name) => {
          if (stage !== 'restart checkpoint' || name !== 'restart') return;
          entered.resolve();
          await resume.promise;
        },
        onHost: (fixtureHost) => {
          if (stage !== 'replacement runtime') return;
          const replace = fixtureHost.restart.bind(fixtureHost);
          fixtureHost.restart = async (): Promise<void> => {
            entered.resolve();
            await resume.promise;
            await replace();
          };
        },
      });
      const backend = await recorded.binding.start();
      const [host] = recorded.hosts;
      if (!host) throw new Error('Expected the fixture host.');
      const session = await createW4ParitySession(backend);
      const create = jest.spyOn(desktopRuntime, 'createDesktopRuntime');
      try {
        const restart = backend.chat.restart();
        const refused = expect(restart).rejects.toThrow();
        await entered.promise;
        const shutdown = backend.shutdown();
        resume.resolve();
        await shutdown;
        await refused;
        // A replacement built before shutdown observed it is stopped, not kept.
        expect(create).toHaveBeenCalledTimes(
          stage === 'replacement runtime' ? 1 : 0,
        );
      } finally {
        resume.resolve();
        create.mockRestore();
        try {
          await session.disconnect();
        } finally {
          await backend.shutdown();
        }
      }
      expect(session.client.signal.aborted).toBe(true);
      expect(recorded.events).not.toContain('restarted');
      expect(host.subscribers()).toBe(0);
      expect(host.runtime.isShuttingDown()).toBe(true);
      await recorded.assertReleased();
    },
  );

  it('disposes host chat subscriptions when a streaming session disconnects', async () => {
    const recorded = recordedBinding();
    const backend = await recorded.binding.start();
    const [host] = recorded.hosts;
    if (!host) throw new Error('Expected the fixture host.');
    try {
      expect(host.subscribers()).toBe(1);
      const session = await createW4ParitySession(backend);
      await session.client.openStream(
        'core.chat.events',
        { scope: W4_CHAT_SCOPE, cursor: null },
        { onFrame: () => undefined },
      );
      await until(() => host.subscribers() === 2, 'stream subscribed');
      await session.disconnect();
      await until(() => host.subscribers() === 1, 'stream disposed');
    } finally {
      await backend.shutdown();
    }
    await recorded.assertReleased();
  });

  describe('W4 real endpoint ownership foundation', () => {
    it('authenticates, acquires a lease and removes its listener on concurrent disconnect', async () => {
      const timers = new Set<() => void>();
      const events: string[] = [];
      const paths: string[] = [];
      const accepted: unknown[] = [];
      const disposed: unknown[] = [];
      const binding = createW4LocalTransportBinding({
        clock: {
          now: () => Date.now(),
          setTimer: (callback): { cancel(): void } => {
            timers.add(callback);
            return {
              cancel: (): void => {
                timers.delete(callback);
              },
            };
          },
        },
        observe: (event, value) => {
          events.push(event);
          if (event === 'accepted') {
            accepted.push(value);
          }
          if (event === 'stream-closed') disposed.push(value);
          if (event === 'listener' && typeof value === 'string')
            paths.push(value);
        },
      });
      const backend = await binding.start();
      try {
        const session = await createW4ParitySession(backend);
        expect(events).toEqual(
          expect.arrayContaining(['authenticated', 'activated']),
        );
        expect(timers.size).toBeGreaterThan(0);
        await Promise.all([session.disconnect(), session.disconnect()]);
        expect(timers.size).toBe(0);
        expect(session.client.signal.aborted).toBe(true);
        for (const path of paths)
          await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(accepted).toHaveLength(1);
        expect(disposed).toHaveLength(accepted.length);
        expect(disposed[0]).toBe(accepted[0]);
        expect(accepted).toMatchObject([{ signal: { aborted: true } }]);
        expect(
          events.filter((event) => event === 'stream-closed'),
        ).toHaveLength(1);
      } finally {
        await backend.shutdown();
      }
    });
  });

  it.each(['listener', 'authenticate', 'initialize', 'activate'])(
    'cancels a stalled %s acquisition before publishing an endpoint',
    async (stageToStall) => {
      const entered = w4Gate();
      const resume = w4Gate();
      const settled = w4Gate();
      const events: string[] = [];
      const accepted: Array<{ signal: AbortSignal }> = [];
      let path = '';
      const backend = await createW4LocalTransportBinding({
        observe: (event, value) => {
          events.push(event);
          if (event === 'listener' && typeof value === 'string') path = value;
          if (event === 'accepted' && isAbortable(value)) accepted.push(value);
        },
        checkpoint: async (stage) => {
          if (stage === stageToStall) {
            entered.resolve();
            await resume.promise;
          }
        },
      }).start();
      const connect = backend.connect.bind(backend);
      backend.connect = (...args): Promise<W4ParityEndpoint> =>
        connect(...args).finally(settled.resolve);
      const setup = createW4ParitySession(backend, { setupTimeoutMs: 500 });
      const rejected = expect(setup).rejects.toThrow(
        'Timed out: W4 session setup',
      );
      try {
        await entered.promise;
        await rejected;
        // Connect must acknowledge cancellation without needing the stalled gate.
        await acquireW4Within(
          settled.promise,
          () => undefined,
          'connect cancellation acknowledgment',
          500,
        );
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        resume.resolve();
        try {
          await acquireW4Within(
            settled.promise,
            () => undefined,
            'connect teardown',
          );
        } finally {
          await backend.shutdown();
        }
      }
      if (stageToStall === 'listener') {
        expect(events).not.toContain('plane');
        expect(events).not.toContain('authenticated');
      }
      if (stageToStall === 'authenticate') {
        expect(events).not.toContain('authenticated');
        expect(accepted).toHaveLength(1);
      }
      expect(accepted.every(({ signal }) => signal.aborted)).toBe(true);
      expect(events).not.toContain('activated');
    },
  );

  describe('filesystem negative controls through the endpoint', () => {
    const controlEvents: string[] = [];
    beforeEach(() => {
      controlEvents.length = 0;
    });
    runW4FilesystemControlChecks(
      createW4LocalTransportBinding({
        observe: (event) => {
          controlEvents.push(event);
        },
      }),
      {
        reached: (fault) => {
          controlEvents.push(`fault:${fault}`);
        },
        assertReady: (fault) => {
          const at = expectSetupBefore(controlEvents, `fault:${fault}`);
          // The ignored fixture precedes the daemon query that exposes it;
          // service inputs are read only after the daemon query.
          const query = controlEvents.indexOf('query');
          expect(query).toBeGreaterThan(-1);
          if (fault === 'fixture') expect(query).toBeGreaterThan(at);
          else expect(query).toBeLessThan(at);
        },
      },
    );
  });

  it.each(W4_PLANTED_DIVERGENCES)(
    'detects an ignored planted mutation for %s after successful endpoint setup',
    async (operation) => {
      const events: string[] = [];
      const backend = await createW4LocalTransportBinding({
        ignoreMutation: true,
        observe: (event) => {
          events.push(event);
        },
      }).start();
      try {
        // Parity incorrectly succeeds, so the planted expectation fails.
        await expect(
          assertW4PlantedDivergence(backend, operation),
        ).rejects.toThrow('Received promise resolved instead of rejected');
      } finally {
        await backend.shutdown();
      }
      expectSetupBefore(events, 'mutation-ignored');
    },
  );

  it('isolates concurrent ordinary and planted sessions', async () => {
    const backend = await createW4LocalTransportBinding().start();
    const sessions = [];
    try {
      sessions.push(await createW4ParitySession(backend));
      sessions.push(
        await createW4ParitySession(backend, {
          mutateResult: () => ({ roots: [] }),
        }),
      );
      await backend.filesystem.serve({
        roots: {
          roots: [
            {
              repoId: 'repo-1',
              repoName: 'Independent',
              rootKind: 'git-repo',
              absolutePath: '/fixture',
            },
          ],
        },
      });
      const results = await Promise.all(
        sessions.map((session) =>
          session.client.query('worker.filesystem.roots.list', {
            scope: { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
          }),
        ),
      );
      expect(results).toEqual([
        {
          roots: [
            { fileRootId: 'repo-1', name: 'Independent', kind: 'git-repo' },
          ],
        },
        { roots: [] },
      ]);
      expect(await backend.filesystem.serviceInputs()).toMatchObject({
        roots: [expect.anything(), expect.anything()],
        directory: [],
      });
    } finally {
      try {
        await Promise.all(sessions.map((session) => session.disconnect()));
      } finally {
        await backend.shutdown();
      }
    }
  });

  it.each(['host', 'listener', 'plane', 'initialize', 'activate'])(
    'cleans partial %s setup and keeps unrelated endpoints usable',
    async (failure) => {
      const events: string[] = [];
      const paths: string[] = [];
      const binding = createW4LocalTransportBinding({
        observe: (event, value) => {
          events.push(event);
          if (event === 'listener' && typeof value === 'string')
            paths.push(value);
        },
        checkpoint: (stage) => {
          if (stage === failure) throw new Error(`planted ${failure} failure`);
        },
      });
      const healthy = await createW4LocalTransportBinding().start();
      const session = await createW4ParitySession(healthy);
      try {
        if (failure === 'host')
          await expect(binding.start()).rejects.toThrow('planted host failure');
        else {
          const backend = await binding.start();
          try {
            const failed = expect(createW4ParitySession(backend)).rejects;
            if (failure === 'initialize')
              await failed.toMatchObject({ payload: { kind: 'internal' } });
            else await failed.toThrow(`planted ${failure} failure`);
          } finally {
            await backend.shutdown();
          }
        }
        expect(events).toContain('host-closed');
        if (failure !== 'host') expect(paths).toHaveLength(1);
        for (const path of paths)
          await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
          session.client.query('worker.filesystem.roots.list', {
            scope: { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
          }),
        ).resolves.toEqual({ roots: [] });
      } finally {
        try {
          await session.disconnect();
        } finally {
          await healthy.shutdown();
        }
      }
    },
  );

  it('reports a late endpoint whose release fails after setup timed out', async () => {
    const resume = w4Gate();
    const closed = w4Gate();
    const sentinel = new Error('late endpoint close sentinel');
    const paths: string[] = [];
    const backend = await createW4LocalTransportBinding({
      observe: (event, value) => {
        if (event === 'listener' && typeof value === 'string')
          paths.push(value);
      },
    }).start();
    const connect = backend.connect.bind(backend);
    backend.connect = async (options): Promise<W4ParityEndpoint> => {
      // Deliberately ignore the caller's signal so the endpoint arrives late.
      const endpoint = await connect(options);
      await resume.promise;
      return {
        ...endpoint,
        close: async (): Promise<void> => {
          await endpoint.close();
          closed.resolve();
          throw sentinel;
        },
      };
    };
    try {
      await expect(
        createW4ParitySession(backend, { setupTimeoutMs: 500 }),
      ).rejects.toThrow('Timed out: W4 session setup');
      resume.resolve();
      await acquireW4Within(
        closed.promise,
        () => undefined,
        'late endpoint release',
      );
      await expect(settleW4LateReleases()).rejects.toMatchObject({
        errors: [
          expect.objectContaining({
            message:
              'W4 late release after "Timed out: W4 session setup" failed.',
            cause: sentinel,
          }),
        ],
      });
      expect(paths).toHaveLength(1);
      for (const path of paths)
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resume.resolve();
      await backend.shutdown();
    }
  });

  it('reports a cancelled unpublished endpoint whose cleanup fails', async () => {
    const entered = w4Gate();
    const resume = w4Gate();
    const sentinel = new Error('cancelled listener close sentinel');
    const paths: string[] = [];
    const backend = await createW4LocalTransportBinding({
      observe: (event, value) => {
        if (event === 'listener' && typeof value === 'string')
          paths.push(value);
        if (event === 'listener-closed') throw sentinel;
      },
      checkpoint: async (stage) => {
        if (stage !== 'plane') return;
        entered.resolve();
        await resume.promise;
      },
    }).start();
    try {
      const setup = createW4ParitySession(backend, { setupTimeoutMs: 500 });
      const rejected = expect(setup).rejects.toThrow(
        'Timed out: W4 session setup',
      );
      await entered.promise;
      await rejected;
      // Opening the stalled gate lets every late release settle.
      resume.resolve();
      await expect(settleW4LateReleases()).rejects.toMatchObject({
        errors: [
          {
            message:
              'W4 late release after "Timed out: W4 session setup" failed.',
            cause: { errors: [sentinel] },
          },
        ],
      });
      expect(paths).toHaveLength(1);
      for (const path of paths)
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resume.resolve();
      await backend.shutdown();
    }
  });

  it.each(['endpoint', 'activation'])(
    'disposes a noncooperative late %s without republishing it',
    async (stage) => {
      const entered = w4Gate();
      const resume = w4Gate();
      const disposed = w4Gate();
      const backend = await createW4LocalTransportBinding().start();
      const connect = backend.connect.bind(backend);
      const endpointClosed = jest.fn();
      const activationClosed = jest.fn();
      let clientSignal: AbortSignal | undefined;
      backend.connect = async (options): Promise<W4ParityEndpoint> => {
        // Deliberately ignore the caller's signal to exercise late ownership.
        const endpoint = await connect(options);
        if (stage === 'endpoint') {
          entered.resolve();
          await resume.promise;
        }
        return {
          ...endpoint,
          close: async (): Promise<void> => {
            await endpoint.close();
            endpointClosed();
            if (stage === 'endpoint') disposed.resolve();
          },
          activate: async (client): Promise<{ close(): Promise<void> }> => {
            clientSignal = client.signal;
            const activation = await endpoint.activate?.(client);
            if (!activation)
              throw new Error('Real endpoint activation missing.');
            entered.resolve();
            await resume.promise;
            return {
              close: async (): Promise<void> => {
                await activation.close();
                activationClosed();
                disposed.resolve();
              },
            };
          },
        };
      };
      const rejected = expect(
        createW4ParitySession(backend, { setupTimeoutMs: 500 }),
      ).rejects.toThrow('Timed out: W4 session setup');
      try {
        await acquireW4Within(
          entered.promise,
          () => undefined,
          'noncooperative setup entered',
        );
        await rejected;
        expect(endpointClosed).toHaveBeenCalledTimes(
          stage === 'endpoint' ? 0 : 1,
        );
        expect(activationClosed).not.toHaveBeenCalled();
        if (stage === 'activation') expect(clientSignal?.aborted).toBe(true);
      } finally {
        resume.resolve();
        try {
          await acquireW4Within(
            disposed.promise,
            () => undefined,
            'late resource disposal',
          );
        } finally {
          await backend.shutdown();
        }
      }
      expect(endpointClosed).toHaveBeenCalledTimes(1);
      expect(activationClosed).toHaveBeenCalledTimes(
        stage === 'activation' ? 1 : 0,
      );
    },
  );
});
