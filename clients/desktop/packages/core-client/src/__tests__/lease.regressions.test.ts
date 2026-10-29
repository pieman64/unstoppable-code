import type { CoreClientLease } from '@canopy/protocol/canopy-core';

import {
  ACQUIRE,
  CANCELLED,
  RENEW,
  RELEASE,
  gate,
  leaseError,
  setup,
  settle,
  until,
} from './fixtures/lease-regression-harness';

describe('createCanopyClientLease regressions', () => {
  it('releases once, stops timers, and rejects later acquires', async () => {
    const { core, owner, advance } = await setup();
    await owner.acquire();
    const unlisten = jest.spyOn(owner.client.signal, 'removeEventListener');
    const first = owner.release('sign_out');
    expect(owner.release('error')).toBe(first);
    await first;
    expect(core.callsOf(RELEASE).map(({ params }) => params.reason)).toEqual([
      'sign_out',
    ]);
    expect(owner.state).toBe('released');
    expect(owner.lease).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    expect(unlisten).toHaveBeenCalledWith('abort', expect.any(Function));
    await advance(120_000);
    expect(core.callsOf(RENEW)).toHaveLength(0);
    await expect(owner.acquire()).rejects.toMatchObject(CANCELLED);
  });

  it('issues each registration once per lease, honouring removal, replacement, and errors', async () => {
    const { core, owner, errors } = await setup();
    const calls: string[] = [];
    const log =
      (name: string): ((lease: CoreClientLease) => void) =>
      (lease) =>
        void calls.push(`${name}@${lease.leaseId}`);
    owner.register('throws', () => {
      throw new Error('sync failure');
    });
    const removeLater = owner.register('later', log('later'));
    owner.register('rejects', () => Promise.reject(new Error('async failure')));
    await owner.acquire();
    await settle();
    expect(errors.map((error) => error.message)).toEqual([
      'sync failure',
      'async failure',
    ]);
    owner.register('later', log('replaced'));
    removeLater();
    owner.register('added', log('added'));
    await settle();
    core.evict('lease-1');
    owner.notifyEvicted('lease-1');
    await until(() => owner.lease?.leaseId === 'lease-2');
    await settle();
    expect(calls).toEqual([
      'later@lease-1',
      'replaced@lease-1',
      'added@lease-1',
      'replaced@lease-2',
      'added@lease-2',
    ]);
    expect(errors).toHaveLength(4);
  });

  it('releases a lease granted while its acquire was pending', async () => {
    const { core, owner } = await setup();
    const reply = gate();
    core.script(ACQUIRE, reply.promise);
    const acquired = owner.acquire();
    await settle();
    const released = owner.release('normal_shutdown');
    await settle();
    // The release waits for the pending acquire, so it covers that lease.
    expect(core.callsOf(RELEASE)).toHaveLength(0);
    reply.open();
    await released;
    await expect(acquired).rejects.toMatchObject(CANCELLED);
    expect(core.callsOf(RELEASE)).toHaveLength(1);
    expect(core.leases.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fences a renew and a replay pending at release', async () => {
    const { core, owner, advance } = await setup();
    const slow = gate();
    const calls: string[] = [];
    owner.register('slow', () => {
      calls.push('slow');
      return slow.promise;
    });
    owner.register('next', () => void calls.push('next'));
    await owner.acquire();
    const reply = gate();
    core.script(RENEW, reply.promise);
    await advance(15_000);
    const released = owner.release('replaced');
    reply.open();
    slow.open();
    await released;
    await settle();
    const methods = core.calls.map((call) => call.method);
    expect(methods).toEqual([ACQUIRE, RENEW, RELEASE]);
    expect(calls).toEqual(['slow']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('acquires with the stable identity and schedules from each reply, not the proposal', async () => {
    const { core, owner, presence, advance, issued, acquired } = await setup();
    core.renewAfterMs = 4_000;
    await owner.acquire();
    expect(owner.lease).toMatchObject({ leaseId: 'lease-1', revision: 0 });
    const { _meta, ...params } = acquired(0);
    expect(_meta).toHaveProperty('idempotencyKey');
    expect(params).toEqual({
      clientInstanceId: 'c-1',
      interfaceKind: 'test',
      label: 'Test',
      interactive: true,
      foreground: true,
      renewalIntervalMs: 15_000,
    });
    await advance(3_999);
    expect(core.callsOf(RENEW)).toHaveLength(0);
    core.renewAfterMs = 7_000;
    presence.interactive = false;
    await advance(1);
    expect(core.callsOf(RENEW).map((call) => call.params)).toEqual([
      { expectedRevision: 0, interactive: false, foreground: true },
    ]);
    expect(owner.lease).toMatchObject({ revision: 1, renewAfterMs: 7_000 });
    await advance(6_999);
    expect(core.callsOf(RENEW)).toHaveLength(1);
    await advance(1);
    expect(core.callsOf(RENEW)[1].params.expectedRevision).toBe(1);
    // An expiry earlier than renewAfterMs wins; nothing is clamped locally.
    core.ttlMs = 2_000;
    await advance(7_000);
    core.renewAfterMs = 600_000;
    await advance(2_000);
    expect(core.callsOf(RENEW)).toHaveLength(4);
    expect(issued).toEqual(['lease-1@0']);
  });

  it('retains a lease within the grace, replays on a new id, and acquires fresh after it', async () => {
    const { core, owner, clients, issued, advance, holdAttach, acquired } =
      await setup();
    await owner.acquire();
    core.servers[0].close();
    await until(() => owner.state === 'active' && clients.length === 2);
    expect(core.callsOf(ACQUIRE)[1]).toMatchObject({
      connection: 1,
      params: { previousLeaseId: 'lease-1' },
    });
    expect(acquired(1)._meta).not.toEqual(acquired(0)._meta);
    expect(owner.lease?.leaseId).toBe('lease-1');
    expect(owner.client).toBe(clients[1]);
    expect(issued).toEqual(['lease-1@0']);
    core.retain = false;
    core.servers[1].close();
    await until(() => owner.lease?.leaseId === 'lease-2');
    expect(acquired(2)).toHaveProperty('previousLeaseId', 'lease-1');
    expect(issued).toEqual(['lease-1@0', 'lease-2@2']);
    const late = holdAttach();
    core.servers[2].close();
    await advance(10_001);
    late.open();
    await until(() => owner.lease?.leaseId === 'lease-3');
    expect(acquired(3)).not.toHaveProperty('previousLeaseId');
    expect(issued).toEqual(['lease-1@0', 'lease-2@2', 'lease-3@3']);
  });

  it('ignores foreign, stale, and duplicate evictions and collapses concurrent triggers', async () => {
    const { core, owner, issued, advance, acquired } = await setup();
    await owner.acquire();
    owner.notifyEvicted('lease-other');
    const renew = gate();
    core.script(RENEW, renew.promise);
    await advance(15_000);
    expect(core.callsOf(RENEW)).toHaveLength(1);
    core.evict('lease-1');
    owner.notifyEvicted('lease-1');
    owner.notifyEvicted('lease-1');
    owner.checkClock();
    renew.open();
    await until(() => owner.lease?.leaseId === 'lease-2');
    owner.notifyEvicted('lease-1');
    await settle();
    expect(core.callsOf(ACQUIRE)).toHaveLength(2);
    expect(acquired(1)).not.toHaveProperty('previousLeaseId');
    expect(issued).toEqual(['lease-1@0', 'lease-2@0']);
  });

  it.each(['notFound', 'invalidState'] as const)(
    'treats a %s renew as an eviction: fresh acquire, replayed once',
    async (code) => {
      const { core, owner, issued, advance, acquired } = await setup();
      await owner.acquire();
      core.script(RENEW, leaseError(code));
      await advance(15_000);
      await until(() => owner.lease?.leaseId === 'lease-2');
      expect(acquired(1)).not.toHaveProperty('previousLeaseId');
      expect(acquired(1)._meta).not.toEqual(acquired(0)._meta);
      expect(issued).toEqual(['lease-1@0', 'lease-2@0']);
    },
  );

  it('retries one revision conflict, and re-acquires on a second', async () => {
    const { core, owner, issued, advance } = await setup();
    await owner.acquire();
    const conflict = leaseError('revisionConflict');
    core.script(RENEW, conflict);
    await advance(15_000);
    expect(core.callsOf(RENEW)).toHaveLength(2);
    expect(owner.lease).toMatchObject({ leaseId: 'lease-1', revision: 1 });
    core.script(RENEW, conflict, conflict);
    await advance(15_000);
    await until(() => owner.lease?.leaseId === 'lease-2');
    expect(core.callsOf(RENEW)).toHaveLength(4);
    expect(core.callsOf(ACQUIRE)).toHaveLength(2);
    expect(issued).toEqual(['lease-1@0', 'lease-2@0']);
  });

  it('keeps the idempotency key across transient acquire retries only', async () => {
    const { core, owner, errors, advance, acquired } = await setup();
    core.script(ACQUIRE, {
      kind: 'unavailable',
      message: 'Busy.',
      retry: { kind: 'same_idempotency_key', delayMs: 2_000 },
    });
    const first = owner.acquire();
    await advance(1_999);
    expect(core.callsOf(ACQUIRE)).toHaveLength(1);
    await advance(1);
    await first;
    expect(acquired(1)).toEqual(acquired(0));
    expect(errors.map((error) => error.payload.kind)).toEqual(['unavailable']);
    core.evict('lease-1');
    owner.notifyEvicted('lease-1');
    await until(() => owner.lease?.leaseId === 'lease-2');
    expect(acquired(2)._meta).not.toEqual(acquired(0)._meta);
  });

  it('renews immediately after a forward wall-clock jump, and on monotonic time after a backward one', async () => {
    const { core, owner, advance, acquired } = await setup();
    await owner.acquire();
    jest.setSystemTime(Date.now() + 120_000);
    owner.checkClock();
    await until(() => owner.lease?.revision === 1);
    // Without a host resume signal, the watchdog notices within a quarter interval.
    jest.setSystemTime(Date.now() + 120_000);
    await advance(3_750);
    await until(() => owner.lease?.revision === 2);
    jest.setSystemTime(Date.now() - 3_600_000);
    await advance(14_999);
    expect(core.callsOf(RENEW)).toHaveLength(2);
    await advance(1);
    expect(core.callsOf(RENEW)).toHaveLength(3);
    // A pause past the TTL: the renew finds no lease, so it re-acquires.
    core.evict('lease-1');
    jest.setSystemTime(Date.now() + 120_000);
    owner.checkClock();
    await until(() => owner.lease?.leaseId === 'lease-2');
    expect(acquired(1)).not.toHaveProperty('previousLeaseId');
  });

  it('releases while detached without connecting, and closes a late attach', async () => {
    const { core, owner, clients, holdAttach } = await setup();
    await owner.acquire();
    const late = holdAttach();
    core.servers[0].close();
    await until(() => owner.state === 'reconnecting');
    await owner.release('normal_shutdown');
    late.open();
    await until(() => clients.length === 2 && clients[1].signal.aborted);
    expect(core.calls.map((call) => call.method)).toEqual([ACQUIRE]);
    expect(owner.client).toBe(clients[0]);
    expect(jest.getTimerCount()).toBe(0);
  });
});
