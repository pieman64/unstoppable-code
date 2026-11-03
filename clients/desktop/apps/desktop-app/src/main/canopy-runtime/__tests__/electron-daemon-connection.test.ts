import { CanopyClientError } from '@canopy/core-client';
import { canopyDaemonRefusalError } from '@canopy/core-client/node';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  FakeLeaseCore,
  type LeaseTestClient,
} from '../../../../../../packages/core-client/src/__tests__/fixtures/lease-core';
import {
  createElectronDaemonConnectionService,
  daemonUnreachableReason,
  type ElectronDaemonConnectionOptions,
  type ElectronDaemonConnectionService,
  type ElectronDaemonReachability,
} from '../electron-daemon-connection';
import { createElectronDaemonHealth } from '../electron-daemon-health';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-user',
  clientInstanceId: 'renderer-1',
  authorityId: 'authority-1',
  interfaceKind: 'desktop',
  grants: ['core.runtime.read'],
};
const ownerClosed = { payload: { kind: 'cancelled' } };
const timedOut = { payload: { kind: 'deadline_exceeded' } };
let core: FakeLeaseCore;
let service: ElectronDaemonConnectionService<LeaseTestClient>;
let owners: AbortController[];
let identity: jest.Mock<Promise<string>>;
let attach: jest.Mock<Promise<LeaseTestClient>>;
beforeEach(() => {
  core = new FakeLeaseCore();
  owners = [];
  identity = jest.fn(() => Promise.resolve('authority-1'));
  attach = jest.fn(() => core.connect());
  service = makeService();
});
afterEach(async () => {
  await service.dispose();
  for (const server of core.servers) server.close();
});
function makeService(
  options: Partial<ElectronDaemonConnectionOptions<LeaseTestClient>> = {},
): typeof service {
  return createElectronDaemonConnectionService({
    enabled: true,
    authorityId: identity,
    attach,
    ...options,
  });
}
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function owner(): AbortSignal {
  const controller = new AbortController();
  owners.push(controller);
  return controller.signal;
}
it('stays lazy and opt-in off never contacts the daemon', async () => {
  const off = makeService({ enabled: false });
  await expect(off.get(caller, owner())).rejects.toMatchObject({
    payload: { kind: 'capability_unavailable' },
  });
  expect(core.servers).toHaveLength(0);
  expect(identity).not.toHaveBeenCalled();
  await off.dispose();
});
it('cancels pending trusted identity without contacting the daemon after late resolution', async () => {
  const lookup = gate<string>();
  identity.mockImplementation(() => lookup.promise);
  const pending = service.get(caller, owner());
  const rejected = expect(pending).rejects.toMatchObject(ownerClosed);
  await new Promise((done) => setImmediate(done));
  owners[0].abort();
  await Promise.all([rejected, service.dispose()]);
  lookup.resolve('authority-1');
  await new Promise((done) => setImmediate(done));
  expect(core.servers).toHaveLength(0);
});
it('reuses an authenticated connection and its effective manifest for one owner', async () => {
  const signal = owner();
  const [a, b] = await Promise.all([
    service.get(caller, signal),
    service.get(caller, signal),
  ]);
  expect(a).toBe(b);
  expect(core.servers).toHaveLength(1);
  expect(core.callsOf('core.client.lease.acquire')[0].params).toMatchObject({
    interfaceKind: 'desktop',
  });
  await a.close();
  expect(await service.get(caller, signal)).not.toBe(a);
});
it('reprobes after a terminal reconnect failure with the same live owner', async () => {
  const signal = owner();
  const first = await service.get(caller, signal);
  attach.mockImplementationOnce(async () => {
    const client = await core.connect();
    return { ...client, identity: { ...client.identity, profile: 'worker' } };
  });
  core.servers[0].close();
  await new Promise((done) => setImmediate(done));
  expect(first.lease.state).toBe('failed');
  expect(core.servers[1].signal.aborted).toBe(true);
  expect(core.callsOf('core.client.lease.acquire')).toHaveLength(1);
  const replacement = await service.get(caller, signal);
  expect(replacement.client.signal.aborted).toBe(false);
});
it('reload gives a new connection and scope changes invalidate previous use', async () => {
  const a = await service.get(caller, owner());
  const firstClient = a.client;
  const b = await service.get(caller, owner());
  const secondClient = b.client;
  expect(firstClient.signal.aborted).toBe(true);
  expect(b.client.identity.connectionId).not.toBe(
    firstClient.identity.connectionId,
  );
  await expect(
    service.get({ ...caller, authorityId: 'foreign' }, owners[1].signal),
  ).rejects.toMatchObject({ payload: { kind: 'failed_precondition' } });
  expect(secondClient.signal.aborted).toBe(true);
  expect(core.servers).toHaveLength(2);
});
it('bounds typed failures and retires abandoned renderer entries after cooldown', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const writes = jest.spyOn(Map.prototype, 'set');
  const failure = new CanopyClientError({
    kind: 'unauthenticated',
    message: 'Invalid token.',
    retry: { kind: 'never' },
  });
  attach.mockRejectedValue(failure);
  try {
    const signal = owner();
    await expect(service.get(caller, signal)).rejects.toBe(failure);
    await expect(service.get(caller, signal)).rejects.toBe(failure);
    expect(attach).toHaveBeenCalledTimes(1);
    const cache = writes.mock.contexts.find(
      (map: unknown): map is Map<unknown, unknown> =>
        map instanceof Map && map.has(caller.clientInstanceId),
    );
    expect(cache?.size).toBe(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(cache?.size).toBe(0);
  } finally {
    writes.mockRestore();
    jest.useRealTimers();
  }
});
it.each([false, true])(
  'drains late attachment and client close on disposal (reconnect=%s)',
  async (reconnect) => {
    const delivery = gate<void>();
    const closed = gate<void>();
    let held = !reconnect;
    const late = makeService({
      attach: async () => {
        if (held) await delivery.promise;
        const client = await core.connect();
        if (held) {
          const close = client.close.bind(client);
          jest.spyOn(client, 'close').mockImplementation(async () => {
            await closed.promise;
            await close();
          });
        }
        return client;
      },
    });
    const pending = late.get(caller, owner());
    const observed = pending.catch((error: unknown) => error);
    await new Promise((done) => setImmediate(done));
    if (reconnect) {
      await pending;
      held = true;
      core.servers[0].close();
      await new Promise((done) => setImmediate(done));
    }
    let disposed = false;
    const disposing = late.dispose().then(() => {
      disposed = true;
    });
    try {
      await new Promise((done) => setImmediate(done));
      expect(disposed).toBe(false);
      delivery.resolve();
      await new Promise((done) => setImmediate(done));
      expect(disposed).toBe(false);
    } finally {
      delivery.resolve();
      closed.resolve();
      await disposing;
    }
    if (!reconnect) expect(await observed).toMatchObject(ownerClosed);
    expect(core.servers.every((server) => server.signal.aborted)).toBe(true);
    expect(core.leases.size).toBe(reconnect ? 1 : 0);
    await expect(late.get(caller, owner())).rejects.toMatchObject(ownerClosed);
  },
);
it('disposal closes admission while a renderer replacement drains its old lease', async () => {
  await service.get(caller, owner());
  const release = gate<void>();
  core.script('core.client.lease.release', release.promise);
  const replacing = service.get(caller, owner());
  const rejected = expect(replacing).rejects.toMatchObject(ownerClosed);
  await new Promise((done) => setImmediate(done));
  const disposing = service.dispose();
  release.resolve();
  await Promise.all([rejected, disposing]);
  expect(core.leases.size).toBe(0);
  expect(core.servers.every((server) => server.signal.aborted)).toBe(true);
});
it.each(['setup', 'cleanup', 'replacement'])(
  'bounds stalled %s and closes late ownership',
  async (phase) => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'performance'],
    });
    const delivery = gate<LeaseTestClient>();
    const blockedAttach = jest
      .fn(attach)
      .mockImplementationOnce(() => delivery.promise);
    const { payload } = new CanopyClientError({
      kind: 'unavailable',
      message: 'Retry acquisition.',
      retry: { kind: 'same_idempotency_key', delayMs: 1_000 },
    });
    if (phase === 'setup')
      core.script('core.client.lease.acquire', payload, payload);
    const bounded = makeService({
      setupTimeoutMs: 50,
      cleanupTimeoutMs: 50,
      attach: phase !== 'setup' ? blockedAttach : attach,
    });
    if (phase === 'replacement') service = bounded;
    const pending = bounded
      .get(caller, owner())
      .catch((error: unknown) => error);
    await new Promise((done) => setImmediate(done));
    if (phase === 'replacement') owners.at(-1)?.abort();
    const nextOwner = owner();
    const result = (
      phase === 'cleanup'
        ? bounded.dispose()
        : phase === 'replacement'
          ? bounded.get(caller, nextOwner)
          : pending
    ).catch((error: unknown) => error);
    try {
      await jest.advanceTimersByTimeAsync(50);
      expect(await result).toMatchObject(timedOut);
      if (phase === 'replacement') {
        const second = bounded
          .get(caller, nextOwner)
          .catch((error: unknown) => error);
        await new Promise((done) => setImmediate(done));
        expect(blockedAttach).toHaveBeenCalledTimes(1);
        expect(await second).toMatchObject(timedOut);
      }
      if (phase === 'setup') await bounded.dispose();
    } finally {
      if (phase !== 'setup') delivery.resolve(await core.connect());
      await new Promise((done) => setImmediate(done));
      jest.useRealTimers();
    }
    if (phase === 'replacement') {
      expect((await bounded.get(caller, nextOwner)).lease.state).toBe('active');
      await bounded.dispose();
      await new Promise((done) => setImmediate(done));
    }
    expect(core.servers.every((server) => server.signal.aborted)).toBe(true);
  },
);
it('fences cached late replies after owner loss while preserving another renderer lease', async () => {
  const session = await service.get(caller, owner());
  const other = await service.get(
    { ...caller, clientInstanceId: 'renderer-2' },
    owner(),
  );
  expect(session.lease.lease?.leaseId).not.toBe(other.lease.lease?.leaseId);
  expect(session.client.identity.connectionId).not.toBe(
    other.client.identity.connectionId,
  );
  const deliver = gate<void>();
  const release = gate<void>();
  const cached = session.client;
  expect(Reflect.get(session.lease, 'client')).toBeUndefined();
  core.script('core.client.lease.renew', { deliver: deliver.promise });
  core.script('core.client.lease.release', release.promise);
  const renew = (): ReturnType<LeaseTestClient['instruction']> =>
    cached.instruction('core.client.lease.renew', {
      expectedRevision: 0,
      interactive: true,
      foreground: false,
    });
  const reply = renew();
  const rejected = expect(reply).rejects.toMatchObject(ownerClosed);
  await new Promise((done) => setImmediate(done));
  owners[0].abort();
  const disposing = session.close();
  try {
    expect(cached.signal.aborted).toBe(true);
    expect(other.client.signal.aborted).toBe(false);
    expect(renew).toThrow(CanopyClientError);
    deliver.resolve();
    await rejected;
  } finally {
    release.resolve();
    await disposing;
  }
  expect(core.leases.size).toBe(1);
});
it('lets an observer ride each resolved session without opening one', async () => {
  const observed: [unknown, string][] = [];
  const observing = makeService({
    onSession: (session, observedCaller) =>
      void observed.push([session, observedCaller.clientInstanceId]),
  });
  const signal = owner();
  const first = await observing.get(caller, signal);
  const again = await observing.get(caller, signal);
  expect(again).toBe(first);
  expect(observed).toEqual([
    [first, 'renderer-1'],
    [first, 'renderer-1'],
  ]);
  expect(core.servers).toHaveLength(1);
  const off = makeService({
    enabled: false,
    onSession: () => observed.push([null, 'never']),
  });
  await expect(off.get(caller, owner())).rejects.toMatchObject({
    payload: { kind: 'capability_unavailable' },
  });
  expect(observed).toHaveLength(2);
  await Promise.all([observing.dispose(), off.dispose()]);
});
it("observes the id each session's lease holds, which the daemon attributes its commits to", async () => {
  // W5e: the daemon's caller is the lease's client instance, so the id the
  // observer records as own is the `publishedBy` of that session's commits.
  const observed: string[] = [];
  const observing = makeService({
    onSession: (_session, observedCaller) =>
      void observed.push(observedCaller.clientInstanceId),
  });
  await observing.get(caller, owner());
  await observing.get({ ...caller, clientInstanceId: 'renderer-2' }, owner());
  expect(
    core
      .callsOf('core.client.lease.acquire')
      .map(({ params }) => params.clientInstanceId),
  ).toEqual(observed);
  expect(observed).toEqual(['renderer-1', 'renderer-2']);
  await observing.dispose();
});

