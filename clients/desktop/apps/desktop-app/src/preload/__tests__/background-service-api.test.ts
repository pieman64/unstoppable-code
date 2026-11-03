import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { BackgroundServiceStatus } from '@canopy/desktop-shared/lib/background-service-status';
import { createBackgroundServiceApi } from '../api/background-service-api';

type Listener = (event: unknown, payload: unknown) => void;

const STATUS: BackgroundServiceStatus = {
  state: 'unavailable',
  reason: 'start_failed',
  retry: 'idle',
  sequence: 4,
};

describe('background service preload API (CAN-5541)', () => {
  const invoke = jest.fn<Promise<unknown>, [string]>();
  const on = jest.fn<void, [string, Listener]>();
  const removeListener = jest.fn<void, [string, Listener]>();
  const api = createBackgroundServiceApi({ invoke, on, removeListener });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the status and retries through their own channels', async () => {
    invoke.mockResolvedValue(STATUS);
    await expect(api.getStatus()).resolves.toEqual(STATUS);
    await expect(api.retry()).resolves.toEqual(STATUS);
    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.backgroundServiceStatus],
      [IPC_CHANNELS.backgroundServiceRetry],
    ]);
  });

  it('rejects a reply that is not a strict status', async () => {
    invoke.mockResolvedValue({ ...STATUS, message: '/Users/someone/data' });
    await expect(api.getStatus()).rejects.toThrow(
      'Background service status was unavailable.',
    );
  });

  it('forwards only strict status pushes and unsubscribes its own listener', () => {
    const received: BackgroundServiceStatus[] = [];
    const unsubscribe = api.onStatusChanged((status) => received.push(status));
    const [[channel, listener]] = on.mock.calls;
    expect(channel).toBe(IPC_CHANNELS.backgroundServiceStatusChanged);
    listener({}, { ...STATUS, sequence: 5, path: '/tmp' });
    listener({}, { state: 'gone', retry: 'idle', sequence: 6 });
    listener({}, { ...STATUS, sequence: 7 });
    expect(received).toEqual([{ ...STATUS, sequence: 7 }]);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.backgroundServiceStatusChanged,
      listener,
    );
  });
});
