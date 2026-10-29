import {
  IPC_CHANNELS,
  type CursorConnectionStatus,
} from '@canopy/desktop-shared/types';

// A minimal local stand-in for Electron's `IpcMainInvokeEvent`. Only the
// fields `assertOwner`/the connect/disconnect handlers actually read
// (`sender.id`, `sender.isDestroyed()`, `sender.mainFrame`,
// `sender.once`/`off`/`send`, `senderFrame`) — declaring the real interface's
// every field would add nothing a mocked module ever inspects.
interface FakeIpcSender {
  id: number;
  isDestroyed: () => boolean;
  mainFrame: object;
  once: (event: string, callback: () => void) => void;
  off: (event: string, callback: () => void) => void;
  send: (channel: string, ...args: unknown[]) => void;
}
interface FakeIpcEvent {
  sender: FakeIpcSender;
  senderFrame: object;
}

// Mirrors the established `registerIpcHandler` capture pattern
// (`ipc/__tests__/workspace-items.test.ts`): bypass real `ipcMain` wiring and
// invoke the registered handler function directly.
const handlers = new Map<string, (event: FakeIpcEvent) => Promise<unknown>>();
jest.mock('../register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: FakeIpcEvent) => Promise<unknown>,
  ): void => {
    handlers.set(channel, handler);
  },
}));

jest.mock('electron', () => ({
  BrowserWindow: { fromWebContents: jest.fn(() => ({})) },
}));

jest.mock('../../cursor/feature-flag', () => ({
  assertCursorHarnessEnabled: jest.fn(),
}));

const mockInvalidateCursorUsage = jest.fn();
const mockRefreshProviderUsage = jest.fn(() => Promise.resolve());
jest.mock('../../observability', () => ({
  getObservabilityService: (): unknown => ({
    invalidateCursorUsage: mockInvalidateCursorUsage,
    refreshProviderUsage: mockRefreshProviderUsage,
  }),
}));

const mockBroadcastModelRegistryUpdated = jest.fn<void, []>();
jest.mock('../../models/model-registry', () => ({
  broadcastModelRegistryUpdated: (): void =>
    mockBroadcastModelRegistryUpdated(),
}));

// Finding #2 (CAN-3624 review): after Connect/Disconnect refresh Cursor
// availability, the fix must also push the same live update to any open
// Portal session — `broadcastModelRegistryUpdated` above only reaches desktop
// renderer windows. `notifyPortalStructureChanged` is the portal-event-bus
// emitter that already re-projects every worktree's `chat_summary` entities
// (carrying `providerAvailability`) into a fresh overview snapshot; its own
// behavior (including that the snapshot carries `providerAvailability`) is
// covered by `portal/__tests__/portal-event-bus.test.ts` and
// `services/__tests__/chat-service.test.ts`. This spec only asserts that the
// Cursor connect/disconnect handlers actually call it.
const mockNotifyPortalStructureChanged = jest.fn<void, []>();
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: (): void => mockNotifyPortalStructureChanged(),
}));

const mockListCursorModels = jest.fn(() => Promise.resolve([]));
const mockInvalidateCursorModels = jest.fn(() => Promise.resolve());
jest.mock('../../cursor/models', () => ({
  listCursorModels: (): unknown => mockListCursorModels(),
  invalidateCursorModels: (): unknown => mockInvalidateCursorModels(),
}));

const mockConnectCursor = jest.fn<Promise<CursorConnectionStatus>, []>();
const mockDisconnectCursor = jest.fn(() => Promise.resolve());
jest.mock('../../cursor/connection', () => ({
  connectCursor: (): unknown => mockConnectCursor(),
  disconnectCursor: (): unknown => mockDisconnectCursor(),
}));

const mockRefreshCursorRuntimeAvailability = jest.fn(() =>
  Promise.resolve(true),
);
const mockProbeCursorRuntimeStatus = jest.fn<
  Promise<CursorConnectionStatus>,
  []
