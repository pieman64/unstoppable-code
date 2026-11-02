import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';

import { CANOPY_CONNECTION_DEFAULTS, CanopyClientError } from '../index';
import {
  ACQUIRE,
  RENEW,
  setup,
  until,
  type LeaseTestClient,
} from './fixtures/lease-regression-harness';

const DOWN = new CanopyClientError({
  kind: 'unavailable',
  message: 'No core accepted the connection.',
  retry: { kind: 'same_request' },
});

describe('client lease delivery policy', () => {
  it('backs off reconnects and fails once the delivery deadline passes', async () => {
    const { core, owner, attach, errors, advance } = await setup();
    await owner.acquire();
    const began = performance.now();
    const tries: number[] = [];
    attach.mockImplementation(() => {
      tries.push(performance.now() - began);
      return Promise.reject(DOWN);
    });
    core.servers[0].close();
    await until(() => owner.state === 'reconnecting');
    await advance(CANOPY_CONNECTION_DEFAULTS.deliveryTimeoutMs);
    expect(owner.state).toBe('failed');
    // Was a fixed 1 s retry with no bound.
    expect(tries).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000]);
    expect(errors.map((error) => error.payload.kind)).toEqual([
      ...Array<string>(5).fill('unavailable'),
      'deadline_exceeded',
    ]);
    await advance(60_000);
    expect(attach).toHaveBeenCalledTimes(6);
    expect(jest.getTimerCount()).toBe(0);
    await expect(owner.acquire()).rejects.toMatchObject({
      payload: { kind: 'deadline_exceeded', retry: { kind: 'same_request' } },
    });
  });

  it('closes a replacement that dropped before use and backs off', async () => {
    const { core, owner, attach, clients, advance } = await setup();
    await owner.acquire();
    const dead = await core.connect();
    await dead.close();
    attach.mockResolvedValueOnce(dead).mockResolvedValueOnce(dead);
    core.servers[0].close();
    await until(() => attach.mock.calls.length === 1);
    await advance(999);
    expect(attach).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(attach).toHaveBeenCalledTimes(2);
    await advance(1_999);
    expect(attach).toHaveBeenCalledTimes(2);
    await advance(1);
    await until(() => owner.state === 'active');
    expect(owner.client).toBe(clients.at(-1));
    expect(core.callsOf(ACQUIRE).at(-1)?.params).toMatchObject({
      previousLeaseId: 'lease-1',
    });
  });

  it('bounds a nested attach by the remaining time and aborts it on release', async () => {
    const { core, owner, attach } = await setup();
    await owner.acquire();
    let attempt: { signal: AbortSignal; remaining: number } | undefined;
    attach.mockImplementationOnce((given) => {
      attempt = { signal: given.signal, remaining: given.remainingMs() };
      return new Promise(() => {});
    });
    core.servers[0].close();
    await until(() => attempt !== undefined);
    expect(attempt?.remaining).toBe(
      CANOPY_CONNECTION_DEFAULTS.deliveryTimeoutMs,
    );
    expect(attempt?.signal.aborted).toBe(false);
    await owner.release('normal_shutdown');
    expect(attempt?.signal.aborted).toBe(true);
    await until();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds renew replays by deliveryTimeoutMs', async () => {
    const { core, owner, errors, advance } = await setup();
    await owner.acquire();
    const busy: CanopyErrorPayload = {
      kind: 'unavailable',
      message: 'Busy.',
      retry: { kind: 'same_request' },
    };
    core.script(RENEW, ...Array.from({ length: 10 }, () => busy));
    await advance(15_000);
    await advance(CANOPY_CONNECTION_DEFAULTS.deliveryTimeoutMs);
    expect(owner.state).toBe('failed');
    expect(core.callsOf(RENEW)).toHaveLength(6);
    expect(errors.at(-1)?.payload.kind).toBe('deadline_exceeded');
  });
});

