import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';

type RegisteredHandler = (...args: unknown[]) => unknown;
type SnapshotListener = (snapshot: FeatureFlagSnapshot) => void;

interface MockBrowserWindow {
  isDestroyed: jest.MockedFunction<() => boolean>;
  webContents: {
    send: jest.MockedFunction<
      (channel: string, snapshot: FeatureFlagSnapshot) => void
    >;
  };
}

const mockRegisterIpcHandler = jest.fn<void, [string, RegisteredHandler]>();
const mockGetSnapshot = jest.fn<FeatureFlagSnapshot, []>();
const mockRefreshContext = jest.fn<Promise<FeatureFlagSnapshot>, []>();
const mockOnSnapshotChanged = jest.fn<() => void, [SnapshotListener]>();
const mockGetAllWindows = jest.fn<MockBrowserWindow[], []>();

jest.mock(
  '../ipc/register',
  (): {
    registerIpcHandler: typeof mockRegisterIpcHandler;
  } => ({
    registerIpcHandler: mockRegisterIpcHandler,
  }),
);

jest.mock(
  '../feature-flags',
  (): {
    getFeatureFlagService: () => {
      getSnapshot: typeof mockGetSnapshot;
      refreshContext: typeof mockRefreshContext;
      onSnapshotChanged: typeof mockOnSnapshotChanged;
    };
  } => ({
    getFeatureFlagService: (): {
      getSnapshot: typeof mockGetSnapshot;
      refreshContext: typeof mockRefreshContext;
      onSnapshotChanged: typeof mockOnSnapshotChanged;
    } => ({
      getSnapshot: mockGetSnapshot,
      refreshContext: mockRefreshContext,
      onSnapshotChanged: mockOnSnapshotChanged,
    }),
  }),
);

jest.mock(
  'electron',
  (): {
    BrowserWindow: { getAllWindows: typeof mockGetAllWindows };
  } => ({
    BrowserWindow: {
      getAllWindows: mockGetAllWindows,
    },
  }),
);

import { registerFeatureFlagHandlers } from '../ipc/feature-flags';

function getRegisteredHandler(
  channel: string,
): (...args: unknown[]) => unknown {
  const call = mockRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!call) {
    throw new Error(`No IPC handler registered for ${channel}`);
  }
  return call[1];
}

function snapshot(enabled: boolean): FeatureFlagSnapshot {
  return {
    ...getDefaultFeatureFlagSnapshot(),
    values: {
      ...getDefaultFeatureFlagSnapshot().values,
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: enabled,
      [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: false,
    },
    status: 'ready' as const,
    initialized: true,
    updatedAt: '2026-05-26T00:00:00.000Z',
    error: null,
  };
}

describe('feature flag IPC handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSnapshot.mockReturnValue(snapshot(true));
    mockRefreshContext.mockResolvedValue(snapshot(false));
    mockGetAllWindows.mockReturnValue([]);
  });

  it('registers snapshot fetch and refresh handlers', async () => {
    registerFeatureFlagHandlers(() => null);

    expect(
      getRegisteredHandler(IPC_CHANNELS.featureFlagsGetSnapshot)({}),
    ).toEqual(snapshot(true));
    await expect(
      getRegisteredHandler(IPC_CHANNELS.featureFlagsRefreshContext)({}),
    ).resolves.toEqual(snapshot(false));
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1);
    expect(mockRefreshContext).toHaveBeenCalledTimes(1);
  });

  it('broadcasts snapshot changes to all non-destroyed BrowserWindows', () => {
    const liveWindow: MockBrowserWindow = {
      isDestroyed: jest.fn<false, []>(() => false),
      webContents: {
        send: jest.fn<void, [string, FeatureFlagSnapshot]>(),
      },
    };
    const destroyedWindow: MockBrowserWindow = {
      isDestroyed: jest.fn<true, []>(() => true),
      webContents: {
        send: jest.fn<void, [string, FeatureFlagSnapshot]>(),
      },
    };
    mockGetAllWindows.mockReturnValue([liveWindow, destroyedWindow]);

    registerFeatureFlagHandlers(() => null);
    const listener = mockOnSnapshotChanged.mock.calls[0]?.[0];
    if (typeof listener !== 'function') {
      throw new Error('snapshot listener was not registered');
    }

    listener(snapshot(false));

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.featureFlagsSnapshotChanged,
      snapshot(false),
    );
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });
});