>();
jest.mock('../../cursor/runtime-availability', () => ({
  refreshCursorRuntimeAvailability: (): unknown =>
    mockRefreshCursorRuntimeAvailability(),
  probeCursorRuntimeStatus: (): unknown => mockProbeCursorRuntimeStatus(),
}));

import { registerCursorConnectionHandlers } from '../cursor-connection';

function connectedStatus(): CursorConnectionStatus {
  return {
    supported: true,
    installed: true,
    enabled: true,
    version: '2026.09.08',
    phase: 'connected',
  };
}

function fakeEvent(): FakeIpcEvent {
  const frame: object = {};
  const sender: FakeIpcSender = {
    id: 1,
    isDestroyed: (): boolean => false,
    mainFrame: frame,
    once: (): void => {},
    off: (): void => {},
    send: (): void => {},
  };
  return { sender, senderFrame: frame };
}

describe('Cursor connection IPC pushes portal-facing availability updates (CAN-3624 review finding #2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    mockConnectCursor.mockResolvedValue(connectedStatus());
    mockRefreshCursorRuntimeAvailability.mockResolvedValue(true);
    registerCursorConnectionHandlers();
  });

  it('notifies the portal after a successful Connect refreshes availability', async () => {
    const handler = handlers.get(IPC_CHANNELS.cursorConnectionConnect);
    if (!handler) throw new Error('Missing connect handler');

    await handler(fakeEvent());

    expect(mockRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(1);
    expect(mockNotifyPortalStructureChanged).toHaveBeenCalledTimes(1);
    // The portal push must reflect the FRESH availability, not race ahead of it.
    expect(
      mockRefreshCursorRuntimeAvailability.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockNotifyPortalStructureChanged.mock.invocationCallOrder[0],
    );
  });

  it('notifies the portal after Disconnect refreshes availability', async () => {
    const handler = handlers.get(IPC_CHANNELS.cursorConnectionDisconnect);
    if (!handler) throw new Error('Missing disconnect handler');

    await handler(fakeEvent());

    expect(mockDisconnectCursor).toHaveBeenCalledTimes(1);
    expect(mockRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(1);
    expect(mockNotifyPortalStructureChanged).toHaveBeenCalledTimes(1);
    expect(
      mockRefreshCursorRuntimeAvailability.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockNotifyPortalStructureChanged.mock.invocationCallOrder[0],
    );
  });

  it('does not notify the portal when Connect does not reach a fully connected state', async () => {
    mockConnectCursor.mockResolvedValue({
      supported: true,
      installed: false,
      enabled: false,
      version: '2026.09.08',
      phase: 'idle',
    });
    const handler = handlers.get(IPC_CHANNELS.cursorConnectionConnect);
    if (!handler) throw new Error('Missing connect handler');

    await handler(fakeEvent());

    expect(mockRefreshCursorRuntimeAvailability).not.toHaveBeenCalled();
    expect(mockNotifyPortalStructureChanged).not.toHaveBeenCalled();
  });
});

describe('Cursor connection status uses the canonical single probe (CAN-3624 multi-model review finding)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    registerCursorConnectionHandlers();
  });

  it('returns the canonical probe result and does not run a second, separate probe to warm the cache', async () => {
    const status = connectedStatus();
    mockProbeCursorRuntimeStatus.mockResolvedValue(status);
    const handler = handlers.get(IPC_CHANNELS.cursorConnectionStatus);
    if (!handler) throw new Error('Missing status handler');

    const result = await handler(fakeEvent());

    expect(result).toBe(status);
    expect(mockProbeCursorRuntimeStatus).toHaveBeenCalledTimes(1);
    // A prior version of this handler ran `cursorConnectionStatus()` directly
    // for the return value, THEN called `refreshCursorRuntimeAvailability()`
    // to warm the cache — duplicating `readPreferencesFile()` plus a
    // `lstat`/`access` per required runtime file, and (worse) minting the
    // cache-write generation only after its own probe resolved, so a slow
    // status call could clobber a fast, newer Disconnect refresh. The single
    // canonical probe in `runtime-availability.ts` fixes both.
    expect(mockRefreshCursorRuntimeAvailability).not.toHaveBeenCalled();
  });
});
