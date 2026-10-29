import { spawnSync } from 'node:child_process';
import { chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInMemoryFramedPair } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';

import {
  describeCanopyClientConformance,
  rejection,
} from '../../__tests__/client-conformance';
import {
  CANONICAL_DEFINITIONS,
  CanonicalCoreError,
  canonicalInitializeResult,
  serveCanonicalCore,
} from '../../__tests__/fixtures/canonical-core';
import {
  connectCanopyClient,
  connectCanopyFramedConnection,
  type CanopyClientEndpoint,
} from '../index';
import {
  listenSocketPeer,
  PEER_AUTH,
  PEER_MAX_FRAME_BYTES,
  PEER_SECRET,
  within,
  type PeerScript,
  type SocketPeer,
} from './fixtures/socket-peer';

type PathEndpoint = Extract<CanopyClientEndpoint, { path: string }>;
const isWindows = process.platform === 'win32';
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Runs `work` and lists the delays of ref'd timers it started that are still
 * pending afterwards. Scoped to `work`, unlike a process-wide count that other
 * tests' timers can shift.
 */
async function pendingTimers<T>(
  work: () => Promise<T>,
): Promise<[T, number[]]> {
  const pending = new Map<NodeJS.Timeout, number>();
  const { setTimeout: start, clearTimeout: clear } = globalThis;
  const started = jest
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation((callback, delay, ...args: unknown[]) => {
      const timer = start(() => {
        pending.delete(timer);
        Reflect.apply(callback, undefined, args);
      }, delay);
      pending.set(timer, delay ?? 0);
      return timer;
    });
  const cleared = jest
    .spyOn(globalThis, 'clearTimeout')
    .mockImplementation((timer) => {
      if (typeof timer === 'object') pending.delete(timer);
      clear(timer);
    });
  try {
    const value = await work();
    const delays = Array.from(pending)
      .filter(([timer]) => timer.hasRef())
      .map(([, delay]) => delay);
    return [value, delays];
  } finally {
    started.mockRestore();
    cleared.mockRestore();
  }
}
const endpointOf = (
  peer: SocketPeer,
  overrides: Partial<PathEndpoint> = {},
): PathEndpoint => ({
  kind: peer.kind,
  path: peer.path,
  auth: PEER_AUTH,
  maxFrameBytes: PEER_MAX_FRAME_BYTES,
  ...overrides,
});
const client = {
  clientName: 'node-connector',
  clientVersion: '1.0.0',
  definitions: CANONICAL_DEFINITIONS,
};
/** Errors name neither the endpoint path nor the auth secret. */
function redacted(payload: CanopyErrorPayload | 'timeout', path: string): void {
  expect(JSON.stringify(payload)).not.toContain(path);
  expect(JSON.stringify(payload)).not.toContain(PEER_SECRET);
}
const connectPair = (
  peer: SocketPeer,
): Promise<[CanopyFramedConnection, CanopyFramedConnection]> =>
  Promise.all([
    connectCanopyFramedConnection({ endpoint: endpointOf(peer) }),
    peer.next(),
  ]);

// Named pipes exist only on Windows, so that suite registers only there.
describeCanopyClientConformance(
  isWindows ? 'node named pipe' : 'node unix socket',
  async () => {
    const peer = await listenSocketPeer();
    const [connection, server] = await connectPair(peer);
    const close = async (): Promise<void> => {
      connection.close();
      server.close();
      await peer.close();
    };
    return { client: connection, server, close };
  },
);

