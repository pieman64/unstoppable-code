import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { BackgroundServiceStatus } from '@canopy/desktop-shared/lib/background-service-status';
import type { ElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';

const mockHandlers = new Map<string, (event: unknown) => unknown>();
const mockSend = jest.fn();
const mockRetry = jest.fn();
let mockHealth: ElectronDaemonHealth;

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown) => unknown,
  ): void => void mockHandlers.set(channel, handler),
}));
jest.mock('../lib/window-send', () => ({
  sendToAllWindows: (...args: unknown[]): unknown => mockSend(...args),
}));
jest.mock('../canopy-runtime/electron-daemon-files-access', () => ({
  retryDesktopDaemonFilesConnection: (...args: unknown[]): unknown =>
    mockRetry(...args),
}));
jest.mock('../canopy-runtime/electron-daemon-health', () => ({
  ...jest.requireActual<object>('../canopy-runtime/electron-daemon-health'),
  getElectronDaemonHealth: (): ElectronDaemonHealth => mockHealth,
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { createElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';
import { registerBackgroundServiceHandlers } from '../ipc/background-service';

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:3',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

beforeEach(() => {
  mockHandlers.clear();
  mockSend.mockClear();
  mockRetry.mockReset();
  mockHealth = createElectronDaemonHealth({ warn: jest.fn(), info: jest.fn() });
  mockHealth.setConsumerEnabled('files_reads', true);
});

function handler(channel: string): (event: unknown) => unknown {
  const registered = mockHandlers.get(channel);
  if (!registered) throw new Error(`${channel} is not registered`);
  return registered;
}

it('answers the status, pushes each change to every window and stops at close', () => {
  const close = registerBackgroundServiceHandlers(() => CALLER);
  expect(handler(IPC_CHANNELS.backgroundServiceStatus)({})).toEqual({
    state: 'ok',
    retry: 'idle',
    sequence: 0,
  });
  mockHealth.observe({ kind: 'unreachable', reason: 'start_failed' });
  const pushed: BackgroundServiceStatus = mockHealth.getStatus();
  expect(mockSend).toHaveBeenCalledWith(
    IPC_CHANNELS.backgroundServiceStatusChanged,
    pushed,
  );
  close();
  mockHealth.observe({ kind: 'reached' });
  expect(mockSend).toHaveBeenCalledTimes(1);
});

it('retries for the trusted caller of the requesting sender', async () => {
  const resolveCaller = jest.fn(() => CALLER);
  registerBackgroundServiceHandlers(resolveCaller);
  const sender = { id: 3 };
  const event = { sender };
  mockRetry.mockResolvedValue(mockHealth.getStatus());
  await handler(IPC_CHANNELS.backgroundServiceRetry)(event);
  expect(resolveCaller).toHaveBeenCalledWith(event);
  expect(mockRetry).toHaveBeenCalledWith(sender, CALLER);
});

it('refuses an untrusted sender before any attempt', () => {
  registerBackgroundServiceHandlers(() => {
    throw new Error('Permission denied.');
  });
  expect(() =>
    handler(IPC_CHANNELS.backgroundServiceRetry)({ sender: { id: 4 } }),
  ).toThrow('Permission denied.');
  expect(mockRetry).not.toHaveBeenCalled();
});
