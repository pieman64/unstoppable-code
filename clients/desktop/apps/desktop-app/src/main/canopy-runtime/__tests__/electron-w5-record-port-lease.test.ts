// GB4 (CAN-5542) PR 1: the W5 record-port lease's background service
// consumer, GA3's latch and fallback note, and its refusals before contact.
import { createElectronDaemonHealth } from '../electron-daemon-health';

const mockHealth = createElectronDaemonHealth({
  warn: () => undefined,
  info: () => undefined,
});
const mockGet = jest.fn();
const mockFilesContext = jest.fn();
jest.mock('../electron-daemon-health', () => ({
  ...jest.requireActual<object>('../electron-daemon-health'),
  getElectronDaemonHealth: (): typeof mockHealth => mockHealth,
}));
jest.mock('../electron-daemon-access', () => ({
  getElectronDaemonConnections: (): object => ({ get: mockGet }),
  getElectronDaemonFilesContext: (): unknown => mockFilesContext(),
}));

import { markUnreachable } from '../electron-daemon-connection';
import { leaseElectronW5RecordPort } from '../electron-w5-record-port';

afterEach(() => {
  mockGet.mockReset();
  mockFilesContext.mockReset();
  // Every lease is closed, so the record is back to `ok` and unlatched.
  expect(mockHealth.getStatus().state).toBe('ok');
  expect(mockHealth.isLatched()).toBe(false);
});

it('enables the workspace_records consumer while leased, once per close', () => {
  const setConsumerEnabled = jest.spyOn(mockHealth, 'setConsumerEnabled');
  const lease = leaseElectronW5RecordPort();
  expect(setConsumerEnabled.mock.calls).toEqual([['workspace_records', true]]);
  // An enabled consumer shows an unreachable connection.
  mockHealth.observe({ kind: 'unreachable', reason: 'start_failed' });
  expect(mockHealth.getStatus()).toMatchObject({
    state: 'unavailable',
    reason: 'start_failed',
  });
  lease.close();
  lease.close();
  expect(setConsumerEnabled.mock.calls).toEqual([
    ['workspace_records', true],
    ['workspace_records', false],
  ]);
  expect(mockHealth.getStatus().state).toBe('ok');
  setConsumerEnabled.mockRestore();
});

it('keeps the consumer enabled until the last open lease closes', () => {
  const setConsumerEnabled = jest.spyOn(mockHealth, 'setConsumerEnabled');
  const first = leaseElectronW5RecordPort();
  const second = leaseElectronW5RecordPort();
  first.close();
  expect(setConsumerEnabled).not.toHaveBeenCalledWith(
    'workspace_records',
    false,
  );
  second.close();
  expect(setConsumerEnabled).toHaveBeenLastCalledWith(
    'workspace_records',
    false,
  );
  setConsumerEnabled.mockRestore();
});

/** A session whose client getter throws `failure`, as GA3's cached session does. */
function sessionThrowing(failure: unknown): object {
  return {
    get client(): never {
      throw failure;
    },
    lease: { state: 'reconnecting' },
  };
}

async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => undefined,
    (error: unknown) => error,
  );
}

it('refuses as lost, with the notice hidden, while the lease replaces a dropped client', async () => {
  mockFilesContext.mockResolvedValue({ authorityId: 'authority' });
  const failure = markUnreachable(
    new Error('Authority authority is disconnected.'),
    'connection_lost',
  );
  mockGet.mockResolvedValue(sessionThrowing(failure));
  const lease = leaseElectronW5RecordPort();
  mockHealth.observe({ kind: 'lost' });
  expect(await rejectionOf(lease.transport.recovery())).toMatchObject({
    name: 'W5AuthorityUnreachableError',
    certainty: 'refused',
    reason: 'lost',
    cause: failure,
  });
  // A restart is never shown and never latches (Mike, q-13 GA3-1).
  expect(mockHealth.getStatus().state).toBe('reconnecting');
  expect(mockHealth.isLatched()).toBe(false);
  expect(mockGet).toHaveBeenCalledTimes(1);
  // The lease giving up shows the notice, and later calls are held.
  mockHealth.observe({ kind: 'unreachable', reason: 'reconnect_failed' });
  expect(mockHealth.getStatus()).toMatchObject({
    state: 'unavailable',
    reason: 'reconnect_failed',
  });
  await expect(lease.transport.recovery()).rejects.toMatchObject({
    reason: 'held',
  });
  expect(mockGet).toHaveBeenCalledTimes(1);
  lease.close();
});

