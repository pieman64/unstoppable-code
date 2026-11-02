import {
  migrationFirstFrame,
  type MigrationByteChannel,
} from '@canopy/core-transport/node/migration-channel';
import {
  ELECTRON_MIGRATION_ROLE,
  createElectronMigrationLaunch,
} from '../migration-channel';
import type {
  OwnedChildServices,
  PeerIdentityServices,
} from '@canopy/core-platform';
import * as platform from '@canopy/core-platform';
import { createRuntimeProfileGraph } from '@canopy/core-runtime';
import {
  createCanopyObligationRegistry,
  serveCanopyControlStream,
  type CanopyControlStreamSession,
} from '@canopy/core-runtime/node';
import {
  migrationDaemonRequirement,
  type MigrationDaemonExpectation,
} from '@canopy/core-runtime/node/vault';

function bytePair(
  onRead: (bytes: Uint8Array) => void = () => undefined,
): [MigrationByteChannel, MigrationByteChannel] {
  const queues: Uint8Array[][] = [[], []];
  const readers: (() => void)[] = [
    (): void => undefined,
    (): void => undefined,
  ];
  let closed = false;
  const make = (at: number): MigrationByteChannel => ({
    read: (signal): Promise<Uint8Array | null> => {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        let settled = false;
        const abort = (): void => {
          settled = true;
          readers[at] = (): void => undefined;
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error('cancelled', { cause: signal?.reason }),
          );
        };
        signal?.addEventListener('abort', abort, { once: true });
        const deliver = (): void => {
          if (settled || (!queues[at].length && !closed)) return;
          settled = true;
          readers[at] = (): void => undefined;
          signal?.removeEventListener('abort', abort);
          const bytes = queues[at].length
            ? Buffer.concat(queues[at].splice(0))
            : null;
          if (bytes) onRead(bytes);
          resolve(bytes);
        };
        readers[at] = deliver;
        // SOCK_STREAM does not preserve write boundaries.
        setImmediate(deliver);
      });
    },
    write: (bytes, signal): Promise<void> => {
      signal?.throwIfAborted();
      if (closed) throw new Error('closed');
      queues[1 - at].push(Uint8Array.from(bytes));
      setImmediate(() => readers[1 - at]());
      return Promise.resolve();
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      setImmediate(() => {
        readers[0]();
        readers[1]();
      });
    },
  });
  return [make(0), make(1)];
}

