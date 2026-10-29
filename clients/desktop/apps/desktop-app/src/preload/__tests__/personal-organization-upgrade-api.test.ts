import {
  IPC_CHANNELS,
  type PersonalOrganizationUpgradeApi,
} from '@canopy/desktop-shared/types';

type IpcRendererListener = (event: unknown, data: unknown) => void;

const exposed = new Map<string, unknown>();
const mockExposeInMainWorld = jest.fn<void, [string, unknown]>(
  (key: string, value: unknown): void => {
    exposed.set(key, value);
  },
);
const mockInvoke = jest.fn<Promise<unknown>, [string, ...unknown[]]>();
const mockOn = jest.fn<void, [string, IpcRendererListener]>();
const mockRemoveListener = jest.fn<void, [string, IpcRendererListener]>();
const mockSendSync = jest.fn<{ ollama: [] }, []>(() => ({ ollama: [] }));

jest.mock('@canopy/desktop-instrumentation/electron/preload', () => ({}));
jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    sendSync: mockSendSync,
  },
}));
jest.mock('@electron-toolkit/preload', () => ({
  electronAPI: {},
}));
jest.mock(
  '../api/bundles-api',
  (): { createBundlesAPI: () => Record<string, never> } => ({
    createBundlesAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/pipelines-api',
  (): { createPipelinesAPI: () => Record<string, never> } => ({
    createPipelinesAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/plugins-api',
  (): { createPluginsAPI: () => Record<string, never> } => ({
    createPluginsAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/mcp-servers-api',
  (): { createMcpServersAPI: () => Record<string, never> } => ({
    createMcpServersAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/skills-api',
  (): { createSkillsAPI: () => Record<string, never> } => ({
    createSkillsAPI: (): Record<string, never> => ({}),
  }),
);

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSONAL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OPERATION = {
  operationId: OPERATION_ID,
  accountId: 'account-1',
  organizationId: ORG_ID,
  selection: ['ws-1'],
  projects: [{ workspaceId: 'ws-1', stage: 'queued', outcome: 'pending' }],
  updatedAt: '2026-10-09T00:00:00.000Z',
};

function loadUpgradeApi(): PersonalOrganizationUpgradeApi {
  exposed.clear();
  jest.isolateModules((): void => {
    Object.defineProperty(process, 'contextIsolated', {
      configurable: true,
      value: true,
    });
    jest.requireActual('../index');
  });
  const api: unknown = exposed.get('api');
  if (
    typeof api !== 'object' ||
    api === null ||
    !('personalOrganizationUpgrade' in api)
  ) {
    throw new Error('preload API was not exposed');
  }
  const candidate: unknown = api.personalOrganizationUpgrade;
  if (!isUpgradeApi(candidate)) throw new Error('upgrade API missing');
  return candidate;
}

function isUpgradeApi(value: unknown): value is PersonalOrganizationUpgradeApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    'promote' in value &&
    typeof value.promote === 'function'
  );
}

describe('preload personalOrganizationUpgrade API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invokes each channel and returns validated replies', async () => {
    const api = loadUpgradeApi();
    const promotion = {
      promotion: {
        organizationId: ORG_ID,
        name: 'Acme',
        personalOrganizationId: PERSONAL_ID,
        operationId: OPERATION_ID,
        alreadyUpgraded: false,
        warnings: [],
      },
      contextSwitched: true,
      warnings: [],
    };
    mockInvoke.mockResolvedValueOnce(promotion);
    await expect(
      api.promote({
        organizationId: ORG_ID,
        name: 'Acme',
        operationId: OPERATION_ID,
      }),
    ).resolves.toEqual(promotion);
    expect(mockInvoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.personalOrganizationUpgradePromote,
      { organizationId: ORG_ID, name: 'Acme', operationId: OPERATION_ID },
    );

    mockInvoke.mockResolvedValueOnce({ status: 'sent', inviteId: PERSONAL_ID });
    await expect(
      api.invite({ organizationId: ORG_ID, invite: { email: 'a@b.co' } }),
    ).resolves.toEqual({ status: 'sent', inviteId: PERSONAL_ID });

    mockInvoke.mockResolvedValueOnce({
      projects: [{ workspaceId: 'ws-1', name: 'One', kind: 'single-repo' }],
    });
    await expect(api.listProjects()).resolves.toEqual({
      projects: [{ workspaceId: 'ws-1', name: 'One', kind: 'single-repo' }],
    });
    expect(mockInvoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.personalOrganizationUpgradeList,
    );

    mockInvoke.mockResolvedValueOnce(OPERATION);
    await expect(
      api.convert({
        operationId: OPERATION_ID,
        organizationId: ORG_ID,
        workspaceIds: ['ws-1'],
      }),
    ).resolves.toEqual(OPERATION);

    mockInvoke.mockResolvedValueOnce(null);
    await expect(api.status({ operationId: OPERATION_ID })).resolves.toBe(null);
    expect(mockInvoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.personalOrganizationUpgradeStatus,
      { operationId: OPERATION_ID },
    );
  });

  it('rejects malformed replies instead of passing them to the renderer', async () => {
    const api = loadUpgradeApi();
    mockInvoke.mockResolvedValueOnce({ status: 'delivered', inviteId: 'x' });
    await expect(
      api.invite({ organizationId: ORG_ID, invite: { email: 'a@b.co' } }),
    ).rejects.toThrow();

    mockInvoke.mockResolvedValueOnce({
      ...OPERATION,
      projects: [{ workspaceId: 'other', stage: 'queued', outcome: 'pending' }],
    });
    await expect(api.status({ operationId: OPERATION_ID })).rejects.toThrow();
  });
  it('passes the validated refusal DTO through contextBridge without throwing', async () => {
    const api = loadUpgradeApi();
    mockInvoke.mockResolvedValueOnce({
      error: 'Disabled',
      code: 'creation_disabled',
      status: 409,
    });
    await expect(
      api.promote({
        organizationId: ORG_ID,
        name: 'Acme',
        operationId: OPERATION_ID,
      }),
    ).resolves.toEqual({
      error: 'Disabled',
      code: 'creation_disabled',
      status: 409,
    });
  });
});