it('passes an untagged session client failure through unchanged', async () => {
  mockFilesContext.mockResolvedValue({ authorityId: 'authority' });
  const failure = new Error('Authority authority is unknown.');
  mockGet.mockResolvedValue(sessionThrowing(failure));
  const lease = leaseElectronW5RecordPort();
  expect(await rejectionOf(lease.transport.recovery())).toBe(failure);
  expect(mockHealth.getStatus().state).toBe('ok');
  lease.close();
});

it('refuses with nothing sent when the trusted host cannot be prepared, and shows the notice', async () => {
  const failure = new Error('data root unavailable');
  mockFilesContext.mockRejectedValue(failure);
  const lease = leaseElectronW5RecordPort();
  await expect(lease.transport.recovery()).rejects.toMatchObject({
    name: 'W5AuthorityUnreachableError',
    certainty: 'refused',
    reason: 'connect',
    cause: failure,
  });
  expect(mockGet).not.toHaveBeenCalled();
  expect(mockHealth.getStatus()).toMatchObject({
    state: 'unavailable',
    reason: 'host_unavailable',
  });
  lease.close();
});

it('notes a refused call the connection service never reported, once, and latches', async () => {
  mockFilesContext.mockResolvedValue({ authorityId: 'authority' });
  // A cached failed setup within its reuse window: no new connection event.
  mockGet.mockRejectedValue(
    markUnreachable(new Error('spawn failed'), 'start_failed'),
  );
  const noteFallback = jest.spyOn(mockHealth, 'noteFallback');
  const lease = leaseElectronW5RecordPort();
  expect(mockHealth.getStatus().state).toBe('ok');
  await expect(lease.transport.recovery()).rejects.toMatchObject({
    certainty: 'refused',
    reason: 'connect',
  });
  expect(noteFallback.mock.calls).toEqual([
    ['workspace_records', 'start_failed'],
  ]);
  expect(mockHealth.getStatus()).toMatchObject({
    state: 'unavailable',
    reason: 'start_failed',
  });
  expect(mockHealth.isLatched()).toBe(true);
  // Latched: the next call is held without a `get`, and noted no further.
  await expect(lease.transport.recovery()).rejects.toMatchObject({
    reason: 'held',
  });
  expect(mockGet).toHaveBeenCalledTimes(1);
  expect(noteFallback).toHaveBeenCalledTimes(1);
  noteFallback.mockRestore();
  lease.close();
});

describe("GA3's latch", () => {
  beforeEach(() => {
    mockFilesContext.mockResolvedValue({ authorityId: 'authority' });
    // Any session: these calls only need to show whether `get` was asked.
    mockGet.mockResolvedValue(sessionThrowing(new Error('unused')));
  });

  function latchedLease(): ReturnType<typeof leaseElectronW5RecordPort> {
    const lease = leaseElectronW5RecordPort();
    mockHealth.observe({ kind: 'unreachable', reason: 'connect_timeout' });
    expect(mockHealth.isLatched()).toBe(true);
    return lease;
  }

  it('refuses every call as held with no host lookup and no get', async () => {
    const lease = latchedLease();
    for (const call of [
      (): Promise<unknown> => lease.transport.recovery(),
      (): Promise<unknown> => lease.transport.releaseReservation('r-1'),
    ])
      await expect(call()).rejects.toMatchObject({
        name: 'W5AuthorityUnreachableError',
        certainty: 'refused',
        reason: 'held',
      });
    expect(mockFilesContext).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    lease.close();
  });

  it('is lifted by a reach', async () => {
    const lease = latchedLease();
    mockHealth.observe({ kind: 'reached' });
    await rejectionOf(lease.transport.recovery());
    expect(mockGet).toHaveBeenCalledTimes(1);
    lease.close();
  });

  it('is lifted while Try again runs, and re-armed when it fails', async () => {
    const lease = latchedLease();
    // Settled from outside, so the test never depends on when the attempt starts.
    let fail = (): void => undefined;
    const attempt = new Promise<boolean>((resolve) => {
      fail = (): void => resolve(false);
    });
    const retried = mockHealth.retry(() => attempt);
    expect(mockHealth.isLatched()).toBe(false);
    await rejectionOf(lease.transport.recovery());
    expect(mockGet).toHaveBeenCalledTimes(1);
    fail();
    await retried;
    expect(mockHealth.isLatched()).toBe(true);
    await expect(lease.transport.recovery()).rejects.toMatchObject({
      reason: 'held',
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    lease.close();
  });
});
