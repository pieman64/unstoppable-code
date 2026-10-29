import {
  IPC_CHANNELS,
  type CanopyApi,
  type OllamaConfigurationUpdate,
  type OllamaConnectionTestResult,
  type OllamaInstallationStatus,
  type OllamaState,
} from '@canopy/desktop-shared/types';

type IpcRendererListener = (event: unknown, data: unknown) => void;

/**
 * Exact contract string asserted across the transport/frontend/backend plans.
 * Kept as a literal here (not imported) so the test fails loudly if the
 * preload wording ever drifts. Platform-generic now that Windows is supported.
 */
const OLLAMA_DISABLED_MESSAGE = "Ollama isn't available on this platform.";

// ---------------------------------------------------------------------------
// Shared valid payload fixtures (used to exercise the strict preload validators)
// ---------------------------------------------------------------------------
const validInstallation: OllamaInstallationStatus = {
  platform: 'win32',
  ready: true,
  path: 'C:/Program Files/Ollama/ollama.exe',
  version: '0.14.0',
  source: 'auto-detected',
  checkedAt: '2026-07-14T00:00:00.000Z',
  automaticInstallSupported: true,
};
const validState: OllamaState = {
  port: 11434,
  status: 'running-external',
  models: [],
  mode: 'manual',
  installation: validInstallation,
  serverVersion: '0.14.0',
};
const validTestResult: OllamaConnectionTestResult = {
  ok: true,
  host: '127.0.0.1',
  port: 11434,
  checkedAt: '2026-07-14T00:00:00.000Z',
  latencyMs: 5,
  version: '0.14.0',
};

const exposed = new Map<string, unknown>();
const mockExposeInMainWorld = jest.fn<void, [string, unknown]>(
  (key: string, value: unknown): void => {
    exposed.set(key, value);
  },
);
const mockInvoke = jest.fn<Promise<unknown>, [string, ...unknown[]]>();
const mockOn = jest.fn<void, [string, IpcRendererListener]>();
const mockRemoveListener = jest.fn<void, [string, IpcRendererListener]>();
const mockSendSync = jest.fn<unknown, [string]>(() => ({
  claude: [],
  codex: [],
  ollama: [],
  aliases: {},
}));

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
  webUtils: {
    getPathForFile: jest.fn(() => ''),
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

function setOllamaEnabled(enabled: boolean): void {
  (globalThis as Record<string, unknown>).__CANOPY_OLLAMA_ENABLED__ = enabled;
}

function loadApi(ollamaEnabled: boolean): CanopyApi {
  exposed.clear();
  setOllamaEnabled(ollamaEnabled);
  jest.isolateModules((): void => {
    Object.defineProperty(process, 'contextIsolated', {
      configurable: true,
      value: true,
    });
    jest.requireActual('../index');
  });
  const api = exposed.get('api') as CanopyApi | undefined;
  if (!api) {
    throw new Error('preload API was not exposed');
  }
  return api;
}

function findListener(channel: string): IpcRendererListener {
  const handler = mockOn.mock.calls.find(([c]) => c === channel)?.[1];
  if (typeof handler !== 'function') {
    throw new Error(`no listener registered for ${channel}`);
  }
  return handler;
}

function setInvalidOllamaConfiguration(
  api: CanopyApi,
  update: unknown,
): unknown {
  return Reflect.apply(api.setOllamaConfiguration, api, [update]);
}

// ---------------------------------------------------------------------------
// Unsupported build (isOllamaSupportedOnPlatform() === false)
// ---------------------------------------------------------------------------
describe('preload Ollama gating (Ollama unsupported on this platform/build)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    // Restore the supported default the rest of the suite assumes.
    setOllamaEnabled(true);
  });

  it.each([
    [
      'getOllamaState',
      (api: CanopyApi): Promise<unknown> => api.getOllamaState(),
    ],
    [
      'refreshOllamaModels',
      (api: CanopyApi): Promise<unknown> => api.refreshOllamaModels(),
    ],
    [
      'pullOllamaModel',
      (api: CanopyApi): Promise<unknown> =>
        api.pullOllamaModel({ model: 'llama3' }),
    ],
    [
      'deleteOllamaModel',
      (api: CanopyApi): Promise<unknown> =>
        api.deleteOllamaModel({ model: 'llama3' }),
    ],
    [
      'setOllamaConfiguration',
      (api: CanopyApi): Promise<unknown> =>
        api.setOllamaConfiguration({ mode: 'managed', port: 11434 }),
    ],
    [
      'testOllamaConnection',
      (api: CanopyApi): Promise<unknown> => api.testOllamaConnection(11434),
    ],
    [
      'redetectOllamaInstallation',
      (api: CanopyApi): Promise<unknown> => api.redetectOllamaInstallation(),
    ],
    [
      'browseOllamaInstallation',
      (api: CanopyApi): Promise<unknown> => api.browseOllamaInstallation(),
    ],
    [
      'installOllama',
      (api: CanopyApi): Promise<unknown> => api.installOllama(),
    ],
  ] as const)(
    '%s rejects with the exact unsupported message and never hits IPC',
    async (_name, invoke) => {
      const api = loadApi(false);

      await expect(invoke(api)).rejects.toThrow(OLLAMA_DISABLED_MESSAGE);
      expect(mockInvoke).not.toHaveBeenCalled();
    },
  );

  it('no-ops the Ollama subscriptions without attaching listeners', () => {
    const api = loadApi(false);

    const unsubscribeStatus = api.onOllamaStatus(jest.fn());
    const unsubscribePull = api.onOllamaPullProgress(jest.fn());
    const unsubscribeInstall = api.onOllamaInstallProgress(jest.fn());

    expect(typeof unsubscribeStatus).toBe('function');
    expect(typeof unsubscribePull).toBe('function');
    expect(typeof unsubscribeInstall).toBe('function');
    expect(() => {
      unsubscribeStatus();
      unsubscribePull();
      unsubscribeInstall();
    }).not.toThrow();
    expect(mockOn).not.toHaveBeenCalledWith(
      IPC_CHANNELS.ollamaStatus,
      expect.any(Function),
    );
    expect(mockOn).not.toHaveBeenCalledWith(
      IPC_CHANNELS.ollamaPullProgress,
      expect.any(Function),
    );
    expect(mockOn).not.toHaveBeenCalledWith(
      IPC_CHANNELS.ollamaInstallProgress,
      expect.any(Function),
    );
  });

  it('keeps the initial Ollama model catalog empty (primary lever)', () => {
    loadApi(false);

    expect(exposed.get('ollamaModelEntries')).toEqual([]);
    // The model-registry bootstrap must be skipped entirely when disabled.
    expect(mockSendSync).not.toHaveBeenCalledWith(
      IPC_CHANNELS.modelRegistryGet,
    );
  });
});

