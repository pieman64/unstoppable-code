import type {
  LaunchAtLoginSetResult,
  LaunchAtLoginStatus,
} from '@canopy/desktop-shared/types';

const mockRegisterIpcHandler = jest.fn<void, unknown[]>();
const mockGetStatus = jest.fn<Promise<LaunchAtLoginStatus>, []>();
const mockSetEnabled = jest.fn<Promise<LaunchAtLoginSetResult>, [boolean]>();
const mockOpenSystemSettings = jest.fn<Promise<void>, []>();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (...args: unknown[]): void => {
    mockRegisterIpcHandler(...args);
  },
}));
interface ServiceMock {
  getStatus: typeof mockGetStatus;
  setEnabled: typeof mockSetEnabled;
  openSystemSettings: typeof mockOpenSystemSettings;
}
jest.mock('../lifecycle/launch-at-login', () => ({
  getLaunchAtLoginService: (): ServiceMock => ({
    getStatus: mockGetStatus,
    setEnabled: mockSetEnabled,
    openSystemSettings: mockOpenSystemSettings,
  }),
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  handleGetLaunchAtLoginStatus,
  handleOpenLaunchAtLoginSystemSettings,
  handleSetLaunchAtLoginEnabled,
  registerLaunchAtLoginHandlers,
} from '../ipc/launch-at-login';

const STATUS: LaunchAtLoginStatus = {
  platform: 'darwin',
  supported: true,
  enabled: true,
  pendingApproval: false,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('launch-at-login IPC', () => {
  it('registers the three request channels', () => {
    registerLaunchAtLoginHandlers();
    expect(mockRegisterIpcHandler.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.launchAtLoginGetStatus,
      IPC_CHANNELS.launchAtLoginSetEnabled,
      IPC_CHANNELS.launchAtLoginOpenSystemSettings,
    ]);
  });

  it('returns the service status', async () => {
    mockGetStatus.mockResolvedValue(STATUS);
    await expect(handleGetLaunchAtLoginStatus()).resolves.toEqual(STATUS);
  });

  it('delegates a boolean to the service', async () => {
    const result: LaunchAtLoginSetResult = { ok: true, status: STATUS };
    mockSetEnabled.mockResolvedValue(result);
    await expect(handleSetLaunchAtLoginEnabled(true)).resolves.toBe(result);
    expect(mockSetEnabled).toHaveBeenCalledWith(true);
  });

  it.each([['true'], [1], [null], [undefined], [{ enabled: true }]])(
    'rejects %p before it reaches the OS',
    async (value) => {
      await expect(handleSetLaunchAtLoginEnabled(value)).rejects.toThrow(
        'enabled must be a boolean',
      );
      expect(mockSetEnabled).not.toHaveBeenCalled();
    },
  );

  it('opens the system pane through the service', async () => {
    mockOpenSystemSettings.mockResolvedValue(undefined);
    await handleOpenLaunchAtLoginSystemSettings();
    expect(mockOpenSystemSettings).toHaveBeenCalledTimes(1);
  });

  it('wires each registered channel to its handler', async () => {
    mockGetStatus.mockResolvedValue(STATUS);
    mockSetEnabled.mockResolvedValue({ ok: true, status: STATUS });
    mockOpenSystemSettings.mockResolvedValue(undefined);
    registerLaunchAtLoginHandlers();
    type Handler = (event: unknown, ...args: unknown[]) => unknown;
    const isHandler = (value: unknown): value is Handler =>
      typeof value === 'function';
    const invoke = (channel: string, ...args: unknown[]): unknown => {
      const handler = mockRegisterIpcHandler.mock.calls.find(
        (call) => call[0] === channel,
      )?.[1];
      if (!isHandler(handler)) throw new Error('missing handler');
      return handler({}, ...args);
    };
    await expect(invoke(IPC_CHANNELS.launchAtLoginGetStatus)).resolves.toEqual(
      STATUS,
    );
    await invoke(IPC_CHANNELS.launchAtLoginSetEnabled, false);
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
    await invoke(IPC_CHANNELS.launchAtLoginOpenSystemSettings);
    expect(mockOpenSystemSettings).toHaveBeenCalledTimes(1);
  });
});
