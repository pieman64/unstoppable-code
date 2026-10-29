import {
  type CanopyClientError,
  createCanopyClientLease,
  type CanopyClientLease,
} from '../../index';
import { FakeLeaseCore, type LeaseTestClient } from './lease-core';

export const ACQUIRE = 'core.client.lease.acquire';
export const RENEW = 'core.client.lease.renew';
export const RELEASE = 'core.client.lease.release';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  jest.useRealTimers();
});

export type Gate = { promise: Promise<void>; open: () => void };
export function gate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** Real I/O turns until `ready` holds (asserted), or 50 turns without one. */
export async function until(ready?: () => boolean): Promise<void> {
  for (let turn = 0; turn < (ready ? 200 : 50) && !ready?.(); turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
  if (ready) expect(ready()).toBe(true);
}
export const settle = (): Promise<void> => until();

export interface Harness {
  core: FakeLeaseCore;
  owner: CanopyClientLease<LeaseTestClient>;
  clients: LeaseTestClient[];
  errors: CanopyClientError[];
  presence: { interactive: boolean; foreground: boolean };
  readPresence: jest.Mock<Harness['presence'], []>;
  issued: string[];
  attach: jest.Mock<Promise<LeaseTestClient>, []>;
  advance: (ms: number) => Promise<void>;
  /** Holds the next attach until the returned gate opens. */
  holdAttach: () => Gate;
  acquired: (index: number) => Record<string, unknown>;
}

/** Runs inside the owner's `onError`, after the error is recorded. */
export type OnError = (owner: Harness['owner']) => void;
export async function setup(onError?: OnError): Promise<Harness> {
  const core = new FakeLeaseCore();
  const clients = [await core.connect()];
  const errors: CanopyClientError[] = [];
  const presence = { interactive: true, foreground: true };
  const readPresence = jest.fn(() => presence);
  let attachGate = Promise.resolve();
  const attach = jest.fn(async () => {
    await attachGate;
    const client = await core.connect();
    clients.push(client);
    return client;
  });
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask'],
  });
  const owner = createCanopyClientLease({
    client: clients[0],
    attach,
    identity: { clientInstanceId: 'c-1', interfaceKind: 'test', label: 'Test' },
    renewalIntervalMs: 15_000,
    presence: readPresence,
    onError: (error) => {
      errors.push(error);
      onError?.(owner);
    },
  });
  const issued: string[] = [];
  owner.register('tools', (lease, client) => {
    issued.push(`${lease.leaseId}@${clients.indexOf(client)}`);
  });
  cleanups.push(async () => {
    await owner.release('normal_shutdown');
    await Promise.all(clients.map((client) => client.close()));
  });
  const advance = async (ms: number): Promise<void> => {
    await jest.advanceTimersByTimeAsync(ms);
    await settle();
  };
  const holdAttach = (): Gate => {
    const held = gate();
    attachGate = held.promise;
    return held;
  };
  const acquired = (index: number): Record<string, unknown> =>
    core.callsOf(ACQUIRE)[index].params;
  const helpers = { advance, holdAttach, acquired };
  return {
    ...{ core, owner, clients, errors, presence, readPresence, issued, attach },
    ...helpers,
  };
}

export { FakeLeaseCore, leaseError } from './lease-core';
export type { LeaseTestClient } from './lease-core';

export const CANCELLED = { payload: { kind: 'cancelled' } };
