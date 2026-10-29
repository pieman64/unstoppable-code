const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(
    (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  ),
}));

const sendToWindowMock = jest.fn();
jest.mock('../lib/window-send', () => ({
  sendToWindow: (...args: unknown[]): unknown => sendToWindowMock(...args),
}));

const getStatusMock = jest.fn();
const subscribeStatusMock = jest.fn<
  () => void,
  [(status: TelemetrySyncStatus) => void]
>();
jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: (): unknown => ({
    recordUserActivity: jest.fn(),
  }),
}));
// The status surface reads the pause monitor, which republishes the service
// status with `pausedReason` attached (CAN-3512).
jest.mock('../services/telemetry-sync-pause-host', () => ({
  getTelemetrySyncPauseMonitor: (): unknown => ({
    getStatus: getStatusMock,
    subscribeStatus: subscribeStatusMock,
  }),
}));

import {
  IPC_CHANNELS,
  type TelemetrySyncStatus,
} from '@canopy/desktop-shared/types';
import { registerTelemetrySyncHandlers } from '../ipc/telemetry-sync';

function makeStatus(
  overrides: Partial<TelemetrySyncStatus> = {},
): TelemetrySyncStatus {
  return {
    isSyncing: false,
    pendingCount: 0,
    sharingActive: true,
    lastSyncedAt: null,
    lastErrorAt: null,
    lastError: null,
    ...overrides,
  };
}

describe('telemetry-sync IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registeredHandlers.clear();
    subscribeStatusMock.mockReturnValue(() => undefined);
    getStatusMock.mockReturnValue(makeStatus());
  });

  it('registers a getter that returns the current status', async (): Promise<void> => {
    const expected = makeStatus({ pendingCount: 3, isSyncing: true });
    getStatusMock.mockReturnValue(expected);
    registerTelemetrySyncHandlers(() => null);

    const handler = registeredHandlers.get(IPC_CHANNELS.telemetrySyncGetStatus);
    if (handler === undefined) {
      throw new Error('telemetry-sync status getter was not registered');
    }

    await expect(
      Reflect.apply(handler, undefined, [undefined]),
    ).resolves.toEqual(expected);
    expect(getStatusMock).toHaveBeenCalledTimes(1);
  });

  it('returns the pause reason with the status', async (): Promise<void> => {
    const expected = makeStatus({
      pendingCount: 12,
      sharingActive: false,
      pausedReason: 'queue-stalled',
    });
    getStatusMock.mockReturnValue(expected);
    registerTelemetrySyncHandlers(() => null);

    const handler = registeredHandlers.get(IPC_CHANNELS.telemetrySyncGetStatus);
    if (handler === undefined) {
      throw new Error('telemetry-sync status getter was not registered');
    }
    await expect(
      Reflect.apply(handler, undefined, [undefined]),
    ).resolves.toMatchObject({ pausedReason: 'queue-stalled' });
  });

  it('broadcasts status snapshots to the main window', () => {
    const window = { id: 'main' };
    registerTelemetrySyncHandlers(() => window as never);

    expect(subscribeStatusMock).toHaveBeenCalledTimes(1);
    const listener = subscribeStatusMock.mock.calls[0][0];

    const status = makeStatus({ isSyncing: true, pendingCount: 1 });
    listener(status);

    expect(sendToWindowMock).toHaveBeenCalledWith(
      window,
      IPC_CHANNELS.telemetrySyncStatusEvent,
      status,
    );
  });
});
