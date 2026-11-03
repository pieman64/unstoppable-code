import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { ElectronDaemonConnectionOptions } from '../electron-daemon-connection';
import type { ElectronDaemonClient } from '../electron-daemon-host';
import type { WorkspaceCommitEventBindingOptions } from '../workspace-commit-events';

/*
 * W5e (CAN-5497) wiring: main records every leased client instance id as its
 * own origin and hands each daemon session to the commit event binding,
 * which it loads with the first session and never uses to connect.
 */

let mockConnectionOptions:
  | ElectronDaemonConnectionOptions<ElectronDaemonClient>
  | undefined;
let mockBindingOptions: WorkspaceCommitEventBindingOptions | undefined;
const mockCreateBinding = jest.fn();
const mockObserve = jest.fn();
const mockClose = jest.fn(() => Promise.resolve());
const mockAttachDaemon = jest.fn();
const mockCreateHost = jest.fn((): Promise<unknown> => new Promise(() => {}));
const mockHealthObserve = jest.fn();
const mockHealthStop = jest.fn();

jest.mock('electron', (): object => ({ app: { getVersion: () => '0.0.0' } }));
jest.mock('@canopy/core-client/node', (): object => ({
  attachOrStartCanopyDaemon: (...args: unknown[]): unknown =>
    mockAttachDaemon(...args),
}));
jest.mock('../electron-daemon-host', (): object => ({
  ELECTRON_DAEMON_DEFINITIONS: {},
  createElectronDaemonHost: (): Promise<unknown> => mockCreateHost(),
}));
jest.mock('../electron-daemon-health', (): object => ({
  getElectronDaemonHealth: (): object => ({
    observe: mockHealthObserve,
    stop: mockHealthStop,
  }),
}));
jest.mock('../electron-daemon-connection', (): object => ({
  createElectronDaemonConnectionService: (
    options: ElectronDaemonConnectionOptions<ElectronDaemonClient>,
  ): object => {
    mockConnectionOptions = options;
    return { get: jest.fn(), dispose: () => Promise.resolve() };
  },
}));
jest.mock('../workspace-commit-events', (): object => ({
  createWorkspaceCommitEventBinding: (
    options: WorkspaceCommitEventBindingOptions,
  ): object => {
    mockCreateBinding();
    mockBindingOptions = options;
    return { observe: mockObserve, close: mockClose };
  },
}));
jest.mock('../workspace-commit-event-handlers', (): object => ({
  createDesktopWorkspaceCommitEventHandlers: (): object => ({}),
}));

import {
  disposeElectronDaemonCallerLifetimes,
  disposeElectronDaemonConnections,
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
} from '../electron-daemon-access';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

const caller = (clientInstanceId: string): CanopyCallerDescriptor => ({
  principalId: 'local-user',
  clientInstanceId,
  authorityId: 'authority',
  interfaceKind: 'desktop',
  grants: [],
});

function onSession(): NonNullable<
  ElectronDaemonConnectionOptions<ElectronDaemonClient>['onSession']
> {
  const observer = mockConnectionOptions?.onSession;
  if (!observer) throw new Error('No session observer was registered.');
  return observer;
}

// CAN-5541: reads resolve the host before the connection service, so its
// failure reaches the background service health record from here.
it('reports a host that cannot be prepared as unreachable and retries it on the next use', async () => {
  const preparation = new Error('data root unavailable');
  mockCreateHost.mockRejectedValueOnce(preparation);
  await expect(getElectronDaemonFilesContext()).rejects.toBe(preparation);
  await flush();
  expect(mockHealthObserve.mock.calls).toEqual([
    [{ kind: 'unreachable', reason: 'host_unavailable' }],
  ]);
  mockCreateHost.mockResolvedValueOnce({
    authorityId: 'authority',
    canonicalDataRoot: '/data',
  });
  await expect(getElectronDaemonFilesContext()).resolves.toEqual({
    authorityId: 'authority',
    canonicalDataRoot: '/data',
  });
  await flush();
  expect(mockCreateHost).toHaveBeenCalledTimes(2);
  expect(mockHealthObserve).toHaveBeenCalledTimes(1);
});

describe('the Electron daemon access W5e wiring', () => {
  // One module instance: these steps share its process-wide state.
  it('observes each session, owns its callers and stops at dispose', async () => {
    getElectronDaemonConnections();
    await flush();
    // Constructing the service loads no binding and opens no connection.
    expect(mockCreateBinding).not.toHaveBeenCalled();
    expect(mockAttachDaemon).not.toHaveBeenCalled();

    const first = { client: {}, lease: {}, close: jest.fn() };
    const second = { client: {}, lease: {}, close: jest.fn() };
    // @ts-expect-error -- a stand-in session; the binding is mocked.
    onSession()(first, caller('renderer-1'));
    // @ts-expect-error -- a stand-in session; the binding is mocked.
    onSession()(second, caller('renderer-2'));
    await flush();
    expect(mockCreateBinding).toHaveBeenCalledTimes(1);
    expect(mockObserve.mock.calls).toEqual([[first], [second]]);
    expect(mockBindingOptions?.isOwnOrigin('renderer-1')).toBe(true);
    expect(mockBindingOptions?.isOwnOrigin('renderer-2')).toBe(true);
    expect(mockBindingOptions?.isOwnOrigin('cli-1')).toBe(false);
    expect(mockAttachDaemon).not.toHaveBeenCalled();

    // A flip build's Files quit slot (CAN-5543): the notice stops before the
    // W5 sessions do, and observation keeps running until the W5 slot.
    disposeElectronDaemonCallerLifetimes();
    expect(mockHealthStop).toHaveBeenCalledTimes(1);
    expect(mockClose).not.toHaveBeenCalled();

    await disposeElectronDaemonConnections();
    expect(mockClose).toHaveBeenCalledTimes(1);
    mockObserve.mockClear();
    // @ts-expect-error -- a stand-in session; the binding is mocked.
    onSession()({ client: {}, lease: {}, close: jest.fn() }, caller('late-1'));
    await flush();
    expect(mockObserve).not.toHaveBeenCalled();
    // Its commits are still its own, though no subscriber runs any more.
    expect(mockBindingOptions?.isOwnOrigin('late-1')).toBe(true);
  });
});