describe('node connector', () => {
  const peers: SocketPeer[] = [];
  const releases: (() => void)[] = [];
  afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await Promise.all(peers.splice(0).map((peer) => peer.close()));
  });
  async function listen(script?: PeerScript): Promise<SocketPeer> {
    const peer = await listenSocketPeer(script);
    peers.push(peer);
    return peer;
  }
  const held = (): Promise<never> =>
    new Promise((_, reject) => releases.push(() => reject(new Error('end'))));

  it('connects, authenticates, and initializes under one deadline, then keeps the caller signal', async () => {
    const peer = await listen();
    const controller = new AbortController();
    const [{ connected, server, core }, pending] = await pendingTimers(
      async () => {
        const connecting = connectCanopyClient({
          endpoint: endpointOf(peer),
          timeoutMs: 300,
          signal: controller.signal,
          ...client,
        });
        const server = await peer.next();
        const core = serveCanonicalCore(server, {
          'core.test.echo': () => ({ text: 'after', length: 5 }),
        });
        return { connected: await connecting, server, core };
      },
    );
    expect(pending).toEqual([]);
    expect(connected.identity.connectionId).toBe(server.connectionId);
    await sleep(350);
    await expect(
      connected.query('core.test.echo', { text: 'after' }),
    ).resolves.toEqual({ text: 'after', length: 5 });
    controller.abort();
    expect(connected.signal.aborted).toBe(true);
    expect(await within(core.done)).toBeUndefined();
    expect(await peer.allClosed()).toBe(true);
  });

  it('detaches setup cancellation from a framed connection and applies its frame cap', async () => {
    const peer = await listen();
    const controller = new AbortController();
    const [[connection, server], pending] = await pendingTimers(() =>
      Promise.all([
        connectCanopyFramedConnection({
          endpoint: endpointOf(peer, { maxFrameBytes: 4_096 }),
          timeoutMs: 100,
          signal: controller.signal,
        }),
        peer.next(),
      ]),
    );
    expect(pending).toEqual([]);
    controller.abort();
    await sleep(150);
    expect([connection.signal.aborted, server.signal.aborted]).toEqual([
      false,
      false,
    ]);
    const pad = 'x'.repeat(8_192);
    await expect(
      connection.send({
        jsonrpc: '2.0',
        method: 'core.test.pad',
        params: { pad },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'resource_exhausted' } });
    connection.close();
    server.close();
  });

  const wrongSecret = { auth: { ...PEER_AUTH, secret: 'wrong-secret' } };
  it.each<[string, PeerScript, Partial<PathEndpoint>, string]>([
    ['a wrong secret', 'auth', wrongSecret, 'unauthenticated'],
    ['a silent peer', 'silent', {}, 'deadline_exceeded'],
    ['an abort', 'silent', {}, 'cancelled'],
    ['a peer that hangs up', 'drop', {}, 'unavailable'],
  ])(
    'fails authentication on %s and releases the socket',
    async (_, script, overrides, kind) => {
      const peer = await listen(script);
      const controller = new AbortController();
      const failing = rejection(
        connectCanopyFramedConnection({
          endpoint: endpointOf(peer, overrides),
          timeoutMs: kind === 'cancelled' ? undefined : 100,
          signal: controller.signal,
        }),
      );
      for (let i = 0; i < 200 && !peer.accepted.length; i += 1) await sleep(5);
      if (kind === 'cancelled') controller.abort();
      const payload = await within(failing);
      expect(payload).toMatchObject({ kind });
      redacted(payload, peer.path);
      expect(peer.accepted).toHaveLength(1);
      expect(await peer.allClosed()).toBe(true);
    },
  );

  const base = canonicalInitializeResult();
  const runtime = { ...base.runtime, protocolVersions: [2] };
  const newer = { ...base, selectedProtocolVersion: 2, runtime };
  it.each<[string, (abort: () => void) => unknown, string]>([
    ['the deadline lapses', held, 'deadline_exceeded'],
    [
      'the caller aborts',
      (abort): Promise<never> => Promise.resolve(abort()).then(held),
      'cancelled',
    ],
    [
      'the core is a newer major version',
      (): typeof newer => newer,
      'failed_precondition',
    ],
  ])(
    'closes the owned connection when initialize fails because %s',
    async (_, initialize, kind) => {
      const peer = await listen();
      const controller = new AbortController();
      const connecting = rejection(
        connectCanopyClient({
          endpoint: endpointOf(peer),
          timeoutMs: 150,
          signal: controller.signal,
          ...client,
        }),
      );
      const server = await peer.next();
      serveCanonicalCore(server, {
        'core.runtime.initialize': () => initialize(() => controller.abort()),
      });
      expect(await within(connecting)).toMatchObject({ kind });
      expect(await peer.allClosed()).toBe(true);
      expect(server.signal.aborted).toBe(true);
    },
  );

  it('rejects pre-aborted, mismatched, and invalid setups before any socket I/O', async () => {
    const peer = await listen();
    const other = isWindows ? 'socket' : 'pipe';
    const cases: [Partial<PathEndpoint>, number | undefined, string][] = [
      [{}, undefined, 'cancelled'],
      [{ kind: other }, undefined, 'capability_unavailable'],
      [{ path: '' }, undefined, 'invalid_argument'],
      [{}, 0, 'invalid_argument'],
      [{}, 1.5, 'invalid_argument'],
      [{}, 2 ** 31, 'invalid_argument'],
    ];
    for (const [overrides, timeoutMs, kind] of cases) {
      const payload = await rejection(
        connectCanopyFramedConnection({
          endpoint: endpointOf(peer, overrides),
          timeoutMs,
          signal: kind === 'cancelled' ? AbortSignal.abort() : undefined,
        }),
      );
      expect(payload).toMatchObject({ kind });
      redacted(payload, peer.path);
    }
    // A later connection is the first accept, so none of the above dialed.
    const [probe, server] = await connectPair(peer);
    expect(peer.accepted).toHaveLength(1);
    probe.close();
    server.close();
  });

  it('adopts an in-memory connection, and closes it when the caller already aborted', async () => {
    const live = await createInMemoryFramedPair();
    const endpoint = { kind: 'inMemory', connection: live.client } as const;
    await expect(connectCanopyFramedConnection({ endpoint })).resolves.toBe(
      live.client,
    );
    const core = serveCanonicalCore(live.server, {});
    const connected = await connectCanopyClient({ endpoint, ...client });
    expect(connected.connection).toBe(live.client);
    await connected.close();
    expect(await within(core.done)).toBeUndefined();

    const doomed = await createInMemoryFramedPair();
    const payload = await rejection(
      connectCanopyClient({
        endpoint: { kind: 'inMemory', connection: doomed.client },
        signal: AbortSignal.abort(),
        ...client,
      }),
    );
    expect(payload).toMatchObject({ kind: 'cancelled' });
    expect(doomed.client.signal.aborted).toBe(true);
    doomed.server.close();
  });

  it.each([true, false])(
    'cancels framed in-memory setup aborted in the call turn (pre-aborted: %s)',
    async (preAborted) => {
      const pair = await createInMemoryFramedPair();
      const controller = new AbortController();
      if (preAborted) controller.abort();
      const { signal } = controller;
      const endpoint = { kind: 'inMemory', connection: pair.client } as const;
      const connecting = connectCanopyFramedConnection({ endpoint, signal });
      controller.abort();
      const { kind } = await rejection(connecting);
      expect([kind, pair.client.signal.aborted]).toEqual(['cancelled', true]);
      pair.server.close();
    },
  );

  it('keeps every timer within the platform maximum at the longest deadline', async () => {
    const peer = await listen();
    const timers = jest.spyOn(globalThis, 'setTimeout');
    // Frozen time leaves the whole 2^31 - 1 ms budget for the handshake.
    const now = jest.spyOn(performance, 'now').mockReturnValue(0);
    const outcome = await Promise.allSettled([
      connectCanopyFramedConnection({
        endpoint: endpointOf(peer),
        timeoutMs: 2 ** 31 - 1,
      }),
      peer.next(),
    ]);
    const delays = timers.mock.calls.map(([, ms]) => ms ?? 0);
    timers.mockRestore();
    now.mockRestore();
    for (const settled of outcome)
      if (settled.status === 'fulfilled') settled.value.close();
    expect(Math.max(...delays)).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(outcome.map(({ status }) => status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
  });

  const unavailable = { kind: 'unavailable', retry: { kind: 'same_request' } };
  // Root bypasses socket file permissions, so EACCES runs only unprivileged.
  const denied = process.getuid?.() === 0 ? [] : ['EACCES'];
  (isWindows ? it.skip : it).each(['ENOENT', 'ECONNREFUSED', ...denied])(
    'maps a Unix %s without exposing the path',
    async (code) => {
      const peer = await listen();
      const path = join(dirname(peer.path), code);
      if (code === 'ECONNREFUSED') {
        // A socket file whose listener closed refuses connections.
        const gone = await listenSocketPeer();
        renameSync(gone.path, path);
        await gone.close();
      }
      if (code === 'EACCES') chmodSync(peer.path, 0);
      const payload = await rejection(
        connectCanopyFramedConnection({
          endpoint: endpointOf(peer, code === 'EACCES' ? {} : { path }),
        }),
      );
      expect(payload).toMatchObject(
        code === 'EACCES' ? { kind: 'permission_denied' } : unavailable,
      );
      redacted(payload, dirname(path));
    },
  );
});

