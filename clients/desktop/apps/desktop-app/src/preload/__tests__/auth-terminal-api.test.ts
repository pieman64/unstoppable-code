import {
  IPC_CHANNELS,
  type CanopyApi,
  type AuthTerminalApi,
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

function isCanopyApi(value: unknown): value is CanopyApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    'authTerminal' in value &&
    typeof value.authTerminal === 'object' &&
    value.authTerminal !== null
  );
}

function loadAuthTerminalApi(): AuthTerminalApi {
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
  return api.authTerminal;
}

function registeredExitHandler(): IpcRendererListener {
  const handler = mockOn.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.authTerminalExit,
  )?.[1];
  if (typeof handler !== 'function') {
    throw new Error('auth terminal exit listener was not registered');
  }
  return handler;
}

describe('preload auth terminal exit events', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['claude', 'codex', 'github', 'opencode'])(
    'delivers %s completion and removes its listener on unsubscribe',
    (provider) => {
      const api = loadAuthTerminalApi();
      const callback = jest.fn();
      const unsubscribe = api.onExit(callback);
      const handler = registeredExitHandler();
      const event = {
        sessionId: 'auth-1',
        provider,
        exitCode: 0,
        signal: null,
      };
      handler({}, event);
      expect(callback).toHaveBeenCalledWith(event);
      unsubscribe();
      expect(mockRemoveListener).toHaveBeenCalledWith(
        IPC_CHANNELS.authTerminalExit,
        handler,
      );
    },
  );

  it('rejects unknown providers and malformed exit payloads', () => {
    const api = loadAuthTerminalApi();
    const callback = jest.fn();
    api.onExit(callback);
    const handler = registeredExitHandler();
    const event = {
      sessionId: 'auth-1',
      provider: 'opencode',
      exitCode: 0,
      signal: null,
    };
    handler({}, { ...event, provider: 'unknown' });
    handler({}, { ...event, exitCode: NaN });
    handler({}, { ...event, signal: 9 });
    handler({}, { ...event, sessionId: null });
    expect(callback).not.toHaveBeenCalled();
  });
});