it.each([
  'committed',
  'startup-aborted',
  'child-exited',
  'rollback',
  'auth-refused',
] as const)(
  'owns the authenticated channel for the %s lifecycle',
  async (lifecycle) => {
    const coalesced: Uint8Array[] = [];
    const [daemon, launcher] = bytePair((bytes) => {
      const prelude = Buffer.from('canopy-migration-channel-v1\n');
      if (
        bytes.length > prelude.length &&
        Buffer.from(bytes).subarray(0, prelude.length).equals(prelude)
      )
        coalesced.push(bytes);
    });
    const closed = jest.spyOn(launcher, 'close');
    const expected: MigrationDaemonExpectation = {
      teamId: 'ABCDE12345',
      identifier: 'com.example.daemon',
      binding: { kind: 'cdhash', cdhash: 'a'.repeat(40) },
    };
    const token = { pid: 42, pidversion: 7 };
    const capture = jest.spyOn(platform, 'peerCaptureFor').mockReturnValue({
      os: 'darwin',
      spawned: { ...token, unreaped: true },
      peer: {
        kind: 'captured',
        token,
        codeToken: token,
        signing: {
          teamId: expected.teamId,
          identifier: expected.identifier,
          buildId: null,
          codeFlags: 0x10000,
          cdhash: 'a'.repeat(40),
        },
        requirement: {
          text: migrationDaemonRequirement(expected),
          satisfied: true,
        },
        staticCheck: 'not-run',
      },
    });
    const runtime = createRuntimeProfileGraph({
      profile: 'core',
      identity: {
        authorityId: 'authority',
        runtimeId: 'runtime',
        hostId: 'host',
      },
      modules: [],
      principalFor: () => 'interface',
      phaseDeadlineMs: 1000,
    });
    await runtime.start();
    const obligations = createCanopyObligationRegistry();
    const auth = { secret: 'a'.repeat(64), dataRootHash: 'b'.repeat(64) };
    const stop = new AbortController();
    const serving = new Promise<CanopyControlStreamSession>((resolve) => {
      // Pipeline a real D3 challenge with the prelude to force both peers
      // to retain coalesced bytes; reads still wait for prelude validation.
      const framing = migrationFirstFrame(
        daemon,
        'daemon',
        () => true,
        AbortSignal.timeout(2000),
      );
      resolve(
        serveCanopyControlStream({
          stream: {
            signal: new AbortController().signal,
            read: async (options) => (await framing).read(options?.signal),
            write: (bytes) => daemon.write(bytes),
            close: (): Promise<void> => {
              daemon.close();
              return Promise.resolve();
            },
          },
          auth,
          dispatcher: runtime.dispatcher,
          operations: runtime.operations,
          caller: {
            principalId: 'launcher',
            clientInstanceId: 'launcher',
            authorityId: 'authority',
            interfaceKind: 'daemon',
            grants: ['core.runtime.read'],
          },
          obligations,
          buildVersion: '1',
        }),
      );
    });
    void serving.catch(() => undefined);
    let exit = (): void => undefined;
    const child = {
      pid: token.pid,
      exited: new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
          exit = (): void => resolve({ code: 0, signal: null });
        },
      ),
      commit: jest.fn(),
      terminate: jest.fn((): Promise<void> => Promise.resolve()),
    };
    const adapter = createElectronMigrationLaunch({
      enabled: true,
      children: {
        spawn: jest.fn(),
        spawnWithChannel: (): ReturnType<
          OwnedChildServices['spawnWithChannel']
        > => Promise.resolve({ child, channel: launcher }),
      },
      peerIdentity: {
        claimLauncherChannel: jest.fn(),
        captureLauncherEvidence: jest.fn(),
        captureDaemonEvidence: () => ({
          ok: true,
          evidence: { role: 'daemon', ...token },
        }),
      },
      expected,
    });
    if (!adapter) throw new Error('adapter missing');
    try {
      const pending = adapter.spawn(
        {
          executable: '/test/daemon',
          args: ['--migration-channel'],
          environment: {},
        },
        lifecycle === 'auth-refused'
          ? { ...auth, secret: 'wrong-secret' }
          : auth,
        stop.signal,
      );
      if (lifecycle === 'auth-refused') {
        await expect(pending).rejects.toThrow();
      } else {
        const launched = await pending;
        expect(obligations.size).toBe(1);
        if (lifecycle === 'rollback') {
          await launched.terminate(stop.signal);
        } else if (lifecycle === 'startup-aborted') {
          stop.abort();
        } else {
          launched.commit(stop.signal);
          expect(child.commit).toHaveBeenCalledTimes(1);
          if (lifecycle === 'child-exited') exit();
          else stop.abort();
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (lifecycle === 'committed') {
        expect(closed).not.toHaveBeenCalled();
        expect(obligations.size).toBe(1);
      } else {
        expect(closed).toHaveBeenCalled();
        expect(obligations.size).toBe(0);
      }
      expect(coalesced).toHaveLength(2);
      expect(platform.peerCaptureFor).toHaveBeenCalledWith(launcher);
      expect(child.terminate).toHaveBeenCalledTimes(
        lifecycle === 'rollback' || lifecycle === 'auth-refused' ? 1 : 0,
      );
    } finally {
      daemon.close();
      await (await serving).close();
      await runtime.shutdown('test');
      capture.mockRestore();
    }
    expect(obligations.size).toBe(0);
  },
);

it.each(['before', 'during'] as const)(
  'handles cancellation %s native spawn without beginning capture',
  async (when) => {
    const stopped = new AbortController();
    const reason = new Error('cancelled before spawn');
    if (when === 'before') stopped.abort(reason);
    const read = jest.fn((signal?: AbortSignal): Promise<Uint8Array | null> => {
      signal?.throwIfAborted();
      return Promise.resolve(null);
    });
    const channel: MigrationByteChannel = {
      read,
      write: jest.fn(),
      close: jest.fn(),
    };
    const child = {
      pid: 42,
      exited: new Promise<{ code: number | null; signal: string | null }>(
        () => undefined,
      ),
      commit: jest.fn(),
      terminate: jest.fn((): Promise<void> => Promise.resolve()),
    };
    const spawnWithChannel = jest.fn(
      (): ReturnType<OwnedChildServices['spawnWithChannel']> => {
        if (when === 'during') stopped.abort(reason);
        return Promise.resolve({ child, channel });
      },
    );
    const children: OwnedChildServices = {
      spawn: jest.fn(),
      spawnWithChannel,
    };
    const captureDaemonEvidence = jest.fn();
    const peerIdentity: PeerIdentityServices = {
      claimLauncherChannel: jest.fn(),
      captureLauncherEvidence: jest.fn(),
      captureDaemonEvidence,
    };
    const adapter = createElectronMigrationLaunch({
      enabled: true,
      children,
      peerIdentity,
      expected: {
        teamId: 'ABCDE12345',
        identifier: 'com.example.daemon',
        binding: { kind: 'cdhash', cdhash: 'a'.repeat(40) },
      },
    });
    if (!adapter) throw new Error('adapter missing');
    await expect(
      adapter.spawn(
        {
          executable: '/test/daemon',
          args: ['--migration-channel'],
          environment: {},
        },
        { secret: 'a'.repeat(64), dataRootHash: 'b'.repeat(64) },
        stopped.signal,
      ),
    ).rejects.toBe(reason);
    expect(spawnWithChannel).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(child.terminate).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(read).not.toHaveBeenCalled();
    expect(captureDaemonEvidence).not.toHaveBeenCalled();
  },
);