it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  'fails setup that finishes past its deadline before the timer fires (initialize: %s, rejects: %s)',
  async (initialize, rejects) => {
    const pair = await createInMemoryFramedPair();
    const now = jest.spyOn(performance, 'now').mockReturnValue(0);
    const endpoint = { kind: 'inMemory', connection: pair.client } as const;
    try {
      serveCanonicalCore(pair.server, {
        'core.runtime.initialize': () => {
          now.mockReturnValue(1_001);
          if (!rejects) return canonicalInitializeResult();
          const retry = { kind: 'never' } as const;
          const denied = { kind: 'unauthenticated', message: 'No.', retry };
          return Promise.reject(new CanonicalCoreError(denied));
        },
      });
      const options = { endpoint, timeoutMs: 1_000 };
      const connecting = initialize
        ? connectCanopyClient({ ...options, ...client })
        : connectCanopyFramedConnection(options);
      if (!initialize) now.mockReturnValue(1_001);
      expect((await rejection(connecting)).kind).toBe('deadline_exceeded');
      expect(pair.client.signal.aborted).toBe(true);
    } finally {
      now.mockRestore();
      pair.server.close();
    }
  },
);

it.each([
  ['the endpoint path', (peer: SocketPeer): string => peer.path, true],
  ['the auth secret', (): string => PEER_SECRET, true],
  ['nothing private', (): string => 'session', false],
])('redacts an initialize retry resource naming %s', async (_, name, leaks) => {
  const peer = await listenSocketPeer();
  const retry = { kind: 'after_refresh', resource: name(peer) } as const;
  const error = {
    kind: 'unauthenticated',
    message: 'Refresh.',
    retry,
  } as const;
  try {
    const connecting = connectCanopyClient({
      endpoint: endpointOf(peer),
      ...client,
    });
    serveCanonicalCore(await peer.next(), {
      'core.runtime.initialize': () =>
        Promise.reject(new CanonicalCoreError(error)),
    });
    const payload = await rejection(connecting);
    expect(payload.retry).toEqual(leaks ? { kind: 'never' } : retry);
    redacted(payload, peer.path);
  } finally {
    await peer.close();
  }
});

