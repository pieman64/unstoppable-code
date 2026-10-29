import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';

import { CanopyClientError } from '../index';
import { leaseError, type LeaseTestClient } from './fixtures/lease-core';
import {
  ACQUIRE,
  RENEW,
  RELEASE,
  gate,
  until,
  settle,
  setup,
  type Gate,
} from './fixtures/lease-regression-harness';

describe('createCanopyClientLease', () => {
  it.each(['fails', 'succeeds'] as const)(
    'reissues only a registration that %s across a drop that keeps the lease id',
    async (outcome) => {
      const { core, owner, clients, errors, issued, advance, holdAttach } =
        await setup();
      const pending = gate();
      const flaky: number[] = [];
      owner.register('flaky', async (_lease, client) => {
        flaky.push(clients.indexOf(client));
        await pending.promise;
        if (outcome === 'fails') throw new Error('dropped');
      });
      await owner.acquire();
      await until(() => flaky.length === 1);
      const late = holdAttach();
      core.servers[0].close();
      await until(() => owner.state === 'reconnecting');
      pending.open();
      await settle();
      late.open();
      await until(() => owner.state === 'active' && flaky.length === 2);
      // Persistent failure waits for the next lease or connection: no busy loop.
      await advance(60_000);
      expect(owner.lease?.leaseId).toBe('lease-1');
      expect(issued).toEqual(['lease-1@0']);
      expect(flaky).toEqual([0, 1]);
      const failures = outcome === 'fails' ? ['dropped', 'dropped'] : [];
      expect(errors.map((error) => error.message)).toEqual(failures);
    },
  );

  it.each(['acquire', 'evict', 'drop'] as const)(
    'fails closed when presence throws on %s',
    async (when) => {
      const { core, owner, errors, readPresence } = await setup();
      const failed = { payload: { kind: 'internal', message: 'no presence' } };
      if (when !== 'acquire') await owner.acquire();
      readPresence.mockImplementation(() => {
        throw new Error('no presence');
      });
      const first = when === 'acquire' ? owner.acquire() : undefined;
      if (when === 'evict') owner.notifyEvicted('lease-1');
      if (when === 'drop') core.servers[0].close();
      await until(() => owner.state === 'failed');
      if (first) await expect(first).rejects.toMatchObject(failed);
      await expect(owner.acquire()).rejects.toMatchObject(failed);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject(failed);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('releases only after every pending lease operation settles', async () => {
    const { core, owner, advance } = await setup();
    await owner.acquire();
    const renew = gate();
    const reacquire = gate();
    core.script(RENEW, renew.promise);
    core.script(ACQUIRE, reacquire.promise);
    await advance(15_000);
    owner.notifyEvicted('lease-1');
    await until(() => core.callsOf(ACQUIRE).length === 2);
    const released = owner.release('normal_shutdown');
    reacquire.open();
    await settle();
    expect(core.callsOf(RELEASE)).toHaveLength(0);
    renew.open();
    await released;
    const methods = core.calls.map((call) => call.method);
    expect(methods).toEqual([ACQUIRE, RENEW, ACQUIRE, RELEASE]);
    expect(core.leases.size).toBe(0);
  });

  it.each(['acquire', 'renew', 'attach'] as const)(
    'fails closed on an after_refresh %s error, keeping it for the host',
    async (on) => {
      const { core, owner, errors, attach, advance } = await setup();
      // A lease code must not route it into eviction or conflict recovery.
      const refresh: CanopyErrorPayload = {
        kind: 'conflict',
        message: 'Stale lease.',
        code: 'core.client.lease.revisionConflict',
        retry: { kind: 'after_refresh', resource: 'lease', delayMs: 1_000 },
      };
      if (on !== 'attach')
        core.script(on === 'acquire' ? ACQUIRE : RENEW, refresh);
      attach.mockRejectedValueOnce(new CanopyClientError(refresh));
      const first = owner.acquire();
      if (on !== 'acquire') await first;
      if (on === 'attach') core.servers[0].close();
      await advance(on === 'renew' ? 15_000 : 0);
      await until(() => owner.state === 'failed');
      await advance(60_000);
      const methods = on === 'renew' ? [ACQUIRE, RENEW] : [ACQUIRE];
      expect(core.calls.map((call) => call.method)).toEqual(methods);
      expect(attach).toHaveBeenCalledTimes(on === 'attach' ? 1 : 0);
      expect(jest.getTimerCount()).toBe(0);
      expect(errors.map((error) => error.payload)).toEqual([refresh]);
      await owner.release('normal_shutdown');
      // Only a lease the attached connection holds is released.
      const releases = on === 'renew' ? 1 : 0;
      expect(core.callsOf(RELEASE)).toHaveLength(releases);
      const kept = { payload: refresh };
      await expect(owner.acquire()).rejects.toMatchObject(kept);
      await expect(
        first.catch((error: unknown) => error),
      ).resolves.toMatchObject(
        on === 'acquire' ? kept : { leaseId: 'lease-1' },
      );
    },
  );

  it('replays a same_request renew exactly, reading presence on the next cycle', async () => {
    const { core, owner, presence, advance } = await setup();
    await owner.acquire();
    core.script(RENEW, {
      kind: 'unavailable',
      message: 'Busy.',
      retry: { kind: 'same_request', delayMs: 2_000 },
    });
    await advance(15_000);
    presence.interactive = false;
    presence.foreground = false;
    await advance(1_999);
    expect(core.callsOf(RENEW)).toHaveLength(1);
    await advance(1);
    await advance(15_000);
    expect(core.callsOf(RENEW).map((call) => call.params)).toEqual([
      { expectedRevision: 0, interactive: true, foreground: true },
      { expectedRevision: 0, interactive: true, foreground: true },
      { expectedRevision: 1, interactive: false, foreground: false },
    ]);
  });

  const NEVER = { kind: 'never' } as const;
  const RENEW_FAILURES: Record<
    'after_refresh' | 'never' | 'presence',
    CanopyErrorPayload
  > = {
    after_refresh: {
      kind: 'conflict',
      message: 'Stale lease.',
      retry: { kind: 'after_refresh', resource: 'lease' },
    },
    never: { kind: 'internal', message: 'Broken.', retry: NEVER },
    presence: { kind: 'internal', message: 'no presence', retry: NEVER },
  };

  it.each(['after_refresh', 'never', 'presence'] as const)(
    'releases the held lease after a %s renew failure, keeping the failure',
    async (on) => {
      const { core, owner, readPresence, attach, advance } = await setup();
      await owner.acquire();
      const failure = RENEW_FAILURES[on];
      if (on !== 'presence') core.script(RENEW, failure);
      else
        readPresence.mockImplementation(() => {
          throw new Error('no presence');
        });
      await advance(15_000);
      await until(() => owner.state === 'failed');
      expect(core.callsOf(RENEW)).toHaveLength(on === 'presence' ? 0 : 1);
      await owner.release('sign_out');
      await owner.release('error');
      const reasons = core.callsOf(RELEASE).map(({ params }) => params.reason);
      expect(reasons).toEqual(['sign_out']);
      expect(core.leases.size).toBe(0);
      await expect(owner.acquire()).rejects.toMatchObject({ payload: failure });
      expect(owner.state).toBe('failed');
      expect(attach).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(['presence', 'acquire', 'conflict'] as const)(
    'releases a lease learned before a fresh acquisition that fails on %s',
    async (on) => {
      const { core, owner, readPresence, advance } = await setup();
      await owner.acquire();
      const late = gate();
      if (on === 'conflict') {
        const conflict = leaseError('revisionConflict');
        core.script(RENEW, conflict, conflict);
      } else {
        // The retained reacquire is answered after the eviction: a new lease.
        core.script(ACQUIRE, late.promise);
        core.servers[0].close();
        await until(() => core.callsOf(ACQUIRE).length === 2);
        core.evict('lease-1');
        owner.notifyEvicted('lease-1');
      }
      if (on !== 'presence') core.script(ACQUIRE, RENEW_FAILURES.never);
      else
        readPresence.mockImplementation(() => {
          throw new Error('no presence');
        });
      late.open();
      await advance(on === 'conflict' ? 15_000 : 0);
      await until(() => owner.state === 'failed');
      const held = Array.from(
        core.leases.values(),
        (lease) => lease.connection,
      );
      expect(held).toHaveLength(1);
      await owner.release('sign_out');
      const last = { method: RELEASE, connection: held[0] };
      expect(core.calls.slice(-1)).toMatchObject([last]);
      expect(core.leases.size).toBe(0);
      const kept = { payload: { kind: 'internal' } };
      await expect(owner.acquire()).rejects.toMatchObject(kept);
    },
  );

  it('abandons a retained reacquire evicted before its reply lands', async () => {
    const { core, owner, clients, issued, acquired } = await setup();
    await owner.acquire();
    const reply = gate();
    core.script(ACQUIRE, { deliver: reply.promise });
    core.servers[0].close();
    await until(() => core.callsOf(ACQUIRE).length === 2);
    expect(acquired(1)).toHaveProperty('previousLeaseId', 'lease-1');
    core.evict('lease-1');
    owner.notifyEvicted('lease-1');
    owner.notifyEvicted('lease-1');
    await settle();
    // The retained acquire resolves first; only then does one fresh one start.
    expect(core.callsOf(ACQUIRE)).toHaveLength(2);
    reply.open();
    await until(() => owner.lease?.leaseId === 'lease-2');
    owner.notifyEvicted('lease-1');
    await settle();
    expect(core.callsOf(ACQUIRE)).toHaveLength(3);
    expect(acquired(2)).not.toHaveProperty('previousLeaseId');
    expect(owner.lease?.leaseId).toBe('lease-2');
    expect(owner.client).toBe(clients[1]);
    expect(issued).toEqual(['lease-1@0', 'lease-2@1']);
  });

  const BUSY: CanopyErrorPayload = {
    kind: 'unavailable',
    message: 'Busy.',
    retry: { kind: 'same_idempotency_key', delayMs: 5_000 },
  };
  const CANCELLED = { payload: { kind: 'cancelled' } };

  it('projects every lifecycle phase and ignores events after release', async () => {
    const { core, owner, attach, issued, advance, holdAttach } = await setup();
    const renew = gate();
    const reply = gate();
    core.script(RENEW, renew.promise);
    const seen = [owner.state];
    const first = owner.acquire();
    seen.push(owner.state);
    await first;
    seen.push(owner.state);
    await advance(15_000); // renewing projects active
    seen.push(owner.state);
    const late = holdAttach();
    core.servers[0].close();
    await until(() => owner.state === 'reconnecting');
    seen.push(owner.state);
    renew.open();
    core.script(ACQUIRE, reply.promise);
    late.open();
    await until(() => core.callsOf(ACQUIRE).length === 2);
    seen.push(owner.state);
    reply.open();
    await until(() => owner.state === 'active');
    seen.push(owner.state);
    await owner.release('normal_shutdown');
    seen.push(owner.state);
    const calls = core.calls.length;
    owner.notifyEvicted('lease-1');
    owner.checkClock();
    owner.register('late', () => void issued.push('late'));
    core.servers[1].close();
    await advance(60_000);
    seen.push(owner.state);
    expect(seen).toEqual([
      ...['idle', 'acquiring', 'active', 'active', 'reconnecting'],
      ...['acquiring', 'active', 'released', 'released'],
    ]);
    expect(core.calls).toHaveLength(calls);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(issued).toEqual(['lease-1@0']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['in flight', 'in a retry delay'] as const)(
    'replays an acquire dropped %s with its exact key, binding one lease',
    async (when) => {
      const { core, owner, clients, issued, acquired } = await setup();
      const reply = gate();
      // The core commits the lease, then its reply is lost.
      const lost = when === 'in flight' ? reply.promise : undefined;
      core.script(ACQUIRE, { deliver: lost, fail: lost ? undefined : BUSY });
      const first = owner.acquire();
      await until(() => core.callsOf(ACQUIRE).length === 1);
      await settle();
      core.servers[0].close();
      await until(() => owner.state === 'active');
      reply.open();
      expect(await first).toMatchObject({ leaseId: 'lease-1' });
      expect(core.callsOf(ACQUIRE)).toHaveLength(2);
      expect(acquired(1)).toEqual(acquired(0));
      expect(Array.from(core.leases.keys())).toEqual(['lease-1']);
      expect(core.leases.get('lease-1')?.connection).toBe(1);
      expect(owner.client).toBe(clients[1]);
      expect(issued).toEqual(['lease-1@1']);
    },
  );

  it.each(['retry delay', 'held reply'] as const)(
    'releases a lease an acquire bound during its %s, never activating it',
    async (during) => {
      const { core, owner, issued, advance, acquired } = await setup();
      const reply = gate();
      const held = during === 'held reply';
      core.script(ACQUIRE, held ? { deliver: reply.promise } : { fail: BUSY });
      const first = owner.acquire();
      await until(() => core.callsOf(ACQUIRE).length === 1);
      await settle();
      const released = owner.release('sign_out');
      expect(owner.state).toBe('released');
      reply.open();
      await released;
      await advance(60_000);
      const replay = held ? [] : [ACQUIRE];
      const methods = core.calls.map((call) => call.method);
      expect(methods).toEqual([ACQUIRE, ...replay, RELEASE]);
      if (!held) expect(acquired(1)).toEqual(acquired(0));
      expect(core.leases.size).toBe(0);
      await expect(first).rejects.toMatchObject(CANCELLED);
      expect(owner.lease).toBeNull();
      expect(issued).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(['fails', 'times out'] as const)(
    'stops release cleanup when its one acquire replay %s',
    async (outcome) => {
      const { core, owner, errors, acquired } = await setup();
      const stuck = gate();
      core.script(ACQUIRE, BUSY, outcome === 'fails' ? BUSY : stuck.promise);
      const first = owner.acquire();
      await until(() => errors.length === 1);
      let done = false;
      const released = owner.release('normal_shutdown');
      void released.then(() => (done = true));
      await until(() => core.callsOf(ACQUIRE).length === 2);
      if (outcome === 'times out') {
        await jest.advanceTimersByTimeAsync(4_999);
        await settle();
        expect(done).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
      }
      await released;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(core.calls.map((call) => call.method)).toEqual([ACQUIRE, ACQUIRE]);
      expect(acquired(1)).toEqual(acquired(0));
      const stop = outcome === 'fails' ? 'unavailable' : 'deadline_exceeded';
      const kinds = errors.map((error) => error.payload.kind);
      expect(kinds).toEqual(['unavailable', stop]);
      await expect(first).rejects.toMatchObject(CANCELLED);
      expect(jest.getTimerCount()).toBe(0);
      stuck.open();
    },
  );

  it.each(['drain', 'replay'] as const)(
    'sends nothing once the release budget elapses during its %s',
    async (during) => {
      const { core, owner, errors, advance } = await setup();
      const late = gate();
      if (during === 'drain') {
        await owner.acquire();
        core.script(RENEW, late.promise);
        await advance(15_000);
      } else {
        core.script(ACQUIRE, BUSY, late.promise);
        void owner.acquire();
        await until(() => errors.length === 1);
      }
      const released = owner.release('normal_shutdown');
      await until(() => core.calls.length === 2);
      // A starved event loop: the budget elapses before its timer can run.
      const elapsed = performance.now() + 5_000;
      jest.spyOn(performance, 'now').mockReturnValue(elapsed);
      late.open();
      await released;
      expect(core.callsOf(RELEASE)).toHaveLength(0);
      const deadline = { payload: { kind: 'deadline_exceeded' } };
      expect(errors.slice(-1)).toMatchObject([deadline]);
    },
  );

  it.each([
    ['after_refresh', { kind: 'after_refresh', resource: 'lease' }],
    ['never', { kind: 'never' }],
    ['same_idempotency_key', BUSY.retry],
  ] as const)(
    'resolves a superseded retained acquire answering %s before any new key',
    async (directive, retry) => {
      const { core, owner, errors, issued, advance, acquired } = await setup();
      await owner.acquire();
      const reply = gate();
      const fail: CanopyErrorPayload = {
        kind: 'unavailable',
        message: 'Lost.',
        retry,
      };
      core.script(ACQUIRE, { deliver: reply.promise, fail });
      core.servers[0].close();
      await until(() => core.callsOf(ACQUIRE).length === 2);
      core.evict('lease-1');
      owner.notifyEvicted('lease-1');
      reply.open();
      await settle();
      expect(core.callsOf(ACQUIRE)).toHaveLength(2);
      expect(errors.map((error) => error.payload)).toEqual([fail]);
      if (directive !== 'same_idempotency_key') {
        expect(owner.state).toBe('failed');
        await owner.release('normal_shutdown');
        await advance(60_000);
        // Release replays the unresolved acquire once, never a fresh key.
        expect(core.callsOf(ACQUIRE)).toHaveLength(3);
        expect(acquired(2)).toEqual(acquired(1));
        await expect(owner.acquire()).rejects.toMatchObject({ payload: fail });
        expect(owner.state).toBe('failed');
        return;
      }
      await advance(4_999);
      expect(core.callsOf(ACQUIRE)).toHaveLength(2);
      await advance(1);
      await until(() => owner.lease?.leaseId === 'lease-2');
      expect(acquired(2)).toEqual(acquired(1));
      expect(core.callsOf(ACQUIRE)).toHaveLength(4);
      expect(acquired(3)).not.toHaveProperty('previousLeaseId');
      expect(acquired(3)._meta).not.toEqual(acquired(1)._meta);
      expect(issued).toEqual(['lease-1@0', 'lease-2@1']);
    },
  );

  it.each([
    ['never acquire', ACQUIRE, { kind: 'never' }],
    ['same_idempotency_key acquire', ACQUIRE, BUSY.retry],
    ['same_request attach', 'attach', { kind: 'same_request' }],
  ] as const)(
    'keeps a %s failure intact when onError releases',
    async (_name, on, retry) => {
      const fail: CanopyErrorPayload = { ...BUSY, retry };
      const { core, owner, attach, errors, advance, acquired } = await setup(
        (lease) => void lease.release('error'),
      );
      if (on === ACQUIRE) core.script(ACQUIRE, fail);
      attach.mockRejectedValueOnce(new CanopyClientError(fail));
      const first = owner.acquire();
      if (on === 'attach') await first.then(() => core.servers[0].close());
      await advance(60_000);
      const failed = retry.kind === 'never';
      expect(owner.state).toBe(failed ? 'failed' : 'released');
      const kept = failed ? { payload: fail } : CANCELLED;
      await expect(owner.acquire()).rejects.toMatchObject(kept);
      expect(errors[0].payload).toEqual(fail);
      // Only cleanup's one replay of the unresolved acquire, with its key.
      expect(core.callsOf(ACQUIRE)).toHaveLength(on === ACQUIRE ? 2 : 1);
      if (on === ACQUIRE) expect(acquired(1)).toEqual(acquired(0));
      expect(attach).toHaveBeenCalledTimes(on === 'attach' ? 1 : 0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});

const ignoreRejection = (): void => {};

/** A host that sees each of `client`'s acquire replies before the owner. */
function observeAcquireReplies(
  client: LeaseTestClient,
  onReply: () => void,
): void {
  const instruction = client.instruction.bind(client);
  jest
    .spyOn(client, 'instruction')
    .mockImplementation((name, params, options) => {
      const reply = instruction(name, params, options);
      if (name === ACQUIRE) void reply.then(onReply, ignoreRejection);
      return reply;
    });
}

type LeaseEvent =
  | 'acquire fulfillment'
  | 'acquire rejection'
  | 'connection drop'
  | 'reconnect'
  | 'eviction notice'
  | 'renew revision conflict'
  | 'release';
const LEASE_EVENTS: readonly LeaseEvent[] = [
  'acquire fulfillment',
  'acquire rejection',
  'connection drop',
  'reconnect',
  'eviction notice',
  'renew revision conflict',
  'release',
];
const ORDERED_PAIRS = LEASE_EVENTS.flatMap((first) =>
  LEASE_EVENTS.filter((second) => second !== first).map(
    (second): [LeaseEvent, LeaseEvent] => [first, second],
  ),
);
/** `same turn`: the second event fires before any continuation of the first. */
type Gap = 'same turn' | 'settled';
const GAPS: readonly Gap[] = ['same turn', 'settled'];
const RELEASE_BUDGET_MS = 5_000;
/** The core committed the acquire; only its reply was lost. */
const LOST_REPLY = new CanopyClientError({
  kind: 'unavailable',
  message: 'Reply lost.',
  retry: { kind: 'same_idempotency_key', delayMs: 1_000 },
});

/** An acquire reply the harness holds until an event settles it. */
type HeldReply = {
  readonly client: LeaseTestClient;
  arrived?: { readonly leaseId: string; readonly deliver: () => void };
  lost?: unknown;
  readonly fail: (error: unknown) => void;
  settled: boolean;
};

function leaseIdOf(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'leaseId' in value &&
    typeof value.leaseId === 'string'
  )
    return value.leaseId;
  throw new Error('An acquire reply carried no lease id.');
}

/** Holds `client`'s acquire replies until the schedule delivers or rejects them. */
function holdAcquireReplies(
  client: LeaseTestClient,
  replies: HeldReply[],
): void {
  const instruction = client.instruction.bind(client);
  jest
    .spyOn(client, 'instruction')
    .mockImplementation((name, params, options) => {
      const reply = instruction(name, params, options);
      if (name !== ACQUIRE) return reply;
      return new Promise((resolve, reject) => {
        const held: HeldReply = { client, fail: reject, settled: false };
        replies.push(held);
        reply.then(
          (value) => {
            const leaseId = leaseIdOf(value);
            held.arrived = { leaseId, deliver: (): void => resolve(value) };
          },
          (error: unknown) => (held.lost = error),
        );
      });
    });
}

interface Interleaving {
  /** Whether each event of the pair ran with an effect, in order. */
  readonly executed: [boolean, boolean];
  /** The same-turn run fired the second event with no turn in between. */
  readonly adjacent: boolean;
  readonly learned: readonly string[];
  /** Learned leases still held on the daemon, without an allowed exception. */
  readonly leaked: string[];
  readonly leftToEviction: {
    readonly leaseId: string;
    readonly reason: 'deadline' | 'transport_loss';
  }[];
}

/**
 * Drives one owner through `first` then `second` with controlled settlement:
 * held acquire replies, gated renews, and gated attaches. Each event first
 * reaches a state where it has an effect, through the same outside progress
 * (attach, reply, renew, timer). The owner then quiesces, releases, and
 * drains replies needed by cleanup before the learned leases are checked.
 */
async function interleave(
  first: LeaseEvent,
  second: LeaseEvent,
  gap: Gap,
  releaseCase: 'normal' | 'failed' | 'earlier' | 'exhausted' = 'normal',
): Promise<Interleaving> {
  const { core, owner, clients, errors, attach } = await setup();
  const replies: HeldReply[] = [];
  const learned = new Set<string>();
  let released: Promise<void> | null = null;
  let releaseStartedAt: number | null = null;
  let transportLostAfterRelease = false;
  let done = false;
  const hold = (client: LeaseTestClient): void => {
    holdAcquireReplies(client, replies);
    client.signal.addEventListener(
      'abort',
      () => {
        if (
          released !== null &&
          !done &&
          clients.every((connection) => connection.signal.aborted)
        )
          transportLostAfterRelease = true;
      },
      { once: true },
    );
  };
  hold(clients[0]);
  if (releaseCase === 'earlier')
    await clients[0].instruction(RELEASE, { reason: 'normal_shutdown' });
  if (releaseCase === 'failed' || releaseCase === 'earlier')
    core.script(
      RELEASE,
      ...Array.from({ length: 16 }, () => leaseError('invalidState')),
    );
  const attaches: { readonly gate: Gate; opened: boolean }[] = [];
  attach.mockImplementation(async () => {
    const pending = { gate: gate(), opened: false };
    attaches.push(pending);
    await pending.gate.promise;
    const client = await core.connect();
    clients.push(client);
    hold(client);
    return client;
  });
  const renews = Array.from({ length: 16 }, gate);
  core.script(RENEW, ...renews.map((held) => held.promise));
  const openedRenews = new Set<number>();

  const unsettled = (): HeldReply[] => replies.filter((r) => !r.settled);
  /** Prefers the reply the owner's current connection is waiting for. */
  const pick = (from: HeldReply[]): HeldReply | undefined =>
    from.find((reply) => reply.client === owner.client) ?? from[0];
  const boundTo = (connection: number): ReturnType<typeof core.leases.get> =>
    Array.from(core.leases.values()).find(
      (held) => held.connection === connection,
    );
  const renewIndex = (conflictable: boolean): number =>
    core
      .callsOf(RENEW)
      .findIndex(
        ({ connection }, index) =>
          !openedRenews.has(index) &&
          (!conflictable ||
            (boundTo(connection) !== undefined &&
              !clients[connection].signal.aborted)),
      );
  const evictable = (): string | undefined => {
    const live = owner.lease?.leaseId;
    if (live !== undefined && core.leases.has(live)) return live;
    return Array.from(learned)
      .reverse()
      .find((leaseId) => core.leases.has(leaseId));
  };
  const deliver = (reply: HeldReply): void => {
    reply.settled = true;
    if (!reply.arrived) return reply.fail(reply.lost ?? LOST_REPLY);
    learned.add(reply.arrived.leaseId);
    reply.arrived.deliver();
  };
  const openAttach = (): void => {
    const pending = attaches.find((candidate) => !candidate.opened);
    if (!pending) throw new Error('No attach is waiting.');
    pending.opened = true;
    pending.gate.open();
  };
  const openRenew = (index: number): void => {
    openedRenews.add(index);
    renews[index].open();
  };

  const available: Record<LeaseEvent, () => boolean> = {
    'acquire fulfillment': () => unsettled().some((reply) => reply.arrived),
    'acquire rejection': () => unsettled().length > 0,
    'connection drop': () => !owner.client.signal.aborted,
    reconnect: () => attaches.some((pending) => !pending.opened),
    'eviction notice': () => evictable() !== undefined,
    'renew revision conflict': () => renewIndex(true) >= 0,
    release: () => released === null,
  };
  const fire: Record<LeaseEvent, () => void> = {
    'acquire fulfillment': () => {
      const reply = pick(unsettled().filter((r) => r.arrived));
      if (!reply) throw new Error('No acquire reply has arrived.');
      deliver(reply);
    },
    'acquire rejection': () => {
      const reply = pick(unsettled());
      if (!reply) throw new Error('No acquire reply is held.');
      reply.settled = true;
      reply.fail(LOST_REPLY);
    },
    'connection drop': () => void owner.client.close(),
    reconnect: openAttach,
    'eviction notice': () => {
      const leaseId = evictable();
      if (leaseId === undefined) throw new Error('No learned lease is held.');
      core.evict(leaseId);
      owner.notifyEvicted(leaseId);
    },
    'renew revision conflict': () => {
      const index = renewIndex(true);
      const held = boundTo(core.callsOf(RENEW)[index].connection);
      if (!held) throw new Error('No renew is waiting on a held lease.');
      // Another writer moved the revision: a genuine conflict, not a lost reply.
      held.revision += 1;
      openRenew(index);
    },
    release: () => {
      releaseStartedAt = performance.now();
      released = owner.release('normal_shutdown');
      if (releaseCase === 'exhausted')
        jest
          .spyOn(performance, 'now')
          .mockReturnValue(performance.now() + RELEASE_BUDGET_MS);
      void released.then(() => (done = true));
    },
  };

  /** One unit of outside progress; false when nothing is waiting on it. */
  const progress = async (): Promise<boolean> => {
    const reply = pick(unsettled());
    const renew = renewIndex(false);
    const recovering =
      owner.state === 'acquiring' || owner.state === 'reconnecting';
    if (attaches.some((pending) => !pending.opened)) openAttach();
    else if (reply) deliver(reply);
    else if (renew >= 0) openRenew(renew);
    // Retry delays only; renew timers and the release budget stay put.
    else if (released === null && recovering && jest.getTimerCount() > 0)
      await jest.advanceTimersToNextTimerAsync();
    else return false;
    await settle();
    return true;
  };
  const dropForReacquire = async (): Promise<boolean> => {
    if (released !== null || owner.client.signal.aborted) return false;
    void owner.client.close();
    await settle();
    return true;
  };
  const unblock: Record<LeaseEvent, () => Promise<boolean>> = {
    'acquire fulfillment': async () =>
      (await progress()) ||
      (owner.state === 'active' && (await dropForReacquire())),
    'acquire rejection': async () =>
      (await progress()) ||
      (owner.state === 'active' && (await dropForReacquire())),
    'connection drop': progress,
    reconnect: async () => (await dropForReacquire()) || (await progress()),
    'eviction notice': progress,
    'renew revision conflict': async () => {
      if (renewIndex(false) < 0 && released === null && owner.lease) {
        await jest.advanceTimersByTimeAsync(core.renewAfterMs);
        await settle();
        return true;
      }
      return progress();
    },
    release: () => Promise.resolve(false),
  };
  const prepare = async (event: LeaseEvent): Promise<boolean> => {
    for (let step = 0; step < 16 && !available[event](); step += 1)
      if (!(await unblock[event]())) break;
    return available[event]();
  };

  void owner.acquire().catch(ignoreRejection);
  await settle();
  // Readies the second event first, so a release cannot strand it.
  await prepare(second);
  // An eviction after release has an effect only while cleanup still drains.
  if (first === 'release' && second === 'eviction notice')
    await prepare('renew revision conflict');
  const firstRan = await prepare(first);
  if (firstRan) fire[first]();
  const adjacent = gap === 'same turn' && available[second]();
  if (!adjacent) await settle();
  const secondRan = adjacent || (await prepare(second));
  if (secondRan) fire[second]();
  await settle();

  for (let step = 0; step < 32 && released === null; step += 1)
    if (!(await progress())) break;
  if (released === null) fire.release();
  await settle();
  for (let step = 0; step < 32 && !done; step += 1)
    if (!(await progress())) break;
  if (!done) {
    await jest.advanceTimersByTimeAsync(RELEASE_BUDGET_MS);
    await settle();
  }
  // Idempotent: the same cleanup the release event started.
  await owner.release('normal_shutdown');
  expect(clients).toHaveLength(core.servers.length);

  const deadline = errors.some(
    (error) => error.payload.kind === 'deadline_exceeded',
  );
  if (deadline) {
    expect(releaseStartedAt).not.toBeNull();
    expect(
      performance.now() - (releaseStartedAt ?? performance.now()),
    ).toBeGreaterThanOrEqual(RELEASE_BUDGET_MS);
  }
  const leaked: string[] = [];
  const leftToEviction: Interleaving['leftToEviction'] = [];
  for (const leaseId of Array.from(learned)) {
    const held = core.leases.get(leaseId);
    if (held === undefined) continue;
    if (deadline) leftToEviction.push({ leaseId, reason: 'deadline' });
    else if (
      transportLostAfterRelease &&
      clients[held.connection].signal.aborted
    )
      leftToEviction.push({ leaseId, reason: 'transport_loss' });
    else leaked.push(leaseId);
  }
  return {
    executed: [firstRan, secondRan],
    adjacent,
    learned: Array.from(learned),
    leaked,
    leftToEviction,
  };
}

describe('createCanopyClientLease learned-lease ownership', () => {
  it.each(['failed', 'earlier'] as const)(
    'detects a daemon-held lease despite a %s RELEASE invocation',
    async (releaseCase) => {
      const run = await interleave(
        'acquire fulfillment',
        'release',
        'settled',
        releaseCase,
      );
      expect(run.executed).toEqual([true, true]);
      expect(run.leftToEviction).toEqual([]);
      expect(run.leaked).toEqual(['lease-1']);
    },
  );
  it('leaves a daemon-held learned lease to eviction when the release budget is exhausted', async () => {
    const run = await interleave(
      'acquire fulfillment',
      'release',
      'settled',
      'exhausted',
    );
    expect(run.executed).toEqual([true, true]);
    expect(run.leaked).toEqual([]);
    expect(run.leftToEviction).toEqual([
      { leaseId: 'lease-1', reason: 'deadline' },
    ]);
  });
  it.each(['complete', 'exhausted'] as const)(
    'cleans up distinct learned leases with a %s release budget',
    async (budget) => {
      const { core, owner, clients, attach, holdAttach, acquired } =
        await setup();
      const host = clients[0];
      observeAcquireReplies(host, () => void host.close());
      const late = holdAttach();
      const first = owner.acquire();
      await until(() => attach.mock.calls.length === 1);
      await settle();
      await jest.advanceTimersByTimeAsync(10_001);
      late.open();
      await until(() => owner.state === 'active');
      await first;
      expect(owner.lease?.leaseId).toBe('lease-2');
      expect(Array.from(core.leases.keys())).toEqual(['lease-1', 'lease-2']);
      if (budget === 'exhausted') {
        const current = owner.client;
        const instruction = current.instruction.bind(current);
        jest
          .spyOn(current, 'instruction')
          .mockImplementation((name, params, options) => {
            const reply = instruction(name, params, options);
            if (name === RELEASE)
              void reply.then(() => {
                // The first release uses the remaining budget before its continuation.
                jest
                  .spyOn(performance, 'now')
                  .mockReturnValue(performance.now() + RELEASE_BUDGET_MS);
              }, ignoreRejection);
            return reply;
          });
      }
      await owner.release('sign_out');
      if (budget === 'exhausted') {
        expect(core.callsOf(RELEASE)).toHaveLength(1);
        expect(core.callsOf(ACQUIRE)).toHaveLength(2);
        expect(Array.from(core.leases.keys())).toEqual(['lease-1']);
        core.evict('lease-1');
      } else {
        expect(core.callsOf(RELEASE)).toHaveLength(2);
        expect(core.callsOf(ACQUIRE)).toHaveLength(3);
        expect(acquired(2)).toEqual(acquired(0));
        expect(Array.from(core.leases.keys())).toEqual([]);
      }
    },
  );

  it('releases a lease a stale acquire learned after the host closed its connection', async () => {
    const { core, owner, clients, attach, holdAttach } = await setup();
    const host = clients[0];
    // The host's observer runs before the owner's continuation of the reply.
    observeAcquireReplies(host, () => void host.close());
    const late = holdAttach();
    const first = owner.acquire();
    await until(() => attach.mock.calls.length === 1);
    await settle();
    expect(owner.state).toBe('reconnecting');
    expect(Array.from(core.leases.keys())).toEqual(['lease-1']);
    late.open();
    await until(() => owner.state === 'active');
    await first;
    await owner.release('normal_shutdown');
    expect(Array.from(core.leases.keys())).toEqual([]);
  });

  it('accounts for every ordered pair of the seven lifecycle events', () => {
    const keys = ORDERED_PAIRS.map((pair) => pair.join(' -> '));
    expect(new Set(keys).size).toBe(LEASE_EVENTS.length ** 2 - 7);
    for (const event of LEASE_EVENTS) {
      expect(ORDERED_PAIRS.filter(([first]) => first === event)).toHaveLength(
        6,
      );
      expect(
        ORDERED_PAIRS.filter(([, second]) => second === event),
      ).toHaveLength(6);
    }
  });

  it.each(ORDERED_PAIRS)(
    'leaves no learned lease held when %s precedes %s',
    async (first, second) => {
      const runs: (Interleaving & { gap: Gap })[] = [];
      for (const gap of GAPS)
        runs.push({ gap, ...(await interleave(first, second, gap)) });
      // Coverage: both events took effect, in order, in every gap.
      // Release can fence acquisition before the owner learns any reply.
      const noLearnedReply =
        (first === 'connection drop' && second === 'release') ||
        (first === 'release' && second === 'reconnect');
      const sameTurnFenced = first === 'reconnect' && second === 'release';
      expect(runs.map(({ learned }) => learned.length > 0)).toEqual(
        GAPS.map(
          (gap) => !(noLearnedReply || (sameTurnFenced && gap === 'same turn')),
        ),
      );
      expect(runs.map(({ gap, executed }) => ({ gap, executed }))).toEqual(
        GAPS.map((gap) => ({ gap, executed: [true, true] })),
      );
      // Every write settles within budget; only release -> drop loses its last transport.
      const expectedEviction =
        first === 'release' && second === 'connection drop'
          ? [{ leaseId: 'lease-1', reason: 'transport_loss' }]
          : [];
      expect(
        runs.map(({ gap, leftToEviction }) => ({ gap, leftToEviction })),
      ).toEqual(GAPS.map((gap) => ({ gap, leftToEviction: expectedEviction })));
      expect(runs.map(({ gap, leaked }) => ({ gap, leaked }))).toEqual(
        GAPS.map((gap) => ({ gap, leaked: [] })),
      );
      if (first === 'acquire fulfillment' && second === 'connection drop')
        expect(runs[0].adjacent).toBe(true);
    },
  );
});
