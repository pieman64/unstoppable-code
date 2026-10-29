import {
  IPC_CHANNELS,
  type CanopyApi,
  type WorkspaceContextApi,
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
const VALID_STATE = {
  context: { kind: 'organization', organizationId: ORG_ID },
  revision: 3,
  organizations: [{ id: ORG_ID, name: 'Acme', role: 'MEMBER' }],
};

function isCanopyApi(value: unknown): value is CanopyApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    'workspaceContext' in value &&
    typeof value.workspaceContext === 'object' &&
    value.workspaceContext !== null
  );
}

function loadApi(): CanopyApi {
  exposed.clear();
  jest.isolateModules((): void => {
    Object.defineProperty(process, 'contextIsolated', {
      configurable: true,
      value: true,
    });
    jest.requireActual('../index');
  });
  const api: unknown = exposed.get('api');
  if (!isCanopyApi(api)) {
    throw new Error('preload API was not exposed');
  }
  return api;
}

function loadWorkspaceContextApi(): WorkspaceContextApi {
  return loadApi().workspaceContext;
}

function registeredChangedHandler(): IpcRendererListener {
  const handler = mockOn.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.workspaceContextChanged,
  )?.[1];
  if (typeof handler !== 'function') {
    throw new Error('workspace-context:changed listener was not registered');
  }
  return handler;
}

describe('preload workspaceContext API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns validated state from get and set', async () => {
    const workspaceContext = loadWorkspaceContextApi();
    mockInvoke.mockResolvedValue(VALID_STATE);

    await expect(workspaceContext.get()).resolves.toEqual(VALID_STATE);
    await expect(
      workspaceContext.set({
        context: { kind: 'personal' },
        expectedRevision: 3,
      }),
    ).resolves.toEqual(VALID_STATE);

    expect(mockInvoke).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.workspaceContextGet,
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.workspaceContextSet,
      { context: { kind: 'personal' }, expectedRevision: 3 },
    );
  });

  it('rejects malformed invoke replies instead of passing them to the renderer', async () => {
    const workspaceContext = loadWorkspaceContextApi();
    mockInvoke.mockResolvedValueOnce({ ...VALID_STATE, revision: -1 });
    await expect(workspaceContext.get()).rejects.toThrow(
      /Malformed workspace context reply/,
    );

    mockInvoke.mockResolvedValueOnce({ context: { kind: 'nope' } });
    await expect(
      workspaceContext.set({ context: { kind: 'personal' } }),
    ).rejects.toThrow(/Malformed workspace context reply/);
  });

  it('delivers broadcasts only with a known reason and removes the exact listener', () => {
    const workspaceContext = loadWorkspaceContextApi();
    const callback = jest.fn();
    const unsubscribe = workspaceContext.onChanged(callback);
    const handler = registeredChangedHandler();

    handler(undefined, { ...VALID_STATE, reason: 'switch' });
    handler(undefined, { ...VALID_STATE, reason: 'made-up' });
    handler(undefined, { ...VALID_STATE });
    handler(undefined, { reason: 'switch' });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ ...VALID_STATE, reason: 'switch' });

    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceContextChanged,
      handler,
    );
  });
});
