import { CanopyClientError } from '@canopy/core-client';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  FakeLeaseCore,
  type LeaseTestClient,
} from '../../../../../../packages/core-client/src/__tests__/fixtures/lease-core';
import {
  createElectronDaemonConnectionService,
  type ElectronDaemonConnectionOptions,
  type ElectronDaemonConnectionService,
} from '../electron-daemon-connection';

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