describe('background service reachability (CAN-5541)', () => {
  let events: ElectronDaemonReachability['kind'][];
  let reasons: (string | undefined)[];
  /** What the notice would show, from main's health record fed by `service`. */
  let shown: (string | undefined)[];
  beforeEach(() => {
    events = [];
    reasons = [];
    shown = [];
    const health = createElectronDaemonHealth({
      warn: () => {},
      info: () => {},
    });
    health.setConsumerEnabled('files_reads', true);
    health.onStatusChanged(
      (status) =>
        void shown.push(
          status.state === 'unavailable' ? status.reason : status.state,
        ),
    );
    service = makeService({
      onReachability: (event) => {
        events.push(event.kind);
        if (event.kind === 'unreachable') reasons.push(event.reason);
        health.observe(event);
      },
    });
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1)
      await new Promise((done) => setImmediate(done));
  };
  const typed = (
    kind: CanopyClientError['payload']['kind'],
  ): CanopyClientError =>
    new CanopyClientError({
      kind,
      message: 'Refused.',
      retry: { kind: 'never' },
    });

  it.each([
    ['an exit before ready', 'start_failed', 'unavailable', 'Core exited.'],
    ['a failed precondition', 'start_failed', 'failed_precondition', 'No.'],
    // No connected daemon remains to refuse, so nothing could serve.
    [
      'an incompatible protocol',
      'start_failed',
      'failed_precondition',
      'Core protocol version is incompatible',
    ],
    ['a handshake unauthenticated', 'start_failed', 'unauthenticated', 'No.'],
    ['a deadline', 'connect_timeout', 'deadline_exceeded', 'Timed out.'],
  ] as const)(
    'tags %s attach rejection as %s and keeps its identity',
    async (_case, reason, kind, message) => {
      const rejection = new CanopyClientError({
        kind,
        message,
        retry: { kind: 'never' },
      });
      attach.mockRejectedValueOnce(rejection);
      await expect(service.get(caller, owner())).rejects.toBe(rejection);
      expect(daemonUnreachableReason(rejection)).toBe(reason);
      expect(events).toEqual(['unreachable']);
      expect(reasons).toEqual([reason]);
      expect(shown).toEqual([reason]);
    },
  );

  // CAN-5543: refusals warn like any failed start (#7297) unless the app's
  // own restart window claims them; that window shows nothing (q-13).
  it.each(['writer_held', 'peer_held', 'version_skew'] as const)(
    'tags a %s refusal a failed start outside a restart window',
    async (refusal) => {
      const rejection = canopyDaemonRefusalError(refusal, 'Refused.');
      attach.mockRejectedValueOnce(rejection);
      await expect(service.get(caller, owner())).rejects.toBe(rejection);
      expect(daemonUnreachableReason(rejection)).toBe('start_failed');
      expect(shown).toEqual(['start_failed']);
    },
  );

  it('leaves a refusal the restart window claims untagged and unshown', async () => {
    const claimed: unknown[] = [];
    service = makeService({
      onReachability: (event) => events.push(event.kind),
      isRestartRefusal: (error) => {
        claimed.push(error);
        return true;
      },
    });
    const rejection = canopyDaemonRefusalError('peer_held', 'Refused.');
    attach.mockRejectedValueOnce(rejection);
    await expect(service.get(caller, owner())).rejects.toBe(rejection);
    expect(claimed).toEqual([rejection]);
    expect(daemonUnreachableReason(rejection)).toBeNull();
    await settle();
    expect(events).toEqual([]);
  });

  it('never tags a cancelled attach rejection', async () => {
    const rejection = typed('cancelled');
    attach.mockRejectedValueOnce(rejection);
    await expect(service.get(caller, owner())).rejects.toBe(rejection);
    expect(daemonUnreachableReason(rejection)).toBeNull();
    expect(events).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('never tags an attach that rejects after its owner closed', async () => {
    let rejectAttach: (error: unknown) => void = () => {};
    attach.mockImplementationOnce(
      () =>
        new Promise<LeaseTestClient>((_resolve, reject) => {
          rejectAttach = reject;
        }),
    );
    const pending = service
      .get(caller, owner())
      .catch((error: unknown) => error);
    await settle();
    expect(attach).toHaveBeenCalledTimes(1);
    owners[0].abort();
    // The aborted attach then fails as an unreachable daemon would.
    const late = typed('unavailable');
    rejectAttach(late);
    await settle();
    const rejection = await pending;
    expect(rejection).toMatchObject(ownerClosed);
    expect(daemonUnreachableReason(rejection)).toBeNull();
    expect(daemonUnreachableReason(late)).toBeNull();
    expect(events).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('tags an untyped attach rejection and a failed host lookup', async () => {
    const spawn = new Error('spawn ENOENT');
    attach.mockRejectedValueOnce(spawn);
    await expect(service.get(caller, owner())).rejects.toBe(spawn);
    expect(daemonUnreachableReason(spawn)).toBe('start_failed');
    const host = new Error('data root unavailable');
    identity.mockRejectedValueOnce(host);
    await expect(service.get(caller, owner())).rejects.toBe(host);
    expect(daemonUnreachableReason(host)).toBe('host_unavailable');
    expect(reasons).toEqual(['start_failed', 'host_unavailable']);
    expect(core.servers).toHaveLength(0);
  });

  it('tags a worker-profile daemon at setup as a failed start', async () => {
    attach.mockImplementationOnce(async () => {
      const client = await core.connect();
      return { ...client, identity: { ...client.identity, profile: 'worker' } };
    });
    const rejection = await service
      .get(caller, owner())
      .catch((error: unknown) => error);
    expect(rejection).toMatchObject({
      payload: { kind: 'failed_precondition' },
    });
    expect(daemonUnreachableReason(rejection)).toBe('start_failed');
    // Closing the rejected client is not a lost session.
    expect(events).toEqual(['unreachable']);
  });

  it('tags the setup timer (setTimeout) firing on a stalled setup as a connect timeout', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'performance'],
    });
    const delivery = gate<LeaseTestClient>();
    attach.mockImplementationOnce(() => delivery.promise);
    const bounded = makeService({
      setupTimeoutMs: 50,
      onReachability: (event) => void events.push(event.kind),
    });
    try {
      const pending = bounded
        .get(caller, owner())
        .catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(50);
      const rejection = await pending;
      expect(rejection).toMatchObject(timedOut);
      expect(daemonUnreachableReason(rejection)).toBe('connect_timeout');
      expect(events).toEqual(['unreachable']);
    } finally {
      delivery.resolve(await core.connect());
      await new Promise((done) => setImmediate(done));
      jest.useRealTimers();
      await bounded.dispose();
    }
  });

  it('never tags a refusal, a cancellation or a disabled transport', async () => {
    const off = makeService({
      enabled: false,
      onReachability: (event) => void events.push(event.kind),
    });
    const failures: unknown[] = [
      await off.get(caller, owner()).catch((error: unknown) => error),
      await service
        .get({ ...caller, interfaceKind: 'cli' }, owner())
        .catch((error: unknown) => error),
      await service
        .get({ ...caller, authorityId: 'foreign' }, owner())
        .catch((error: unknown) => error),
    ];
    const closed = new AbortController();
    closed.abort();
    failures.push(
      await service.get(caller, closed.signal).catch((error: unknown) => error),
    );
    attach.mockRejectedValueOnce(typed('cancelled'));
    failures.push(
      await service.get(caller, owner()).catch((error: unknown) => error),
    );
    expect(failures.map((failure) => daemonUnreachableReason(failure))).toEqual(
      [null, null, null, null, null],
    );
    // A lease refusal from a connected daemon: it was reached.
    core.script(
      'core.client.lease.acquire',
      typed('permission_denied').payload,
    );
    const refused = await service
      .get({ ...caller, clientInstanceId: 'renderer-2' }, owner())
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(daemonUnreachableReason(refused)).toBeNull();
    expect(events).toEqual(['reached']);
    await off.dispose();
  });

  it('reports a drop as lost, then reached once the lease reconnects', async () => {
    const session = await service.get(caller, owner());
    core.servers[0].close();
    await settle();
    expect(events).toEqual(['reached', 'lost', 'reached']);
    expect(session.lease.state).toBe('active');
    expect(core.servers).toHaveLength(2);
    // A killed daemon the lease restarts stays hidden while it restarts.
    expect(shown).toEqual(['reconnecting', 'ok']);
  });

  it('reports a failed reconnect as unreachable', async () => {
    const signal = owner();
    const first = await service.get(caller, signal);
    attach.mockRejectedValueOnce(typed('failed_precondition'));
    core.servers[0].close();
    await settle();
    expect(first.lease.state).toBe('failed');
    expect(events).toEqual(['reached', 'lost', 'unreachable']);
    expect(reasons).toEqual(['reconnect_failed']);
    // The restart failed: shown at once.
    expect(shown).toEqual(['reconnecting', 'reconnect_failed']);
  });

  const exitedBeforeReady = (): CanopyClientError =>
    new CanopyClientError({
      kind: 'unavailable',
      message: 'Core exited before it was ready.',
      retry: { kind: 'same_request' },
    });

  it('keeps a reconnect the lease retries hidden, then reached when a later attach succeeds', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'performance'],
    });
    try {
      const first = await service.get(caller, owner());
      attach.mockRejectedValueOnce(exitedBeforeReady());
      core.servers[0].close();
      await settle();
      // Still restarting while the lease backs off (Mike, q-13 GA3-1).
      expect(first.lease.state).toBe('reconnecting');
      expect(events).toEqual(['reached', 'lost']);
      await jest.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(first.lease.state).toBe('active');
      expect(events).toEqual(['reached', 'lost', 'reached']);
      expect(shown).toEqual(['reconnecting', 'ok']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a reconnect the lease retries once the lease gives up', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'performance'],
    });
    try {
      const first = await service.get(caller, owner());
      attach.mockRejectedValue(exitedBeforeReady());
      core.servers[0].close();
      await settle();
      await jest.advanceTimersByTimeAsync(20_000);
      await settle();
      expect(first.lease.state).toBe('reconnecting');
      expect(shown).toEqual(['reconnecting']);
      // The reconnect's 30 s delivery deadline ends the restart.
      await jest.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(first.lease.state).toBe('failed');
      expect(events).toEqual(['reached', 'lost', 'unreachable']);
      expect(reasons).toEqual(['reconnect_failed']);
      expect(shown).toEqual(['reconnecting', 'reconnect_failed']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('tags reading a session whose connection is down as connection lost, and a closed one as nothing', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'performance'],
    });
    const thrown = (read: () => unknown): unknown => {
      try {
        read();
      } catch (error) {
        return error;
      }
      throw new Error('Expected the read to throw.');
    };
    try {
      const session = await service.get(caller, owner());
      attach.mockRejectedValueOnce(exitedBeforeReady());
      core.servers[0].close();
      await settle();
      expect(session.lease.state).toBe('reconnecting');
      // A Files read here reaches the daemon no more than a failed attach.
      const down = thrown(() => session.client);
      expect(down).toMatchObject({ payload: { kind: 'unavailable' } });
      expect(daemonUnreachableReason(down)).toBe('connection_lost');
      await jest.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(session.client.signal.aborted).toBe(false);
      await session.close();
      expect(daemonUnreachableReason(thrown(() => session.client))).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a late replacement the lease never adopted closing is no loss', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'performance'],
    });
    const late = gate<LeaseTestClient>();
    try {
      const first = await service.get(caller, owner());
      attach.mockImplementationOnce(() => late.promise);
      core.servers[0].close();
      await settle();
      // The reconnect's 30 s delivery deadline passes with the attach pending.
      await jest.advanceTimersByTimeAsync(30_000);
      await settle();
      expect(first.lease.state).toBe('failed');
      expect(events).toEqual(['reached', 'lost', 'unreachable']);
      const replacement = await core.connect();
      late.resolve(replacement);
      await settle();
      // The lease closes the late client; reaching it is real, losing it is not.
      expect(replacement.signal.aborted).toBe(true);
      expect(events).toEqual(['reached', 'lost', 'unreachable', 'reached']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('tags a setup whose connection dropped before its lease was acquired as connection lost', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'performance'],
    });
    const answer = gate<void>();
    const late = gate<LeaseTestClient>();
    // Longer than the lease's 30 s delivery deadline, so the lease gives up first.
    const bounded = makeService({
      setupTimeoutMs: 120_000,
      onReachability: (event) => {
        events.push(event.kind);
        if (event.kind === 'unreachable') reasons.push(event.reason);
      },
    });
    try {
      core.script('core.client.lease.acquire', answer.promise);
      attach
        .mockImplementationOnce(() => core.connect())
        .mockImplementationOnce(() => late.promise);
      const pending = bounded
        .get(caller, owner())
        .catch((error: unknown) => error);
      await settle();
      expect(core.callsOf('core.client.lease.acquire')).toHaveLength(1);
      core.servers[0].close();
      await settle();
      await jest.advanceTimersByTimeAsync(30_000);
      const rejection = await pending;
      expect(rejection).toBeInstanceOf(CanopyClientError);
      expect(daemonUnreachableReason(rejection)).toBe('connection_lost');
      expect(events).toEqual(['reached', 'lost', 'unreachable']);
      expect(reasons).toEqual(['connection_lost']);
    } finally {
      answer.resolve();
      late.resolve(await core.connect());
      await settle();
      jest.useRealTimers();
      await bounded.dispose();
    }
  });

  it('reports nothing when the owner closes or the service is disposed', async () => {
    const signal = owner();
    await service.get(caller, signal);
    await service.get({ ...caller, clientInstanceId: 'renderer-2' }, owner());
    owners[0].abort();
    await settle();
    await service.dispose();
    await settle();
    expect(events).toEqual(['reached', 'reached']);
    expect(shown).toEqual([]);
  });

  it('a reload replacing its session is no loss', async () => {
    const replaced = (await service.get(caller, owner())).client;
    await service.get(caller, owner());
    await settle();
    expect(replaced.signal.aborted).toBe(true);
    expect(events).toEqual(['reached', 'reached']);
    expect(shown).toEqual([]);
  });

  it('a reprobe attempts again within the failed-setup reuse window', async () => {
    const rejection = typed('unavailable');
    attach.mockRejectedValueOnce(rejection);
    const signal = owner();
    await expect(service.get(caller, signal)).rejects.toBe(rejection);
    await expect(service.get(caller, signal)).rejects.toBe(rejection);
    expect(attach).toHaveBeenCalledTimes(1);
    const session = await service.get(caller, signal, { reprobe: true });
    expect(attach).toHaveBeenCalledTimes(2);
    // A live session is reused, not replaced.
    expect(await service.get(caller, signal, { reprobe: true })).toBe(session);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['unreachable', 'reached']);
  });

  it('an observer that throws never fails the read', async () => {
    const throwing = makeService({
      onReachability: () => {
        throw new Error('observer');
      },
    });
    await expect(throwing.get(caller, owner())).resolves.toBeDefined();
    await throwing.dispose();
  });
});