it('keeps production unavailable independently of configuration and endpoint tokens', () => {
  expect(ELECTRON_MIGRATION_ROLE).toEqual({
    enabled: false,
    reason: 'release-gate-and-v5-ports',
  });
  expect(Object.isFrozen(ELECTRON_MIGRATION_ROLE)).toBe(true);
});

it.each([
  null,
  new Uint8Array(),
  Buffer.from('wrong'),
  Buffer.from('canopy-migration-channel-v1X\nextra'),
])('refuses a malformed or delegated first frame %s', async (bytes) => {
  const capture = jest.fn(() => true);
  const close = jest.fn();
  const channel: MigrationByteChannel = {
    read: () => Promise.resolve(bytes),
    write: jest.fn(),
    close,
  };
  await expect(
    migrationFirstFrame(channel, 'launcher', capture, AbortSignal.timeout(100)),
  ).rejects.toThrow();
  expect(capture).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

it('captures once after the daemon first frame and sends nothing when its identity is refused', async () => {
  const write = jest.fn();
  const close = jest.fn();
  const channel: MigrationByteChannel = {
    read: () => Promise.resolve(Buffer.from('canopy-migration-channel-v1\n')),
    write,
    close,
  };
  const capture = jest.fn(() => false);
  await expect(
    migrationFirstFrame(channel, 'launcher', capture, AbortSignal.timeout(100)),
  ).rejects.toThrow('Migration peer refused.');
  expect(capture).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

it('does not compose an enabled launch adapter in production', async () => {
  const { createElectronMigrationLaunch } =
    await import('../migration-channel');
  expect(createElectronMigrationLaunch({ enabled: false })).toBeUndefined();
});

it('closes the inherited end and terminates the owned child when daemon evidence refuses', async () => {
  const { createElectronMigrationLaunch } =
    await import('../migration-channel');
  const write = jest.fn();
  const close = jest.fn();
  const channel: MigrationByteChannel = {
    read: () => Promise.resolve(Buffer.from('canopy-migration-channel-v1\n')),
    write,
    close,
  };
  const terminate = jest.fn((): Promise<void> => Promise.resolve());
  const child = {
    pid: 42,
    exited: new Promise<{ code: number | null; signal: string | null }>(
      () => undefined,
    ),
    commit: jest.fn(),
    terminate,
  };
  const captureDaemonEvidence = jest.fn(() => ({
    ok: false as const,
    reason: 'requirement_unsatisfied' as const,
  }));
  const adapter = createElectronMigrationLaunch({
    enabled: true,
    children: {
      spawn: jest.fn(),
      spawnWithChannel: () => Promise.resolve({ child, channel }),
    },
    peerIdentity: {
      claimLauncherChannel: jest.fn(),
      captureLauncherEvidence: jest.fn(),
      captureDaemonEvidence,
    },
    expected: {
      teamId: 'ABCDE12345',
      identifier: 'com.example.daemon',
      binding: { kind: 'cdhash', cdhash: 'a'.repeat(40) },
    },
  });
  if (!adapter) throw new Error('adapter missing');
  await expect(
    adapter.spawn(
      {
        executable: '/test/daemon',
        args: ['--migration-channel'],
        environment: {},
      },
      { secret: 'a'.repeat(64), dataRootHash: 'b'.repeat(64) },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Migration peer refused.');
  expect(close).toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(captureDaemonEvidence).toHaveBeenCalledTimes(1);
  expect(terminate).toHaveBeenCalledTimes(1);
});
