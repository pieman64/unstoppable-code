import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, type WakeLockState } from '@canopy/desktop-shared/types';

interface BroadcastHandlers {
  stateChanged: (state: WakeLockState) => void;
}

let broadcastHandlers: BroadcastHandlers | null = null;

const defaultState: WakeLockState = {
  active: false,
  enabled: true,
  holderCount: 0,
};

const activeState: WakeLockState = {
  active: true,
  enabled: true,
  holderCount: 2,
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockHandle = jest.fn<void, [string, (...args: unknown[]) => unknown]>(
  (channel, handler) => {
    registeredHandlers.set(channel, handler);
  },
);
const mockRemoveHandler = jest.fn<void, [string]>((channel) => {
  registeredHandlers.delete(channel);
});

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown): void =>
      mockHandle(channel, handler),
    removeHandler: (channel: string): void => {
      mockRemoveHandler(channel);
    },
  },
}));

const getStateMock = jest.fn<WakeLockState, []>(() => defaultState);
const setBroadcastHandlersMock = jest.fn<void, [BroadcastHandlers]>(
  (handlers) => {
    broadcastHandlers = handlers;
  },
);

jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: (): {
    getState: typeof getStateMock;
    setBroadcastHandlers: typeof setBroadcastHandlersMock;
  } => ({
    getState: getStateMock,
    setBroadcastHandlers: setBroadcastHandlersMock,
  }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { registerWakeLockHandlers } from '../ipc/wake-lock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSend = jest.fn<void, [string, ...unknown[]]>();
const mockWebContents = {
  isCrashed: (): boolean => false,
  isDestroyed: (): boolean => false,
  send: mockSend,
  mainFrame: {
    detached: false,
    isDestroyed: (): boolean => false,
  },
};
const mockWindow = {
  isDestroyed: (): boolean => false,
  webContents: mockWebContents,
} as unknown as BrowserWindow;

const getWindow = (): BrowserWindow | null => mockWindow;

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wake-lock IPC handlers', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    jest.clearAllMocks();
    broadcastHandlers = null;
    getStateMock.mockReturnValue(defaultState);
    registerWakeLockHandlers(getWindow);
  });

  it('registers a handler for wake-lock:get-state', () => {
    expect(getHandler(IPC_CHANNELS.wakeLockGetState)).toBeDefined();
    expect(mockHandle).toHaveBeenCalledWith(
      IPC_CHANNELS.wakeLockGetState,
      expect.any(Function),
    );
    expect(mockRemoveHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.wakeLockGetState,
    );
  });

  it('installs a state-changed broadcast handler on the service', () => {
    expect(setBroadcastHandlersMock).toHaveBeenCalledTimes(1);
    const handlers = setBroadcastHandlersMock.mock.calls[0]?.[0];
    expect(typeof handlers?.stateChanged).toBe('function');
  });

  it('wakeLockGetState returns the service state', async () => {
    const handler = getHandler(IPC_CHANNELS.wakeLockGetState);
    await expect(handler({})).resolves.toEqual(defaultState);
    expect(getStateMock).toHaveBeenCalledTimes(1);
  });

  it('forwards stateChanged broadcasts to the window on wake-lock:state-changed', () => {
    expect(broadcastHandlers).not.toBeNull();
    broadcastHandlers?.stateChanged(activeState);

    expect(mockSend).toHaveBeenCalledWith(
      IPC_CHANNELS.wakeLockStateChanged,
      activeState,
    );
  });

  it('skips renderer broadcasts when no window is available', () => {
    const noWindow = (): BrowserWindow | null => null;
    setBroadcastHandlersMock.mockClear();
    mockSend.mockClear();
    registerWakeLockHandlers(noWindow);

    expect(broadcastHandlers).not.toBeNull();
    broadcastHandlers?.stateChanged(activeState);

    expect(mockSend).not.toHaveBeenCalled();
  });
});
