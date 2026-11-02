import type { CanopyClient, DomainEventMap } from '@canopy/app-core';
import type { ManagedDelegationLifetimeStatus } from '@canopy/protocol/delegation';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
} from '../../create-client-store';
import {
  createLifetimeLimitStore,
  lifetimeLimitTargetKey,
} from '../lifetime-limit-store';

const target = { projectId: 'project', worktreeId: 'worktree' };
const other = { projectId: 'project', worktreeId: 'other' };
const full: ManagedDelegationLifetimeStatus = {
  kind: 'available',
  occupied: 512,
  retained: 511,
  limit: 512,
  cap: 1024,
  atLimit: true,
  canExtend: true,
  atCap: false,
  refusedChatIds: ['refused'],
};
const available: ManagedDelegationLifetimeStatus = {
  kind: 'available',
  occupied: 512,
  retained: 512,
  limit: 1024,
  cap: 1024,
  atLimit: false,
  canExtend: false,
  atCap: true,
  refusedChatIds: [],
};

function setup(): {
  client: CanopyClient;
  query: jest.Mock;
  command: jest.Mock;
  subscribed: string[];
  unsubscribed: string[];
  emit: (
    name: 'delegation.lifetimeChanged',
    event: DomainEventMap['delegation.lifetimeChanged'],
  ) => void;
  store: ReturnType<typeof createLifetimeLimitStore>;
} {
  const query = jest.fn();
  const command = jest.fn();
  const subscribe = jest.fn();
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  const listeners = new Set<
    (event: DomainEventMap['delegation.lifetimeChanged']) => void
  >();
  subscribe.mockImplementation(
    (
      name: string,
      handler: (event: DomainEventMap['delegation.lifetimeChanged']) => void,
    ): (() => void) => {
      subscribed.push(name);
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
        unsubscribed.push(name);
      };
    },
  );
  const client: CanopyClient = {
    capabilities: {
      localExecution: false,
      terminalPty: false,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'api-keys-only',
      pipelines: 'crud-only',
      routing: 'url',
      overviewNotifications: false,
      delegationLifetimeStatusReads: true,
      delegationLifetimeLimitExtension: true,
    },
    query,
    command,
    subscribe,
  };
  const store = createLifetimeLimitStore(client);
  store[CLIENT_STORE_ACTIVATE]?.();
  const emit = (
    _name: 'delegation.lifetimeChanged',
    event: DomainEventMap['delegation.lifetimeChanged'],
  ): void => {
    listeners.forEach((handler) => handler(event));
  };
  return { client, query, command, subscribed, unsubscribed, emit, store };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('lifetime limit store', () => {
  test('deduplicates consumers and one subscription, preserves reservation-based fullness', async () => {
    const { store, query, subscribed } = setup();
    query.mockResolvedValue(full);
    await Promise.all([
      store.getState().load(target),
      store.getState().load(target),
    ]);
    expect(
      store.getState().entries[lifetimeLimitTargetKey(target)]?.status,
    ).toEqual(full);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('delegation.lifetimeStatus', target);
    expect(subscribed).toEqual(['delegation.lifetimeChanged']);
    store[CLIENT_STORE_ACTIVATE]?.();
    expect(subscribed).toHaveLength(1);
  });

  test('coalesces dirty events per target and leaves another worktree alone', async () => {
    const { store, query, emit } = setup();
    query.mockResolvedValue(full);
    await store.getState().load(target);
    await store.getState().load(other);
    query.mockResolvedValue(available);
    emit('delegation.lifetimeChanged', {
      ...target,
      occurredAt: '2026-10-22T00:00:01.000Z',
    });
    emit('delegation.lifetimeChanged', {
      ...target,
      occurredAt: '2026-10-22T00:00:02.000Z',
    });
    await flush();
    expect(query).toHaveBeenCalledTimes(3);
    expect(
      store.getState().entries[lifetimeLimitTargetKey(target)]?.status,
    ).toEqual(available);
    expect(
      store.getState().entries[lifetimeLimitTargetKey(other)]?.status,
    ).toEqual(full);
  });

  test('fences an older full response after a newer refresh clears capacity', async () => {
    const { store, query, emit } = setup();
    const old = deferred<ManagedDelegationLifetimeStatus>();
    query.mockReturnValueOnce(old.promise).mockResolvedValue(available);
    const initial = store.getState().load(target);
    emit('delegation.lifetimeChanged', {
      ...target,
      occurredAt: '2026-10-22T00:00:01.000Z',
    });
    await flush();
    old.resolve(full);
    await initial;
    expect(
      store.getState().entries[lifetimeLimitTargetKey(target)]?.status,
    ).toEqual(available);
  });

  test('deduplicates pending extension then confirms by refreshing', async () => {
    const { store, query, command } = setup();
    query.mockResolvedValue(full);
    await store.getState().load(target);
    const result = deferred<{
      ok: true;
      baseline: number;
      effectiveLimit: number;
      retained: number;
    }>();
    command.mockReturnValue(result.promise);
    const first = store.getState().extend(target);
    await store.getState().extend(target);
    expect(
      store.getState().entries[lifetimeLimitTargetKey(target)]?.extension,
    ).toBe('pending');
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(
      'delegation.extendLifetimeLimit',
      target,
    );
    query.mockResolvedValue(available);
    result.resolve({
      ok: true,
      baseline: 512,
      effectiveLimit: 1024,
      retained: 512,
    });
    await first;
    expect(
      store.getState().entries[lifetimeLimitTargetKey(target)]?.status,
    ).toEqual(available);
    expect(
      store.getState().entries[lifetimeLimitTargetKey(target)]?.extension,
    ).toBe('idle');
    expect(query).toHaveBeenCalledTimes(2);
  });

  test.each([
    [{ ok: false, reason: 'no_increase' }, 'failed'],
    [{ ok: false, reason: 'unavailable' }, 'uncertain'],
  ])(
    'preserves the status after an unsuccessful extension %j',
    async (result, expected) => {
      const { store, query, command } = setup();
      query.mockResolvedValue(full);
      command.mockResolvedValue(result);
      await store.getState().load(target);
      await store.getState().extend(target);
      expect(
        store.getState().entries[lifetimeLimitTargetKey(target)]?.status,
      ).toEqual(full);
      expect(
        store.getState().entries[lifetimeLimitTargetKey(target)]?.extension,
      ).toBe(expected);
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  test('transport failure is uncertain, not a confirmed extension', async () => {
    const { store, query, command } = setup();
    query.mockResolvedValue(full);
    command.mockRejectedValue(new Error('transport'));
    await store.getState().load(target);
    await store.getState().extend(target);
    expect(
      store.getState().entries[lifetimeLimitTargetKey(target)]?.extension,
    ).toBe('uncertain');
    expect(
      store.getState().entries[lifetimeLimitTargetKey(target)]?.status,
    ).toEqual(full);
  });

  test('failed refresh replaces stale fullness with a typed read error', async () => {
    const { store, query, emit } = setup();
    query.mockResolvedValueOnce(full).mockRejectedValue(new Error('read'));
    await store.getState().load(target);
    emit('delegation.lifetimeChanged', {
      ...target,
      occurredAt: '2026-10-22T00:00:01.000Z',
    });
    await flush();
    expect(
      store.getState().entries[lifetimeLimitTargetKey(target)]?.status,
    ).toEqual({ kind: 'error', reason: 'read_failed' });
  });

  test('dispose releases the subscription and fences in-flight reads', async () => {
    const { store, query, unsubscribed, emit } = setup();
    const pending = deferred<ManagedDelegationLifetimeStatus>();
    query.mockReturnValue(pending.promise);
    const initial = store.getState().load(target);
    store[CLIENT_STORE_DISPOSE]?.();
    pending.resolve(full);
    await initial;
    emit('delegation.lifetimeChanged', {
      ...target,
      occurredAt: '2026-10-22T00:00:01.000Z',
    });
    await flush();
    expect(unsubscribed).toEqual(['delegation.lifetimeChanged']);
    expect(
      store.getState().entries[lifetimeLimitTargetKey(target)]?.status,
    ).not.toEqual(full);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
