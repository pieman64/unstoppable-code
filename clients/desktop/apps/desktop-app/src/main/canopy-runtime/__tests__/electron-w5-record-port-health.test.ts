// GB4 (CAN-5542): the background service notice covers the W5 record-port
// lease when main's trusted host can't be prepared. That failure ends the
// call before the connection service's `get`, so the notice must come from
// the host's own report (GA3 `host_unavailable`), not `onReachability`.
import type * as ElectronDaemonHost from '../electron-daemon-host';

const mockHostFailure = new Error('data root unavailable');
const mockCreateHost = jest.fn(
  (): Promise<never> => Promise.reject(mockHostFailure),
);
jest.mock('electron', (): object => ({
  app: { getVersion: () => '0.0.0', isPackaged: false },
}));
jest.mock('../electron-daemon-host', () => ({
  ...jest.requireActual<typeof ElectronDaemonHost>('../electron-daemon-host'),
  createElectronDaemonHost: (): Promise<never> => mockCreateHost(),
}));

import {
  disposeElectronDaemonConnections,
  getElectronDaemonConnections,
} from '../electron-daemon-access';
import { getElectronDaemonHealth } from '../electron-daemon-health';
import { leaseElectronW5RecordPort } from '../electron-w5-record-port';

afterAll(() => disposeElectronDaemonConnections());

it('shows the notice when a call is refused because the trusted host cannot be prepared', async () => {
  const health = getElectronDaemonHealth();
  const get = jest.spyOn(getElectronDaemonConnections(), 'get');
  const lease = leaseElectronW5RecordPort();
  expect(health.getStatus().state).toBe('ok');

  await expect(lease.transport.recovery()).rejects.toMatchObject({
    name: 'W5AuthorityUnreachableError',
    certainty: 'refused',
    reason: 'connect',
    cause: mockHostFailure,
  });
  // Refused before the connection service: nothing was asked of it.
  expect(get).not.toHaveBeenCalled();
  expect(health.getStatus()).toMatchObject({
    state: 'unavailable',
    reason: 'host_unavailable',
  });
  // Latched: the next call is held without preparing the host again.
  expect(health.isLatched()).toBe(true);
  await expect(lease.transport.recovery()).rejects.toMatchObject({
    name: 'W5AuthorityUnreachableError',
    reason: 'held',
  });
  expect(mockCreateHost).toHaveBeenCalledTimes(1);
  expect(get).not.toHaveBeenCalled();

  // The last lease closing ends the notice: nothing reads through it.
  lease.close();
  expect(health.getStatus().state).toBe('ok');
  get.mockRestore();
});
