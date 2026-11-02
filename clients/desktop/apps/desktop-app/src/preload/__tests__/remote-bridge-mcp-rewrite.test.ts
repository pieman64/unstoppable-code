import type { IpcRendererEvent } from 'electron';
import { REMOTE_BRIDGE_CHANNELS } from '@canopy/desktop-shared/remote-control/bridge-channels';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';

const mockListeners = new Map<
  string,
  (event: IpcRendererEvent, message: unknown) => void
>();
const mockInvoke = jest.fn<Promise<unknown>, unknown[]>();
const mockSend = jest.fn<void, unknown[]>();
jest.mock('electron', () => ({
  ipcRenderer: {
    on: (
      channel: string,
      listener: (event: IpcRendererEvent, message: unknown) => void,
    ): void => {
      mockListeners.set(channel, listener);
    },
    invoke: (...args: unknown[]): Promise<unknown> => mockInvoke(...args),
    send: (...args: unknown[]): void => mockSend(...args),
  },
}));

beforeAll(async () => {
  await import('../remote-bridge');
});
beforeEach(() => {
  mockInvoke.mockReset();
  mockSend.mockClear();
});

it('keeps success and message-only failure on the existing tunnel', async () => {
  const invoke = mockListeners.get(REMOTE_BRIDGE_CHANNELS.invoke);
  if (!invoke) throw new Error('Missing bridge listener');
  const event = {} as IpcRendererEvent;
  const request = {
    from: [{ serverId: 'a' }],
    to: { serverId: 'b', configId: 'c' },
  };
  const result = {
    globalDefaults: false,
    workspaces: 0,
    chats: 0,
    retired: 'changed',
  };
  mockInvoke.mockResolvedValueOnce(result);
  invoke(event, {
    id: 1,
    channel: MCP_SERVER_CHANNELS.REWRITE_REFS,
    args: [request],
  });
  await Promise.resolve();
  expect(mockSend).toHaveBeenLastCalledWith(REMOTE_BRIDGE_CHANNELS.result, {
    id: 1,
    ok: true,
    value: result,
  });
  const error = Object.assign(
    new Error(
      "Error invoking remote method 'mcp-servers:rewrite-refs': Error: original failure",
    ),
    {
      code: 'core.catalog.mcpServer.rewriteFailed',
      details: { effects: 'unknown' },
    },
  );
  mockInvoke.mockRejectedValueOnce(error);
  invoke(event, {
    id: 2,
    channel: MCP_SERVER_CHANNELS.REWRITE_REFS,
    args: [request],
  });
  await Promise.resolve();
  expect(mockSend).toHaveBeenLastCalledWith(REMOTE_BRIDGE_CHANNELS.result, {
    id: 2,
    ok: false,
    message: 'original failure',
  });
  expect(mockInvoke).toHaveBeenCalledTimes(2);
});