// Node defers a Unix connect to a tick that runs before promise jobs in a
// macrotask, so an over-long path's EINVAL must not outlive a same-turn abort.
(isWindows ? it.skip : it)(
  'survives an aborted over-long socket path from a timer callback',
  () => {
    const index = JSON.stringify(
      pathToFileURL(join(__dirname, '../index.ts')).href,
    );
    const script = `const node = await import(${index});
setTimeout(() => ['connectCanopyFramedConnection', 'connectCanopyClient'].forEach((name) => {
  const controller = new AbortController();
  const endpoint = { kind: 'socket', path: '/tmp/' + 'x'.repeat(200), auth: ${JSON.stringify(PEER_AUTH)} };
  const definitions = { queries: {}, instructions: {}, streams: {} };
  node[name]({ endpoint, signal: controller.signal, clientName: 'c', clientVersion: '1', definitions })
    .catch((error) => console.log(error.payload.kind));
  controller.abort();
}));`;
    const root = join(__dirname, '../../../../..');
    const env = {
      ...process.env,
      TSX_TSCONFIG_PATH: join(root, 'tsconfig.base.json'),
    };
    const args = ['--import', 'tsx', '--input-type=module', '-e', script];
    const child = spawnSync(process.execPath, args, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect({
      status: child.status,
      stdout: child.stdout,
      unhandled: /Unhandled 'error'/.test(child.stderr),
    }).toEqual({
      status: 0,
      stdout: 'cancelled\ncancelled\n',
      unhandled: false,
    });
  },
  30_000,
);