// ---------------------------------------------------------------------------
// Supported build (isOllamaSupportedOnPlatform() === true) — Windows included
// ---------------------------------------------------------------------------
describe('preload Ollama bridges (Ollama supported on this platform/build)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    [
      'getOllamaState',
      IPC_CHANNELS.ollamaGetState,
      (api: CanopyApi): Promise<OllamaState> => api.getOllamaState(),
    ],
    [
      'redetectOllamaInstallation',
      IPC_CHANNELS.ollamaRedetectInstallation,
      (api: CanopyApi): Promise<OllamaState> =>
        api.redetectOllamaInstallation(),
    ],
    [
      'browseOllamaInstallation',
      IPC_CHANNELS.ollamaBrowseInstallation,
      (api: CanopyApi): Promise<OllamaState> => api.browseOllamaInstallation(),
    ],
    [
      'installOllama',
      IPC_CHANNELS.ollamaInstall,
      (api: CanopyApi): Promise<OllamaState> => api.installOllama(),
    ],
  ] as const)(
    '%s round-trips to %s and returns the validated OllamaState',
    async (_name, channel, call) => {
      const api = loadApi(true);
      mockInvoke.mockResolvedValueOnce(validState);

      const result = await call(api);

      expect(mockInvoke).toHaveBeenCalledWith(channel);
      expect(result).toEqual(validState);
    },
  );

  it('setOllamaConfiguration sends the update payload and validates the state', async () => {
    const api = loadApi(true);
    mockInvoke.mockResolvedValueOnce(validState);
    const update: OllamaConfigurationUpdate = { mode: 'manual', port: 11434 };

    const result = await api.setOllamaConfiguration(update);

    expect(mockInvoke).toHaveBeenCalledWith(
      IPC_CHANNELS.ollamaSetConfiguration,
      update,
    );
    expect(result).toEqual(validState);
  });

  it('testOllamaConnection sends the port and validates the result', async () => {
    const api = loadApi(true);
    mockInvoke.mockResolvedValueOnce(validTestResult);

    const result = await api.testOllamaConnection(11434);

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.ollamaTestConnection, {
      port: 11434,
    });
    expect(result).toEqual(validTestResult);
  });

  it('subscribes to Ollama status broadcasts when supported', () => {
    const api = loadApi(true);

    api.onOllamaStatus(jest.fn());

    expect(mockOn).toHaveBeenCalledWith(
      IPC_CHANNELS.ollamaStatus,
      expect.any(Function),
    );
  });

  it('drops malformed status broadcasts and forwards valid ones', () => {
    const api = loadApi(true);
    const callback = jest.fn();

    api.onOllamaStatus(callback);
    const handler = findListener(IPC_CHANNELS.ollamaStatus);
    handler({}, validState);
    // Missing the required `mode`/`installation` fields — must be dropped.
    handler({}, { port: 11434, status: 'stopped', models: [] });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(validState);
  });

  it('forwards validated install-progress events and unsubscribes cleanly', () => {
    const api = loadApi(true);
    const callback = jest.fn();

    const unsubscribe = api.onOllamaInstallProgress(callback);
    const handler = findListener(IPC_CHANNELS.ollamaInstallProgress);

    const event = {
      phase: 'downloading',
      message: 'Downloading…',
      downloadedBytes: 10,
      totalBytes: 100,
    };
    handler({}, event);
    // Malformed payloads must be dropped (serialization guard).
    handler({}, { phase: 'not-a-phase', message: 5 });
    unsubscribe();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(event);
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.ollamaInstallProgress,
      handler,
    );
  });

  it('rejects malformed OllamaState payloads from the main process', async () => {
    const api = loadApi(true);
    // Missing `mode` and `installation`.
    mockInvoke.mockResolvedValueOnce({
      port: 11434,
      status: 'stopped',
      models: [],
    });

    await expect(api.getOllamaState()).rejects.toThrow(/malformed/i);
  });

  it('rejects an OllamaState whose nested installation is malformed', async () => {
    const api = loadApi(true);
    mockInvoke.mockResolvedValueOnce({
      ...validState,
      installation: { ...validInstallation, ready: 'yes' },
    });

    await expect(api.redetectOllamaInstallation()).rejects.toThrow(
      /malformed/i,
    );
  });

  it('rejects malformed OllamaConnectionTestResult payloads', async () => {
    const api = loadApi(true);
    // Missing host/checkedAt/latencyMs.
    mockInvoke.mockResolvedValueOnce({ ok: true, port: 11434 });

    await expect(api.testOllamaConnection(11434)).rejects.toThrow(/malformed/i);
  });

  it('rejects an invalid outgoing configuration update before hitting IPC', async () => {
    const api = loadApi(true);

    await expect(
      setInvalidOllamaConfiguration(api, {
        mode: 'bogus',
        port: 11434,
      }),
    ).rejects.toThrow('Cannot send an invalid Ollama configuration update.');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('rejects fractional configuration ports before hitting IPC', async () => {
    const api = loadApi(true);

    await expect(
      setInvalidOllamaConfiguration(api, {
        mode: 'manual',
        port: 11434.5,
      }),
    ).rejects.toThrow('Cannot send an invalid Ollama configuration update.');
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('preload Git executable bridges (transport Phase T3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['getGitExecutableStatus', IPC_CHANNELS.gitExecutableStatus],
    ['redetectGitExecutable', IPC_CHANNELS.gitExecutableRedetect],
    ['browseGitExecutable', IPC_CHANNELS.gitExecutableBrowse],
    ['installGitWithWinget', IPC_CHANNELS.gitExecutableInstallWinget],
    ['installGitWithXcode', IPC_CHANNELS.gitExecutableInstallXcode],
  ] as const)('%s invokes %s', async (method, channel) => {
    const api = loadApi(true);

    await (api[method as keyof CanopyApi] as () => Promise<unknown>)();

    expect(mockInvoke).toHaveBeenCalledWith(channel);
  });

  it('forwards validated install-progress events and unsubscribes cleanly', () => {
    const api = loadApi(true);
    const callback = jest.fn();

    const unsubscribe = api.onGitInstallProgress(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.gitExecutableInstallProgress,
    )?.[1];
    if (typeof handler !== 'function') {
      throw new Error('git install-progress listener was not registered');
    }

    const event = { phase: 'running', message: 'Installing Git…' };
    handler({}, event);
    // Malformed payloads must be dropped (serialization guard).
    handler({}, { phase: 'not-a-phase', message: 5 });
    unsubscribe();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(event);
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.gitExecutableInstallProgress,
      handler,
    );
  });
});