describe('client lease reconnect adoption', () => {
  /** A replacement whose first `signal` read schedules its drop: after the attach check, before adoption. */
  function dropsAfterCheck(
    client: LeaseTestClient,
    onDrop: () => void,
  ): LeaseTestClient {
    let read = false;
    return new Proxy(client, {
      get(target, key): unknown {
        if (key === 'signal') {
          if (!read) queueMicrotask(onDrop);
          read = true;
          return target.signal;
        }
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown =>
          Reflect.apply(value, target, args);
      },
    });
  }

  it('reconnects again when the replacement drops before it is adopted', async () => {
    const { core, owner, attach, clients } = await setup();
    await owner.acquire();
    let replacement: LeaseTestClient | undefined;
    attach.mockImplementationOnce(async () => {
      const client = await core.connect();
      clients.push(client);
      replacement = dropsAfterCheck(client, () => void client.close());
      return replacement;
    });
    core.servers[0].close();
    await until(() => attach.mock.calls.length === 2);
    await until(() => owner.state === 'active');
    expect(owner.client).not.toBe(replacement);
    expect(owner.client).toBe(clients.at(-1));
  });

  it('closes a replacement attached as the owner is released', async () => {
    const { core, owner, attach, clients } = await setup();
    await owner.acquire();
    let closed = false;
    attach.mockImplementationOnce(async () => {
      const client = await core.connect();
      clients.push(client);
      client.signal.addEventListener('abort', () => (closed = true));
      return dropsAfterCheck(client, () => void owner.release('sign_out'));
    });
    core.servers[0].close();
    await until(() => closed);
    expect(owner.state).toBe('released');
    expect(owner.client).toBe(clients[0]);
  });
});

describe('client lease reply adoption', () => {
  const DEPTHS = Array.from({ length: 12 }, (_, turns) => turns);

  /** Runs `fn` `turns` microtasks from now. */
  function later(turns: number, fn: () => void): void {
    if (turns === 0) fn();
    else queueMicrotask(() => later(turns - 1, fn));
  }

  /** Runs `onReply` `turns` microtasks after each `method` reply arrives. */
  function afterReply(
    client: LeaseTestClient,
    method: string,
    turns: number,
    onReply: () => void,
  ): LeaseTestClient {
    return new Proxy(client, {
      get(target, key): unknown {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);
          if (key !== 'instruction' || args[0] !== method) return result;
          if (!(result instanceof Promise)) return result;
          return result.then((reply: unknown) => {
            later(turns, onReply);
            return reply;
          });
        };
      },
    });
  }

  it.each(DEPTHS)(
    'reconnects when the connection drops %i turns after an acquire reply',
    async (turns) => {
      const { core, owner, attach, clients } = await setup();
      await owner.acquire();
      attach.mockImplementationOnce(async () => {
        const client = await core.connect();
        clients.push(client);
        return afterReply(client, ACQUIRE, turns, () => void client.close());
      });
      core.servers[0].close();
      await until(() => attach.mock.calls.length === 2);
      await until(() => owner.state === 'active');
      expect(owner.client).toBe(clients.at(-1));
      expect(owner.client.signal.aborted).toBe(false);
    },
  );

  it.each(DEPTHS)(
    'acquires fresh when the lease is evicted %i turns after a renew reply',
    async (turns) => {
      const { core, owner, attach, clients, advance } = await setup();
      await owner.acquire();
      attach.mockImplementationOnce(async () => {
        const client = await core.connect();
        clients.push(client);
        return afterReply(client, RENEW, turns, () =>
          owner.notifyEvicted('lease-1'),
        );
      });
      core.servers[0].close();
      await until(() => owner.state === 'active');
      expect(owner.lease?.leaseId).toBe('lease-1');
      await advance(15_000);
      await until(() => owner.lease?.leaseId === 'lease-2');
      await advance(0);
      expect(owner.lease?.leaseId).toBe('lease-2');
      expect(owner.state).toBe('active');
    },
  );
});

describe('client lease attach attempt signal', () => {
  it('keeps a replacement open when its attach ties it to the attempt signal', async () => {
    const { core, owner, attach, clients } = await setup();
    await owner.acquire();
    attach.mockImplementationOnce(async ({ signal }) => {
      const client = await core.connect();
      clients.push(client);
      signal.addEventListener('abort', () => void client.close());
      return client;
    });
    core.servers[0].close();
    await until(() => owner.state === 'active');
    await until();
    expect(owner.client).toBe(clients[1]);
    expect(owner.client.signal.aborted).toBe(false);
    expect(attach).toHaveBeenCalledTimes(1);
  });
});
