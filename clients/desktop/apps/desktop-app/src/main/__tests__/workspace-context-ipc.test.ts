import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  WorkspaceContextBroadcast,
  WorkspaceContextState,
} from '../lib/workspace-context-service';

type RegisteredHandler = (...args: unknown[]) => unknown;
type Listener = (state: WorkspaceContextBroadcast) => void;

interface MockBrowserWindow {
  isDestroyed: jest.MockedFunction<() => boolean>;
  webContents: {
    send: jest.MockedFunction<(channel: string, payload: unknown) => void>;
  };
}

const mockRegisterIpcHandler = jest.fn<void, [string, RegisteredHandler]>();
const mockGetState = jest.fn<WorkspaceContextState, []>();
const mockSetContext = jest.fn<
  Promise<WorkspaceContextState>,
  [unknown, number?]
>();
const mockSubscribe = jest.fn<() => void, [Listener]>();
const mockGetAllWindows = jest.fn<MockBrowserWindow[], []>();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: mockRegisterIpcHandler,
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): {
    getState: typeof mockGetState;
    setContext: typeof mockSetContext;
    subscribe: typeof mockSubscribe;
  } => ({
    getState: mockGetState,
    setContext: mockSetContext,
    subscribe: mockSubscribe,
  }),
}));
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mockGetAllWindows },
}));

import { registerWorkspaceContextHandlers } from '../ipc/workspace-context';

const ORG_A = '11111111-1111-4111-8111-111111111111';

function handlerFor(channel: string): RegisteredHandler {
  const call = mockRegisterIpcHandler.mock.calls.find(
    ([registered]) => registered === channel,
  );
  if (!call) throw new Error(`No IPC handler registered for ${channel}`);
  return call[1];
}

describe('workspace-context IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllWindows.mockReturnValue([]);
  });

  it('returns the service state on get', async () => {
    const state: WorkspaceContextState = {
      context: { kind: 'personal' },
      revision: 3,
      organizations: [],
    };
    mockGetState.mockReturnValue(state);
    registerWorkspaceContextHandlers();

    await expect(
      handlerFor(IPC_CHANNELS.workspaceContextGet)({}),
    ).resolves.toEqual(state);
  });

  it('validates the set payload before reaching the service', async () => {
    registerWorkspaceContextHandlers();
    const set = handlerFor(IPC_CHANNELS.workspaceContextSet);

    await expect(set({}, { context: { kind: 'team' } })).rejects.toThrow(
      /workspace context/i,
    );
    await expect(
      set({}, { context: { kind: 'personal' }, expectedRevision: -1 }),
    ).rejects.toThrow(/revision/i);
    // Organization ids must be normalized, lowercase identifiers.
    await expect(
      set({}, { context: { kind: 'organization', organizationId: 'Bad Id!' } }),
    ).rejects.toThrow(/invalid/i);
    await expect(
      set(
        {},
        {
          context: {
            kind: 'organization',
            organizationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
          },
        },
      ),
    ).rejects.toThrow(/invalid/i);
    expect(mockSetContext).not.toHaveBeenCalled();
  });

  it('forwards a valid set to the service with the expected revision', async () => {
    const next: WorkspaceContextState = {
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 1,
      organizations: [],
    };
    mockSetContext.mockResolvedValue(next);
    registerWorkspaceContextHandlers();

    await expect(
      handlerFor(IPC_CHANNELS.workspaceContextSet)(
        {},
        { context: next.context, expectedRevision: 0 },
      ),
    ).resolves.toEqual(next);
    expect(mockSetContext).toHaveBeenCalledWith(next.context, 0);
  });

  it('broadcasts service changes to every live window', () => {
    const live: MockBrowserWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: { send: jest.fn() },
    };
    const dead: MockBrowserWindow = {
      isDestroyed: jest.fn(() => true),
      webContents: { send: jest.fn() },
    };
    mockGetAllWindows.mockReturnValue([live, dead]);
    registerWorkspaceContextHandlers();
    const listener = mockSubscribe.mock.calls[0]?.[0];
    if (!listener) throw new Error('service listener not registered');

    const broadcast: WorkspaceContextBroadcast = {
      context: { kind: 'personal' },
      revision: 2,
      organizations: [],
      reason: 'switch',
    };
    listener(broadcast);

    expect(live.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceContextChanged,
      broadcast,
    );
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });
});
