import { createMcpServersAPI } from '../api/mcp-servers-api';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
const mockInvoke = jest
  .fn<Promise<unknown>, unknown[]>()
  .mockResolvedValue(undefined);
jest.mock('electron', (): object => ({
  ipcRenderer: {
    invoke: (...args: unknown[]): Promise<unknown> => mockInvoke(...args),
  },
}));
it('preserves curated endpoint selection across preload IPC', async (): Promise<void> => {
  const request = {
    serverKey: 'github',
    endpointUrl: 'https://eu.example.test/mcp',
    oauthClient: { clientId: 'own-client', clientSecret: 'own-secret' },
    configId: 'default',
  };
  await createMcpServersAPI().startAccountConnection(request);
  expect(mockInvoke).toHaveBeenCalledWith(
    MCP_SERVER_CHANNELS.START_ACCOUNT,
    request,
  );
});

let mockRemoteWindow = false;
jest.mock('../ipc-router', () => ({
  get remoteWindowContext(): object | null {
    return mockRemoteWindow ? {} : null;
  },
  ipcRenderer: {
    invoke: (...args: unknown[]): Promise<unknown> => mockInvoke(...args),
  },
}));
it.each([false, true])(
  'routes embedded starts with remote=%p',
  async (remote) => {
    mockInvoke.mockClear();
    mockRemoteWindow = remote;
    const request = {
      serverKey: 'github',
      configId: 'default',
      browser: 'embedded' as const,
    };
    await createMcpServersAPI().startAccountConnection(request);
    expect(mockInvoke).toHaveBeenCalledWith(
      MCP_SERVER_CHANNELS.START_ACCOUNT,
      remote ? { serverKey: 'github', configId: 'default' } : request,
    );
    mockRemoteWindow = false;
  },
);

it.each([false, true])(
  'forwards one rewrite and preserves results/errors with remote=%p',
  async (remote) => {
    mockInvoke.mockClear();
    mockRemoteWindow = remote;
    const request = {
      from: [{ serverId: 'a' }],
      to: { serverId: 'b', configId: 'c' },
    };
    const result = {
      globalDefaults: true,
      workspaces: 1,
      chats: 2,
      retired: 'removed',
    };
    const error = new Error('original failure');
    try {
      mockInvoke.mockResolvedValueOnce(result);
      await expect(
        createMcpServersAPI().rewriteServerRefs(request),
      ).resolves.toBe(result);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith(
        MCP_SERVER_CHANNELS.REWRITE_REFS,
        request,
      );
      mockInvoke.mockRejectedValueOnce(error);
      await expect(
        createMcpServersAPI().rewriteServerRefs(request),
      ).rejects.toBe(error);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    } finally {
      mockRemoteWindow = false;
    }
  },
);
