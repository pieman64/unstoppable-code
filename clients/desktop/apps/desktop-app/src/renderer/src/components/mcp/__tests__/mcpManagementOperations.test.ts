/** @jest-environment jsdom */
import type {
  AccountMcpConnection,
  SaveMcpServerRequest,
} from '@canopy/desktop-shared/types/mcp-servers';
import {
  deleteDesktopMcpTarget,
  moveDesktopMcpTarget,
} from '../mcpManagementOperations';
import { pointRefsAt } from '@/lib/mcpServerRefs';
const toast = jest.fn();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof toast } => ({ addToast: toast }),
  },
}));
jest.mock('@/lib/mcpServerRefs', () => ({ pointRefsAt: jest.fn() }));
const loadAccount = jest.fn();
const saveServer = jest.fn();
const deleteServer = jest.fn();
const removeAccountConnection = jest.fn();
const connection: AccountMcpConnection = {
  id: 'cloud',
  serverKey: 'custom:cloud',
  configId: 'default',
  displayName: 'Tools',
  kind: 'CUSTOM',
  status: 'CONNECTED',
  routeId: 'route',
  enabledTools: null,
};
const data: SaveMcpServerRequest = {
  definition: {
    id: 'device',
    name: 'Tools',
    description: '',
    type: 'http',
    url: 'https://example.test',
    createdAt: '',
    updatedAt: '',
  },
  configs: [
    {
      id: 'config',
      name: 'Default',
      description: '',
      enabled: true,
      envVars: {},
      extraArgs: [],
      extraHeaders: {},
      createdAt: '',
      updatedAt: '',
    },
  ],
  accountRouting: 'clear',
};
beforeEach(() => {
  jest.resetAllMocks();
  loadAccount.mockResolvedValue({ account: { id: 'account' } });
  saveServer.mockResolvedValue({ server: data });
  removeAccountConnection.mockResolvedValue({ removed: true });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadCanopyCloudAccount: loadAccount },
  });
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: { saveServer, deleteServer, removeAccountConnection },
  });
});
it('saves the destination and moves references before removing the cloud source', async () => {
  await moveDesktopMcpTarget({
    data,
    connection,
    expectedAccountId: 'account',
  });
  expect(saveServer).toHaveBeenCalledTimes(1);
  expect(pointRefsAt).toHaveBeenCalledWith(expect.any(Array), {
    serverId: 'device',
    configId: 'config',
  });
  expect(saveServer.mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(pointRefsAt).mock.invocationCallOrder[0],
  );
  expect(jest.mocked(pointRefsAt).mock.invocationCallOrder[0]).toBeLessThan(
    removeAccountConnection.mock.invocationCallOrder[0],
  );
});
it.each(['save', 'refs'])(
  'retains the source when destination %s fails',
  async (step) => {
    if (step === 'save') saveServer.mockRejectedValue(new Error('disk full'));
    else jest.mocked(pointRefsAt).mockRejectedValue(new Error('refs failed'));
    await expect(moveDesktopMcpTarget({ data, connection })).rejects.toThrow();
    expect(removeAccountConnection).not.toHaveBeenCalled();
  },
);
it('reports partial move success when cloud removal fails', async () => {
  removeAccountConnection.mockRejectedValue(new Error('offline'));
  await expect(
    moveDesktopMcpTarget({ data, connection }),
  ).resolves.toBeUndefined();
  expect(toast).toHaveBeenCalledWith(
    expect.stringContaining('Moved to this device'),
    'error',
  );
});
it('rechecks the captured account before touching the source', async () => {
  loadAccount
    .mockResolvedValueOnce({ account: { id: 'account' } })
    .mockResolvedValue({ account: { id: 'other' } });
  await moveDesktopMcpTarget({
    data,
    connection,
    expectedAccountId: 'account',
  });
  expect(saveServer).toHaveBeenCalledTimes(1);
  expect(removeAccountConnection).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalled();
});
it('rejects a changed account before cloud deletion', async () => {
  loadAccount.mockResolvedValue({ account: { id: 'other' } });
  await expect(
    deleteDesktopMcpTarget({ connection, expectedAccountId: 'account' }),
  ).rejects.toThrow();
  expect(removeAccountConnection).not.toHaveBeenCalled();
});
it('never removes a linked cloud copy after a failed device deletion', async () => {
  deleteServer.mockRejectedValue(new Error('locked'));
  await expect(
    deleteDesktopMcpTarget({ serverId: 'device', connection }),
  ).rejects.toThrow('locked');
  expect(removeAccountConnection).not.toHaveBeenCalled();
});
it('reports an unsupported account-only removal as failure and linked removal as partial success', async () => {
  removeAccountConnection.mockResolvedValue({ removed: false });
  await expect(deleteDesktopMcpTarget({ connection })).rejects.toThrow(
    'only signed out',
  );
  await expect(
    deleteDesktopMcpTarget({ serverId: 'device', connection }),
  ).resolves.toBeUndefined();
  expect(toast).toHaveBeenCalledWith(
    expect.stringContaining('Deleted from this device'),
    'error',
  );
});
