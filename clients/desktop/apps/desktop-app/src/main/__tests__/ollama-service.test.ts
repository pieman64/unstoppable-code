import { EventEmitter } from 'node:events';
import { OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE } from '@canopy/desktop-shared/types';
import type * as DesktopSharedTypes from '@canopy/desktop-shared/types';
import type { ProviderConnectionEvent } from '../lib/provider-connection-events';

const readFileMock = jest.fn();
const writeFileMock = jest.fn();
const mkdirMock = jest.fn();
interface SpawnCallOptions {
  env?: NodeJS.ProcessEnv;
  stdio?: [string, string, string];
  windowsHide?: boolean;
}
const spawnMock = jest.fn<
  MockChildProcess,
  [string, string[], SpawnCallOptions]
>();
const readOllamaPreferencesMock = jest.fn();
const readOllamaServerPortPreferenceMock = jest.fn();
const writeOllamaServerPortPreferenceMock = jest.fn();
const writeOllamaConfigurationPreferenceMock = jest.fn();
const getEnhancedEnvMock = jest.fn<Record<string, string>, []>(() => ({
  PATH: '/mock/bin',
}));
const detectOllamaInstallationMock = jest.fn();
const validateOllamaExecutableMock = jest.fn();
const installOllamaMock = jest.fn();
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();

const listMock = jest.fn();
const pullMock = jest.fn();
const deleteMock = jest.fn();
const showMock = jest.fn();

jest.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
  mkdir: mkdirMock,
}));

jest.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation(() => ({
    list: listMock,
    pull: pullMock,
    delete: deleteMock,
    show: showMock,
  })),
}));

jest.mock('@canopy/desktop-shared/types', () => {
  const actual = jest.requireActual<typeof DesktopSharedTypes>(
    '@canopy/desktop-shared/types',
  );
  return {
    ...actual,
    initOllamaModels: jest.fn(),
  };
});

jest.mock('../ollama/preferences', () => ({
  readOllamaPreferences: readOllamaPreferencesMock,
  readOllamaServerPortPreference: readOllamaServerPortPreferenceMock,
  writeOllamaServerPortPreference: writeOllamaServerPortPreferenceMock,
  writeOllamaConfigurationPreference: writeOllamaConfigurationPreferenceMock,
}));

jest.mock('../ollama/installation', () => ({
  cleanupOllamaInstallationWork: jest.fn(() => Promise.resolve()),
  createUnavailableOllamaInstallationStatus: jest.fn((error?: string) => ({
    platform: process.platform,
    ready: false,
    path: null,
    version: null,
    source: 'not-found',
    checkedAt: '2026-07-14T00:00:00.000Z',
    automaticInstallSupported: true,
    ...(error ? { error } : {}),
  })),
  detectOllamaInstallation: detectOllamaInstallationMock,
  installOllama: installOllamaMock,
  validateOllamaExecutable: validateOllamaExecutableMock,
}));

jest.mock('../lib/paths', () => ({
  getOllamaModelCacheFilePath: jest.fn(
    () => '/mock/userData/ollama-model-cache.json',
  ),
}));

jest.mock('../pipelines/config-paths', () => ({
  getEnhancedEnv: getEnhancedEnvMock,
}));

class MockChildProcess extends EventEmitter {
  killed = false;
  stderr = new EventEmitter();
  kill = jest.fn((signal?: NodeJS.Signals): boolean => {
    this.killed = true;
    this.emit('exit', 0, signal ?? null);
    return true;
  });
}

function createMockChildProcess(): MockChildProcess {
  return new MockChildProcess();
}

function versionResponse(version: string): Response {
  return new Response(JSON.stringify({ version }));
}

function mockServerVersion(version: string): void {
  fetchMock.mockImplementation(() => Promise.resolve(versionResponse(version)));
}

function showResponse(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    license: '',
    modelfile: 'FROM llama3',
    parameters: 'temperature 0.7',
    template: '{{ .Prompt }}',
    system: 'You are helpful.',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '8B',
      quantization_level: 'Q4_K_M',
    },
    messages: [],
    modified_at: '2026-04-06T12:34:56.000Z',
    model_info: { context_length: 8192 },
    capabilities: ['completion', 'chat'],
    ...overrides,
  };
}

function makePullStream(
  items: Array<{
    status: string;
    digest?: string;
    total?: number;
    completed?: number;
  }>,
): AsyncIterable<{
  status: string;
  digest?: string;
  total: number;
  completed: number;
}> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<{
      status: string;
      digest?: string;
      total: number;
      completed: number;
    }> {
      for (const item of items) {
        await Promise.resolve();
        yield {
          status: item.status,
          ...(item.digest !== undefined ? { digest: item.digest } : {}),
          total: item.total ?? 0,
          completed: item.completed ?? 0,
        };
      }
    },
  };
}

describe('ollama service', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
    readOllamaPreferencesMock.mockResolvedValue({
      mode: 'managed',
      port: 11534,
      executablePath: '/mock/bin/ollama',
    });
    readOllamaServerPortPreferenceMock.mockResolvedValue(11534);
    writeOllamaServerPortPreferenceMock.mockResolvedValue(undefined);
    writeOllamaConfigurationPreferenceMock.mockResolvedValue(undefined);
    detectOllamaInstallationMock.mockResolvedValue({
      platform: process.platform,
      ready: true,
      path: '/mock/bin/ollama',
      version: '0.14.0',
      source: 'persisted',
      checkedAt: '2026-07-14T00:00:00.000Z',
      automaticInstallSupported: true,
    });
    validateOllamaExecutableMock.mockResolvedValue({
      platform: process.platform,
      ready: true,
      path: '/mock/bin/ollama',
      version: '0.14.0',
      source: 'browse',
      checkedAt: '2026-07-14T00:00:00.000Z',
      automaticInstallSupported: true,
    });
    installOllamaMock.mockResolvedValue({
      platform: process.platform,
      ready: true,
      path: '/mock/bin/ollama',
      version: '0.14.0',
      source: 'installed',
      checkedAt: '2026-07-14T00:00:00.000Z',
      automaticInstallSupported: true,
    });
    readFileMock.mockRejectedValue(new Error('ENOENT'));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    listMock.mockResolvedValue({ models: [] });
    pullMock.mockResolvedValue(makePullStream([]));
    deleteMock.mockResolvedValue({ status: 'success' });
    showMock.mockResolvedValue(showResponse());
  });

  it('registers cached models before persisting an auto-detected executable', async () => {
    readOllamaPreferencesMock.mockResolvedValueOnce({
      mode: 'managed',
      port: 11534,
      executablePath: '',
    });
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        byPort: {
          '11534': {
            refreshedAt: '2026-09-03T00:00:00.000Z',
            models: [
              {
                id: 'ollama-qwen3-coder',
                rawModelId: 'qwen3-coder',
                label: 'qwen3-coder',
                show: { capabilities: ['completion', 'tools'] },
              },
            ],
          },
        },
      }),
    );

    const { getOllamaService } = await import('../ollama/service');
    const { initOllamaModels } = await import('@canopy/desktop-shared/types');
    const currentInitOllamaModelsMock = jest.mocked(initOllamaModels);
    await getOllamaService().initialize();

    expect(detectOllamaInstallationMock).toHaveBeenCalledWith({
      force: true,
      persistedPath: '',
      persistDetectedPath: false,
    });
    expect(currentInitOllamaModelsMock).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'ollama-qwen3-coder' }),
    ]);
    expect(writeOllamaConfigurationPreferenceMock).toHaveBeenCalledWith({
      executablePath: '/mock/bin/ollama',
    });
    expect(
      currentInitOllamaModelsMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      writeOllamaConfigurationPreferenceMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('writes no preferences when detection finds the stored executable', async () => {
    const { getOllamaService } = await import('../ollama/service');
    await getOllamaService().initialize();

    expect(detectOllamaInstallationMock).toHaveBeenCalledWith(
      expect.objectContaining({ persistedPath: '/mock/bin/ollama' }),
    );
    expect(writeOllamaConfigurationPreferenceMock).not.toHaveBeenCalled();
  });

  it('shares initialization with a configuration save so a late startup read cannot restore the old port', async () => {
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const detectionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    detectOllamaInstallationMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void =>
            resolve({
              platform: process.platform,
              ready: true,
              path: '/mock/bin/ollama',
              version: '0.14.0',
              source: 'persisted',
              checkedAt: '2026-10-28T00:00:00Z',
              automaticInstallSupported: true,
            });
          started();
        }),
    );
    const initialization = service.initialize();
    await detectionStarted;
    const changingPort = service.setPort(11535);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([initialization, changingPort]);
    expect(detectOllamaInstallationMock).toHaveBeenCalledTimes(2);
    expect(await service.getState()).toMatchObject({ port: 11535 });
  });

  it('does not run a superseded refresh against setup committed during initialization', async () => {
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const detectionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    detectOllamaInstallationMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void =>
            resolve({
              platform: process.platform,
              ready: true,
              path: '/mock/bin/ollama',
              version: '0.14.0',
              source: 'persisted',
              checkedAt: '2026-10-28T00:00:00Z',
              automaticInstallSupported: true,
            });
          started();
        }),
    );
    mockServerVersion('0.14.0');
    const refresh = service.refreshModels({ allowStart: true });
    await detectionStarted;
    const changingPort = service.setPort(11535);
    release();
    await Promise.all([refresh, changingPort]);
    expect(await service.getState()).toMatchObject({ port: 11535 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('allows initialization to retry after a failed installation read', async () => {
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    const failure = new Error('Installation read failed');
    detectOllamaInstallationMock.mockRejectedValueOnce(failure);
    await expect(service.initialize()).rejects.toBe(failure);
    await expect(service.initialize()).resolves.toBeUndefined();
    expect(await service.getState()).toMatchObject({
      port: 11534,
      installation: { ready: true },
    });
  });

  it('preserves the saved mode when a legacy port update initializes the service', async () => {
    readOllamaPreferencesMock.mockResolvedValueOnce({
      mode: 'manual',
      port: 11534,
      executablePath: '',
    });
    const { getOllamaService } = await import('../ollama/service');
    expect(await getOllamaService().setPort(11535)).toMatchObject({
      mode: 'manual',
      port: 11535,
    });
  });

  it('applies a queued legacy port update to the mode committed ahead of it', async () => {
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.initialize();
    const modeChange = service.setConfiguration({
      mode: 'manual',
      port: 11534,
    });
    const portChange = service.setPort(11535);
    await Promise.all([modeChange, portChange]);
    expect(await service.getState()).toMatchObject({
      mode: 'manual',
      port: 11535,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('loads cached models by port and switches caches immediately on port change', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        version: 1,
        byPort: {
          '11534': {
            refreshedAt: '2026-04-06T12:00:00.000Z',
            models: [
              {
                id: 'ollama-qwen3-coder',
                rawModelId: 'qwen3-coder',
                label: 'qwen3-coder',
              },
            ],
          },
          '11535': {
            refreshedAt: '2026-04-06T12:05:00.000Z',
            models: [
              {
                id: 'ollama-llama3:8b',
                rawModelId: 'llama3:8b',
                label: 'llama3:8b',
              },
            ],
          },
        },
      }),
    );

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    expect(await service.getState()).toMatchObject({
      port: 11534,
      models: [{ id: 'ollama-qwen3-coder' }],
      refreshedAt: '2026-04-06T12:00:00.000Z',
    });

    const nextState = await service.setPort(11535);
    expect(writeOllamaConfigurationPreferenceMock).toHaveBeenCalledWith({
      mode: 'managed',
      port: 11535,
    });
    expect(nextState).toMatchObject({
      port: 11535,
      status: 'stopped',
      models: [{ id: 'ollama-llama3:8b' }],
      refreshedAt: '2026-04-06T12:05:00.000Z',
    });
  });

  it('detects an externally managed server without spawning ollama serve', async () => {
    mockServerVersion('0.14.0');

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');

    expect(spawnMock).not.toHaveBeenCalled();
    expect(await service.getState()).toMatchObject({
      status: 'running-external',
    });
  });

  it('connects in manual mode when the configured localhost server is reachable without spawning', async () => {
    readOllamaPreferencesMock.mockResolvedValueOnce({
      mode: 'manual',
      port: 11534,
      executablePath: '',
    });
    mockServerVersion('0.14.0');

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');

    expect(spawnMock).not.toHaveBeenCalled();
    expect(await service.getState()).toMatchObject({
      mode: 'manual',
      status: 'running-external',
    });
  });

  it('does not mistake an unrelated HTTP service for an Ollama server', async () => {
    readOllamaPreferencesMock.mockResolvedValueOnce({
      mode: 'manual',
      port: 11534,
      executablePath: '',
    });
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}')));

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();

    await expect(service.ensureServerRunning('chat')).rejects.toMatchObject({
      code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fails in manual mode when the configured localhost server is unreachable without spawning', async () => {
    readOllamaPreferencesMock.mockResolvedValueOnce({
      mode: 'manual',
      port: 11534,
      executablePath: '',
    });
    fetchMock.mockRejectedValue(new Error('offline'));

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();

    const error: unknown = await service
      .ensureServerRunning('chat')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'OllamaServerUnavailableError',
      code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
    });
    if (!(error instanceof Error)) {
      throw new Error('Expected an Ollama startup error');
    }
    expect(error.message).toMatch(/Start the Ollama server externally/i);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(await service.getState()).toMatchObject({
      mode: 'manual',
      status: 'error',
    });
  });

  it('reports an unsuccessful runtime installation without claiming a connection', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    const unavailable = {
      platform: process.platform,
      ready: false,
      path: null,
      version: null,
      source: 'not-found',
      checkedAt: '2026-10-27T00:00:00.000Z',
      automaticInstallSupported: true,
      error: 'private installer detail',
    };
    detectOllamaInstallationMock.mockResolvedValue(unavailable);
    installOllamaMock.mockResolvedValue(unavailable);
    const { getOllamaService } = await import('../ollama/service');
    await expect(getOllamaService().install()).resolves.toMatchObject({
      installation: { ready: false },
    });
    expect(connection).toHaveBeenCalledTimes(1);
    expect(connection).toHaveBeenCalledWith({
      provider: 'ollama',
      connectionMethod: 'local',
      connectSource: 'in_app',
      failureReason: 'runtime_unavailable',
    });
    stop();
  });

  it('baselines an unchanged running server on the first interactive refresh without startup probes', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    mockServerVersion('0.14.0');
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    expect(fetchMock).not.toHaveBeenCalled();
    await service.refreshModels({ allowStart: true });
    await service.refreshModels({ allowStart: true });

    expect(connection.mock.calls).toEqual([
      [
        {
          provider: 'ollama',
          connectionMethod: 'local',
          connectSource: 'at_startup',
        },
      ],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).not.toHaveBeenCalled();
    stop();
  });

  it.each([undefined, 11534])(
    'baselines a saved server on the first initialized connection test (%s)',
    async (port) => {
      const events = await import('../lib/provider-connection-events');
      const connection = jest.fn<void, [ProviderConnectionEvent]>();
      const stop = events.subscribeProviderConnections(connection);
      mockServerVersion('0.14.0');
      const { getOllamaService } = await import('../ollama/service');
      const service = getOllamaService();

      await service.initialize();
      await service.testConnection(port);
      await service.testConnection(port);
      await service.refreshModels({ allowStart: true });

      expect(connection.mock.calls).toEqual([
        [
          {
            provider: 'ollama',
            connectionMethod: 'local',
            connectSource: 'at_startup',
          },
        ],
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      stop();
    },
  );

  it.each([undefined, 11534])(
    'discards a pending connection test (%s) across configuration changes, including a return to the original port',
    async (port) => {
      const events = await import('../lib/provider-connection-events');
      const connection = jest.fn<void, [ProviderConnectionEvent]>();
      const stop = events.subscribeProviderConnections(connection);
      mockServerVersion('0.14.0');
      const { getOllamaService } = await import('../ollama/service');
      const service = getOllamaService();
      await service.initialize();
      await service.testConnection();
      connection.mockClear();
      let release: (value: Response) => void = () => {
        throw new Error('Expected a pending probe');
      };
      let started: () => void = () => {};
      const probeStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
            started();
          }),
      );
      const pending = service.testConnection(port);
      await probeStarted;
      await service.setPort(11535);
      await service.testConnection();
      release(versionResponse('0.14.0'));
      await pending;
      await service.testConnection();
      expect(
        connection.mock.calls.map(([event]) => event.connectSource),
      ).toEqual(['in_app']);

      // A port comparison alone cannot fence an A -> B -> A configuration.
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
            started();
          }),
      );
      const stale = service.testConnection();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await service.setPort(11534);
      await service.setPort(11535);
      await service.testConnection();
      release(new Response('{}'));
      await stale;
      await service.testConnection();
      expect(
        connection.mock.calls.map(([event]) => event.connectSource),
      ).toEqual(['in_app']);
      stop();
    },
  );

  it.each(['chat', 'helper', 'pipeline'] as const)(
    'baselines an automatic managed %s start without a funnel connection on each launch',
    async (reason) => {
      const connection = jest.fn<void, [ProviderConnectionEvent]>();
      for (let launch = 0; launch < 2; launch += 1) {
        jest.resetModules();
        const events = await import('../lib/provider-connection-events');
        const { getOllamaService } = await import('../ollama/service');
        const service = getOllamaService();
        const unsubscribe = events.subscribeProviderConnections(connection);
        fetchMock
          .mockRejectedValueOnce(new Error('offline'))
          .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
        spawnMock.mockReturnValue(createMockChildProcess());
        await service.ensureServerRunning(reason);
        await service.refreshModels();
        await service.testConnection();
        await service.shutdown('app-quit');
        unsubscribe();
      }
      expect(
        connection.mock.calls.map(([event]) => event.connectSource),
      ).toEqual(['at_startup', 'at_startup']);
    },
  );

  it.each([
    'redetect',
    'unchanged-save',
    'invalid-browse',
    'already-installed',
  ] as const)(
    'does not cancel an automatic start when %s leaves configuration unchanged',
    async (action) => {
      const events = await import('../lib/provider-connection-events');
      const connection = jest.fn<void, [ProviderConnectionEvent]>();
      const stop = events.subscribeProviderConnections(connection);
      let release: (response: Response) => void = () => {};
      let started: () => void = () => {};
      const readinessStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      fetchMock
        .mockRejectedValueOnce(new Error('offline'))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              release = resolve;
              started();
            }),
        );
      const child = createMockChildProcess();
      spawnMock.mockReturnValue(child);
      const { getOllamaService } = await import('../ollama/service');
      const service = getOllamaService();
      const startup = service.ensureServerRunning('chat').then(
        () => null,
        (error: unknown) => error,
      );
      await readinessStarted;
      if (action === 'redetect') await service.redetectInstallation();
      else if (action === 'unchanged-save')
        await service.setConfiguration({ mode: 'managed', port: 11534 });
      else if (action === 'already-installed') await service.install();
      else {
        validateOllamaExecutableMock.mockResolvedValueOnce({
          ready: false,
          path: null,
          error: 'Invalid executable',
        });
        await service.setExecutablePath('/mock/invalid');
      }
      release(versionResponse('0.14.0'));
      const outcome = await startup;
      const killedBeforeQuit = child.kill.mock.calls.length;
      await service.shutdown('app-quit');
      expect(outcome).toBeNull();
      expect(killedBeforeQuit).toBe(0);
      expect(
        connection.mock.calls.map(([event]) => event.connectSource),
      ).toEqual(['at_startup']);
      stop();
    },
  );

  it('keeps committed setup attributed in-app when chat first confirms the new endpoint', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.setPort(11535);
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
    spawnMock.mockReturnValue(createMockChildProcess());
    await service.ensureServerRunning('chat');
    await service.refreshModels();
    await service.testConnection();
    expect(connection.mock.calls.map(([event]) => event.connectSource)).toEqual(
      ['in_app'],
    );
    await service.shutdown('app-quit');
    stop();
  });

  it('does not publish an old model refresh as a connection to the new port', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    mockServerVersion('0.14.0');
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.initialize();
    await service.testConnection();
    connection.mockClear();
    let release: () => void = () => {
      throw new Error('Expected pending models');
    };
    let started: () => void = () => {};
    const listStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    listMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void =>
            resolve({
              models: [{ name: 'stale-model', model: 'stale-model' }],
            });
          started();
        }),
    );
    const refresh = service.refreshModels({ allowStart: true });
    await listStarted;
    await service.setPort(11535);
    release();
    await refresh;
    expect(connection).not.toHaveBeenCalled();
    expect(await service.getState()).toMatchObject({
      port: 11535,
      models: [],
      status: 'stopped',
    });
    expect(service.getCachedModels()).toEqual([]);
    await service.testConnection();
    expect(connection.mock.calls.map(([event]) => event.connectSource)).toEqual(
      ['in_app'],
    );
    stop();
  });

  it.each(['probe', 'models'] as const)(
    'discards a stale %s failure after configuration changes',
    async (stage) => {
      const events = await import('../lib/provider-connection-events');
      const connection = jest.fn<void, [ProviderConnectionEvent]>();
      const stop = events.subscribeProviderConnections(connection);
      mockServerVersion('0.14.0');
      const { getOllamaService } = await import('../ollama/service');
      const service = getOllamaService();
      await service.initialize();
      await service.testConnection();
      connection.mockClear();
      let rejectOperation: (error: Error) => void = () => {};
      let started: () => void = () => {};
      const operationStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const deferred = (): Promise<never> =>
        new Promise((_resolve, reject) => {
          rejectOperation = reject;
          started();
        });
      if (stage === 'probe') fetchMock.mockImplementationOnce(deferred);
      else listMock.mockImplementationOnce(deferred);
      const pending =
        stage === 'probe'
          ? service.testConnection()
          : service.refreshModels({ allowStart: true });
      const outcome = pending.catch((error: unknown) => error);
      await operationStarted;
      await service.setPort(11535);
      const failure = new Error('old endpoint failed');
      rejectOperation(failure);
      if (stage === 'models') expect(await outcome).toBe(failure);
      else expect(await outcome).toMatchObject({ ok: false, port: 11534 });
      expect(connection).not.toHaveBeenCalled();
      stop();
    },
  );

  it('still reports a failing explicit draft-port test without changing the saved baseline', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    mockServerVersion('0.14.0');
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.initialize();
    await service.testConnection();
    connection.mockClear();
    fetchMock.mockRejectedValueOnce(new Error('draft unreachable'));
    await expect(service.testConnection(11535)).resolves.toMatchObject({
      ok: false,
      port: 11535,
    });
    await service.testConnection();
    expect(connection.mock.calls).toEqual([
      [
        {
          provider: 'ollama',
          connectionMethod: 'local',
          connectSource: 'in_app',
          failureReason: 'network',
        },
      ],
    ]);
    stop();
  });

  it('preserves a stale preferences-read rejection without publishing a setup failure', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    let rejectRead: (error: Error) => void = () => {};
    let started: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    readOllamaPreferencesMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
          started();
        }),
    );
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    const pending = service.testConnection().catch((error: unknown) => error);
    await readStarted;
    await service.setPort(11535);
    const failure = new Error('Could not read preferences');
    rejectRead(failure);
    expect(await pending).toBe(failure);
    expect(connection).not.toHaveBeenCalled();
    stop();
  });

  it('attributes a committed manual endpoint confirmed by a chat read to in-app', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    mockServerVersion('0.14.0');
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.initialize();
    await service.testConnection();
    connection.mockClear();
    await service.setConfiguration({ mode: 'manual', port: 11535 });
    listMock.mockResolvedValue({ models: [{ model: 'llama3:8b' }] });
    showMock.mockResolvedValue(
      showResponse({ capabilities: ['completion', 'tools'] }),
    );
    await service.ensureServerRunning('chat');
    await service.assertInstalled('llama3:8b');
    expect(connection.mock.calls.map(([event]) => event.connectSource)).toEqual(
      ['in_app'],
    );
    stop();
  });

  it('does not start or update the new endpoint from a stale unreachable refresh', async () => {
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.initialize();
    let release: (value: Response) => void = () => {};
    let started: () => void = () => {};
    const probeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
          started();
        }),
    );
    const refresh = service.refreshModels({ allowStart: true });
    await probeStarted;
    await service.setPort(11535);
    mockServerVersion('0.14.0');
    release(new Response('{}'));
    await refresh;
    expect(await service.getState()).toMatchObject({
      port: 11535,
      status: 'stopped',
      models: [],
    });
    expect(listMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not report a cancelled settings start overtaken by a port change', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    let started: () => void = () => {};
    const startupProbe = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
            started();
          }),
      );
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    const refresh = service
      .refreshModels({ allowStart: true })
      .catch((error: unknown) => error);
    await startupProbe;
    await service.setPort(11535);
    expect(await refresh).toBeInstanceOf(Error);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(connection).not.toHaveBeenCalled();
    stop();
  });

  it('counts changed runtime setup on an already-baselined port once', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    mockServerVersion('0.14.0');
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.initialize();
    await service.testConnection();
    connection.mockClear();
    validateOllamaExecutableMock.mockResolvedValueOnce({
      platform: process.platform,
      ready: true,
      path: '/mock/bin/new-ollama',
      version: '0.14.0',
      source: 'browse',
      checkedAt: '2026-10-28T00:00:00Z',
      automaticInstallSupported: true,
    });
    await service.setExecutablePath('/mock/bin/new-ollama');
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
    spawnMock.mockReturnValue(createMockChildProcess());
    await service.ensureServerRunning('chat');
    await service.refreshModels();
    await service.testConnection();
    expect(connection.mock.calls.map(([event]) => event.connectSource)).toEqual(
      ['in_app'],
    );
    await service.shutdown('app-quit');
    stop();
  });

  it('does not retain an old endpoint version after a configuration change', async () => {
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.initialize();
    let release: (response: Response) => void = () => {};
    let started: () => void = () => {};
    const probeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
          started();
        }),
    );
    const assertion = service
      .assertResponsesCompatibleApi()
      .catch((error: unknown) => error);
    await probeStarted;
    await service.setPort(11535);
    release(versionResponse('0.14.0'));
    expect(await assertion).toBeInstanceOf(Error);
    mockServerVersion('0.1.0');
    await expect(service.assertResponsesCompatibleApi()).rejects.toThrow(
      /Upgrade Ollama/,
    );
  });

  it('waits for committed configuration before starting a new server', async () => {
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.initialize();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const detectionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    detectOllamaInstallationMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void =>
            resolve({
              platform: process.platform,
              ready: true,
              path: '/mock/bin/ollama',
              version: '0.14.0',
              source: 'persisted',
              checkedAt: '2026-10-28T00:00:00Z',
              automaticInstallSupported: true,
            });
          started();
        }),
    );
    const changingPort = service.setPort(11535);
    await detectionStarted;
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const demand = service.ensureServerRunning('chat');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const startsDuringSave = spawnMock.mock.calls.length;
    release();
    await changingPort;
    await demand;
    expect(startsDuringSave).toBe(0);
    expect(spawnMock.mock.calls[0]?.[2].env?.OLLAMA_HOST).toBe(
      '127.0.0.1:11535',
    );
    expect(await service.getState()).toMatchObject({
      port: 11535,
      status: 'running-managed',
    });
    await service.shutdown('app-quit');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not consume pending setup from a probe started during the next save', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.setPort(11535);
    let release: () => void = () => {};
    let started: () => void = () => {};
    const detectionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    detectOllamaInstallationMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void =>
            resolve({
              platform: process.platform,
              ready: true,
              path: '/mock/bin/ollama',
              version: '0.14.0',
              source: 'persisted',
              checkedAt: '2026-10-28T00:00:00Z',
              automaticInstallSupported: true,
            });
          started();
        }),
    );
    mockServerVersion('0.14.0');
    const changingPort = service.setPort(11536);
    await detectionStarted;
    const probe = service.testConnection();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const probesDuringSave = fetchMock.mock.calls.length;
    release();
    await changingPort;
    await probe;
    await service.testConnection();
    expect(probesDuringSave).toBe(0);
    expect(connection.mock.calls.map(([event]) => event.connectSource)).toEqual(
      ['in_app'],
    );
    stop();
  });

  it('counts a managed server started by interactive refresh once as an in-app connection', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
    spawnMock.mockReturnValue(createMockChildProcess());
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.refreshModels({ allowStart: true });
    await service.refreshModels({ allowStart: true });
    await service.testConnection();

    expect(connection.mock.calls).toEqual([
      [
        {
          provider: 'ollama',
          connectionMethod: 'local',
          connectSource: 'in_app',
        },
      ],
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await service.shutdown('app-quit');
    stop();
  });

  it.each(['pull', 'delete'] as const)(
    'attributes a managed start from %s to in-app once before later reads',
    async (action) => {
      const events = await import('../lib/provider-connection-events');
      const connection = jest.fn<void, [ProviderConnectionEvent]>();
      const stop = events.subscribeProviderConnections(connection);
      fetchMock
        .mockRejectedValueOnce(new Error('offline'))
        .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
      spawnMock.mockReturnValue(createMockChildProcess());
      const { getOllamaService } = await import('../ollama/service');
      const service = getOllamaService();

      if (action === 'pull') await service.pullModel('llama3:8b');
      else await service.deleteModel('llama3:8b');
      await service.refreshModels();
      await service.testConnection();

      expect(connection.mock.calls).toEqual([
        [
          {
            provider: 'ollama',
            connectionMethod: 'local',
            connectSource: 'in_app',
          },
        ],
      ]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(action === 'pull' ? pullMock : deleteMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'llama3:8b' }),
      );
      await service.shutdown('app-quit');
      stop();
    },
  );

  it.each([
    ['pull', 'manual', 'network'],
    ['delete', 'manual', 'network'],
    ['refresh', 'manual', 'network'],
    ['pull', 'managed', 'runtime_unavailable'],
    ['delete', 'managed', 'runtime_unavailable'],
    ['refresh', 'managed', 'runtime_unavailable'],
  ] as const)(
    'reports exactly one %s startup failure in %s mode',
    async (action, mode, failureReason) => {
      const events = await import('../lib/provider-connection-events');
      const connection = jest.fn<void, [ProviderConnectionEvent]>();
      const stop = events.subscribeProviderConnections(connection);
      readOllamaPreferencesMock.mockResolvedValue({
        mode,
        port: 11534,
        executablePath: '',
      });
      detectOllamaInstallationMock.mockResolvedValue({
        platform: process.platform,
        ready: false,
        path: null,
        version: null,
        source: 'not-found',
        checkedAt: '2026-07-14T00:00:00.000Z',
        automaticInstallSupported: true,
      });
      fetchMock.mockRejectedValue(new Error('fetch failed'));
      const { getOllamaService } = await import('../ollama/service');
      const service = getOllamaService();
      const attempt =
        action === 'pull'
          ? service.pullModel('llama3:8b')
          : action === 'delete'
            ? service.deleteModel('llama3:8b')
            : service.refreshModels({ allowStart: true });

      await expect(attempt).rejects.toMatchObject({
        code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
      });
      expect(connection.mock.calls).toEqual([
        [
          {
            provider: 'ollama',
            connectionMethod: 'local',
            connectSource: 'in_app',
            failureReason,
          },
        ],
      ]);
      expect(pullMock).not.toHaveBeenCalled();
      expect(deleteMock).not.toHaveBeenCalled();
      stop();
    },
  );

  it.each(['pull', 'delete', 'refresh'] as const)(
    'preserves the native missing-executable category for %s startup',
    async (action) => {
      const events = await import('../lib/provider-connection-events');
      const connection = jest.fn<void, [ProviderConnectionEvent]>();
      const stop = events.subscribeProviderConnections(connection);
      fetchMock.mockRejectedValue(new Error('fetch failed'));
      const missing = Object.assign(
        new Error('spawn /mock/bin/ollama ENOENT'),
        { code: 'ENOENT' },
      );
      spawnMock.mockImplementationOnce(() => {
        throw missing;
      });
      const { getOllamaService } = await import('../ollama/service');
      const service = getOllamaService();

      await expect(
        action === 'pull'
          ? service.pullModel('llama3:8b')
          : action === 'delete'
            ? service.deleteModel('llama3:8b')
            : service.refreshModels({ allowStart: true }),
      ).rejects.toMatchObject({ code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE });
      expect(connection.mock.calls).toEqual([
        [
          {
            provider: 'ollama',
            connectionMethod: 'local',
            connectSource: 'in_app',
            failureReason: 'runtime_unavailable',
          },
        ],
      ]);
      stop();
    },
  );

  it.each(['pull', 'delete'] as const)(
    'does not classify a %s model-operation failure as a connection failure',
    async (action) => {
      const events = await import('../lib/provider-connection-events');
      const connection = jest.fn<void, [ProviderConnectionEvent]>();
      const stop = events.subscribeProviderConnections(connection);
      mockServerVersion('0.14.0');
      const { getOllamaService } = await import('../ollama/service');
      const service = getOllamaService();
      await service.refreshModels();
      connection.mockClear();
      const failure = new Error('model is not available');
      (action === 'pull' ? pullMock : deleteMock).mockRejectedValueOnce(
        failure,
      );

      await expect(
        action === 'pull'
          ? service.pullModel('missing-model')
          : service.deleteModel('missing-model'),
      ).rejects.toBe(failure);
      expect(connection).not.toHaveBeenCalled();
      stop();
    },
  );

  it.each(['refresh', 'test'] as const)(
    'counts a saved port change before any probe as in-app on %s',
    async (action) => {
      const events = await import('../lib/provider-connection-events');
      const connection = jest.fn<void, [ProviderConnectionEvent]>();
      const stop = events.subscribeProviderConnections(connection);
      mockServerVersion('0.14.0');
      const { getOllamaService } = await import('../ollama/service');
      const service = getOllamaService();

      await service.setPort(11535);
      expect(fetchMock).not.toHaveBeenCalled();
      if (action === 'refresh')
        await service.refreshModels({ allowStart: true });
      else await service.testConnection();
      await service.testConnection();
      await service.refreshModels({ allowStart: true });

      expect(connection.mock.calls).toEqual([
        [
          {
            provider: 'ollama',
            connectionMethod: 'local',
            connectSource: 'in_app',
          },
        ],
      ]);
      stop();
    },
  );

  it('counts a connection after new runtime setup before any probe as in-app', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    detectOllamaInstallationMock.mockResolvedValueOnce({
      platform: process.platform,
      ready: false,
      path: null,
      version: null,
      source: 'not-found',
      checkedAt: '2026-10-27T00:00:00.000Z',
      automaticInstallSupported: true,
    });
    mockServerVersion('0.14.0');
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.install();
    expect(connection).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await service.testConnection();
    await service.refreshModels({ allowStart: true });

    expect(connection.mock.calls).toEqual([
      [
        {
          provider: 'ollama',
          connectionMethod: 'local',
          connectSource: 'in_app',
        },
      ],
    ]);
    stop();
  });

  it('connection testing probes a requested port without mutating saved runtime state', async () => {
    mockServerVersion('0.14.0');

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    writeOllamaConfigurationPreferenceMock.mockClear();
    const result = await service.testConnection(11535);
    const state = await service.getState();

    expect(result).toMatchObject({
      ok: true,
      host: '127.0.0.1',
      port: 11535,
      version: '0.14.0',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11535/api/version',
      expect.any(Object),
    );
    expect(state).toMatchObject({
      port: 11534,
      status: 'stopped',
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(writeOllamaConfigurationPreferenceMock).not.toHaveBeenCalled();
  });

  it('connection testing before initialization does not detect or persist executable configuration', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    readOllamaPreferencesMock.mockResolvedValue({
      mode: 'managed',
      port: 11535,
      executablePath: '',
    });
    mockServerVersion('0.14.0');

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    const result = await service.testConnection();

    expect(connection).toHaveBeenCalledWith({
      provider: 'ollama',
      connectionMethod: 'local',
      connectSource: 'at_startup',
    });
    await service.testConnection(11535);
    await service.testConnection();
    expect(connection).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop();

    expect(result).toMatchObject({
      ok: true,
      host: '127.0.0.1',
      port: 11535,
      version: '0.14.0',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11535/api/version',
      expect.any(Object),
    );
    expect(detectOllamaInstallationMock).not.toHaveBeenCalled();
    expect(writeOllamaConfigurationPreferenceMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(await service.getState()).toMatchObject({
      port: 11534,
      status: 'stopped',
    });
  });

  it('rejects fractional configuration ports before persistence', async () => {
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    writeOllamaConfigurationPreferenceMock.mockClear();

    await expect(
      service.setConfiguration({ mode: 'manual', port: 11534.5 }),
    ).rejects.toThrow(/integer between 1 and 65535/i);

    expect(writeOllamaConfigurationPreferenceMock).not.toHaveBeenCalled();
    expect(await service.getState()).toMatchObject({ port: 11534 });
  });

  it('treats a disappeared executable as unavailable and does not spawn it', async () => {
    detectOllamaInstallationMock.mockResolvedValueOnce({
      platform: process.platform,
      ready: false,
      path: '/mock/bin/missing-ollama',
      version: null,
      source: 'persisted',
      checkedAt: '2026-07-14T00:00:00.000Z',
      automaticInstallSupported: true,
      error: 'ENOENT',
    });
    fetchMock.mockRejectedValue(new Error('offline'));

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();

    await expect(service.ensureServerRunning('chat')).rejects.toThrow(
      /executable could not be found/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(await service.getState()).toMatchObject({
      status: 'error',
      installation: {
        ready: false,
        path: '/mock/bin/missing-ollama',
      },
    });
  });

  it('surfaces startup failure when a managed server never becomes ready', async () => {
    const events = await import('../lib/provider-connection-events');
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const stop = events.subscribeProviderConnections(connection);
    fetchMock.mockRejectedValue(new Error('offline'));
    spawnMock.mockReturnValue(createMockChildProcess());
    const dateNowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(31_000);

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    try {
      await expect(service.ensureServerRunning('chat')).rejects.toThrow(
        /timed out/i,
      );
      expect(await service.getState()).toMatchObject({
        status: 'error',
      });
      expect(connection).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
      stop();
    }
  });

  it('fails immediately when the managed child exits during startup', async () => {
    const child = createMockChildProcess();
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => {
        child.emit('exit', 1, null);
        return Promise.reject(new Error('offline'));
      });
    spawnMock.mockReturnValue(child);

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    await service.initialize();

    const error: unknown = await service
      .ensureServerRunning('chat')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'OllamaServerUnavailableError',
      code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
    });
    if (!(error instanceof Error)) {
      throw new Error('Expected an Ollama startup error');
    }
    expect(error.message).toMatch(/exited before startup completed/i);
  });

  it('refreshes the model cache after a successful pull', async () => {
    let writtenCachePayload = '';
    writeFileMock.mockImplementation(
      (_path: string, data: string): Promise<void> => {
        writtenCachePayload = data;
        return Promise.resolve();
      },
    );
    mockServerVersion('0.14.0');
    pullMock.mockResolvedValue(
      makePullStream([
        {
          status: 'pulling manifest',
          digest: 'sha256:abc',
          total: 100,
          completed: 25,
        },
        {
          status: 'success',
          digest: 'sha256:abc',
          total: 100,
          completed: 100,
        },
      ]),
    );
    listMock.mockResolvedValue({
      models: [
        {
          model: 'qwen3-coder',
          digest: 'sha256:qwen',
          size: 123,
          modified_at: '2026-04-06T12:34:56.000Z',
          expires_at: '2026-04-07T12:34:56.000Z',
          size_vram: 64,
          details: {
            parent_model: '',
            format: 'gguf',
            family: 'qwen',
            families: ['qwen'],
            parameter_size: '3B',
            quantization_level: 'Q4_K_M',
          },
        },
      ],
    });
    showMock.mockResolvedValueOnce(
      showResponse({
        capabilities: ['completion', 'tools'],
        system: 'Local coding assistant',
        details: {
          parent_model: 'qwen-base',
          format: 'gguf',
          family: 'qwen',
          families: ['qwen', 'coder'],
          parameter_size: '3B',
          quantization_level: 'Q4_K_M',
        },
      }),
    );

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    const state = await service.pullModel('qwen3-coder');

    expect(pullMock).toHaveBeenCalledWith({
      model: 'qwen3-coder',
      stream: true,
    });
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalled();
    expect(writtenCachePayload).toContain(
      '"modifiedAt": "2026-04-06T12:34:56.000Z"',
    );
    expect(writtenCachePayload).toContain('"capabilities": [');
    expect(state).toMatchObject({
      status: 'running-external',
      models: [
        {
          id: 'ollama-qwen3-coder',
          rawModelId: 'qwen3-coder',
          digest: 'sha256:qwen',
          details: {
            parentModel: 'qwen-base',
            family: 'qwen',
            parameterSize: '3B',
          },
          show: {
            capabilities: ['completion', 'tools'],
            system: 'Local coding assistant',
          },
        },
      ],
    });
  });

  it('handles pull progress events that omit digest', async () => {
    mockServerVersion('0.14.0');
    pullMock.mockResolvedValue(
      makePullStream([
        {
          status: 'pulling manifest',
          total: 100,
          completed: 25,
        },
        {
          status: 'success',
          digest: 'sha256:abc',
          total: 100,
          completed: 100,
        },
      ]),
    );
    listMock.mockResolvedValue({ models: [] });

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();

    await expect(service.pullModel('llama3:8b')).resolves.toMatchObject({
      status: 'running-external',
    });
  });

  it('preserves cached show metadata when a refresh hits a transient show failure', async () => {
    mockServerVersion('0.14.0');
    readFileMock.mockResolvedValue(
      JSON.stringify({
        version: 1,
        byPort: {
          '11534': {
            refreshedAt: '2026-04-06T12:00:00.000Z',
            models: [
              {
                id: 'ollama-qwen3-coder',
                rawModelId: 'qwen3-coder',
                label: 'qwen3-coder',
                show: {
                  capabilities: ['completion', 'tools'],
                  system: 'Cached assistant',
                },
              },
            ],
          },
        },
      }),
    );
    listMock.mockResolvedValue({
      models: [
        {
          model: 'qwen3-coder',
          digest: 'sha256:qwen',
          size: 123,
          modified_at: '2026-04-06T12:34:56.000Z',
          expires_at: '2026-04-07T12:34:56.000Z',
          size_vram: 64,
          details: {
            parent_model: '',
            format: 'gguf',
            family: 'qwen',
            families: ['qwen'],
            parameter_size: '3B',
            quantization_level: 'Q4_K_M',
          },
        },
      ],
    });
    showMock.mockRejectedValueOnce(new Error('temporary show failure'));

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    const state = await service.refreshModels();

    expect(state).toMatchObject({
      status: 'running-external',
      models: [
        {
          id: 'ollama-qwen3-coder',
          rawModelId: 'qwen3-coder',
          show: {
            capabilities: ['completion', 'tools'],
            system: 'Cached assistant',
          },
        },
      ],
    });
  });

  it('rejects missing model names before attempting a pull', async () => {
    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();

    await expect(service.pullModel(undefined)).rejects.toThrow(
      'Model name is required',
    );
    expect(pullMock).not.toHaveBeenCalled();
  });

  it('deletes a model and refreshes the model cache', async () => {
    mockServerVersion('0.20.2');
    listMock.mockResolvedValue({
      models: [
        {
          model: 'qwen3-coder',
          digest: 'sha256:qwen',
          size: 123,
          modified_at: '2026-04-06T12:34:56.000Z',
          expires_at: '2026-04-07T12:34:56.000Z',
          size_vram: 64,
          details: {
            parent_model: '',
            format: 'gguf',
            family: 'qwen',
            families: ['qwen'],
            parameter_size: '3B',
            quantization_level: 'Q4_K_M',
          },
        },
      ],
    });
    showMock.mockResolvedValueOnce(showResponse());

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    const state = await service.deleteModel('llama3:8b');

    expect(deleteMock).toHaveBeenCalledWith({ model: 'llama3:8b' });
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      status: 'running-external',
      models: [
        {
          id: 'ollama-qwen3-coder',
          rawModelId: 'qwen3-coder',
          show: {
            capabilities: ['completion', 'chat'],
          },
        },
      ],
    });
  });

  it('shuts down managed servers but leaves external servers running', async () => {
    const managedChild = createMockChildProcess();
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
    spawnMock.mockReturnValue(managedChild);
    getEnhancedEnvMock.mockReturnValue({
      PATH: '/mock/bin',
      CUSTOM_OLLAMA_ENV: 'enabled',
    });

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnCall = spawnMock.mock.calls[0];
    if (!spawnCall) {
      throw new Error('Expected the Ollama server to spawn');
    }
    expect(spawnCall[0]).toBe('/mock/bin/ollama');
    expect(spawnCall[1]).toEqual(['serve']);
    expect(spawnCall[2].env).toEqual(
      expect.objectContaining({
        PATH: '/mock/bin',
        CUSTOM_OLLAMA_ENV: 'enabled',
        OLLAMA_HOST: '127.0.0.1:11534',
      }),
    );
    expect(spawnCall[2].stdio).toEqual(['ignore', 'ignore', 'pipe']);
    await service.shutdown('port-changed');
    expect(managedChild.kill).toHaveBeenCalledWith('SIGTERM');

    mockServerVersion('0.14.0');
    await service.ensureServerRunning('chat');
    const killCountBeforeExternalShutdown = managedChild.kill.mock.calls.length;
    await service.shutdown('port-changed');
    expect(managedChild.kill.mock.calls.length).toBe(
      killCountBeforeExternalShutdown,
    );
    expect(await service.getState()).toMatchObject({ status: 'stopped' });
  });

  it('cancels an in-flight managed startup before app shutdown waits for it', async () => {
    const managedChild = createMockChildProcess();
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          }),
      );
    spawnMock.mockReturnValue(managedChild);

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    const startup = service.ensureServerRunning('chat');
    while (spawnMock.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    await service.shutdown('app-quit');

    await expect(startup).rejects.toThrow(/startup canceled/i);
    expect(managedChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stops the managed server when the user environment changes', async () => {
    const managedChild = createMockChildProcess();
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
    spawnMock.mockReturnValue(managedChild);

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');
    expect(await service.getState()).toMatchObject({
      status: 'running-managed',
    });

    await service.handleUserEnvironmentChanged();

    expect(managedChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(await service.getState()).toMatchObject({
      status: 'stopped',
    });
  });

  it('resets a managed server when redetection changes the installation', async () => {
    const managedChild = createMockChildProcess();
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
    spawnMock.mockReturnValue(managedChild);
    detectOllamaInstallationMock.mockResolvedValueOnce({
      platform: process.platform,
      ready: true,
      path: '/mock/bin/ollama',
      version: '0.14.0',
      source: 'persisted',
      checkedAt: '2026-07-14T00:00:00.000Z',
      automaticInstallSupported: true,
    });

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');
    detectOllamaInstallationMock.mockResolvedValueOnce({
      platform: process.platform,
      ready: true,
      path: '/mock/bin/new-ollama',
      version: '0.15.0',
      source: 'auto-detected',
      checkedAt: '2026-07-16T00:00:00.000Z',
      automaticInstallSupported: true,
    });

    const state = await service.redetectInstallation();

    expect(managedChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(state).toMatchObject({
      status: 'stopped',
      installation: {
        path: '/mock/bin/new-ollama',
        version: '0.15.0',
      },
    });
    expect(state.serverVersion).toBeUndefined();
  });

  it('keeps a managed server running when redetection finds the same runtime', async () => {
    const managedChild = createMockChildProcess();
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
    spawnMock.mockReturnValue(managedChild);

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');
    detectOllamaInstallationMock.mockResolvedValueOnce({
      platform: process.platform,
      ready: true,
      path: '/mock/bin/ollama',
      version: '0.14.0',
      source: 'auto-detected',
      checkedAt: '2026-07-16T00:00:00.000Z',
      automaticInstallSupported: true,
    });

    const state = await service.redetectInstallation();

    expect(managedChild.kill).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      status: 'running-managed',
      installation: {
        path: '/mock/bin/ollama',
        version: '0.14.0',
        source: 'auto-detected',
      },
      serverVersion: '0.14.0',
    });
  });

  it('does not stop a managed server when Ollama is already installed', async () => {
    const managedChild = createMockChildProcess();
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(versionResponse('0.14.0')));
    spawnMock.mockReturnValue(managedChild);

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');
    await service.install();

    expect(managedChild.kill).not.toHaveBeenCalled();
    expect(installOllamaMock).not.toHaveBeenCalled();
    expect(await service.getState()).toMatchObject({
      status: 'running-managed',
      installation: { source: 'persisted' },
    });
  });

  it('preserves the previous valid installation after an invalid browse selection', async () => {
    validateOllamaExecutableMock.mockResolvedValueOnce({
      platform: process.platform,
      ready: false,
      path: '/mock/bin/not-ollama',
      version: null,
      source: 'browse',
      checkedAt: '2026-07-14T00:00:00.000Z',
      automaticInstallSupported: true,
      error: 'The selected executable did not report an Ollama version.',
    });

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    const state = await service.setExecutablePath('/mock/bin/not-ollama');

    expect(writeOllamaConfigurationPreferenceMock).not.toHaveBeenCalledWith({
      executablePath: '/mock/bin/not-ollama',
    });
    expect(state).toMatchObject({
      error: 'The selected executable did not report an Ollama version.',
      installation: {
        ready: true,
        path: '/mock/bin/ollama',
        version: '0.14.0',
      },
    });
  });

  it('treats a successful executable browse as a configuration lifecycle change', async () => {
    const statusMock = jest.fn();
    const modelRegistryUpdatedMock = jest.fn();
    mockServerVersion('0.14.0');
    validateOllamaExecutableMock.mockResolvedValueOnce({
      platform: process.platform,
      ready: true,
      path: '/mock/bin/new-ollama',
      version: '0.15.0',
      source: 'browse',
      checkedAt: '2026-07-14T00:00:00.000Z',
      automaticInstallSupported: true,
    });

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();
    service.setBroadcastHandlers({
      status: statusMock,
      modelRegistryUpdated: modelRegistryUpdatedMock,
    });

    await service.initialize();
    await service.ensureServerRunning('chat');
    expect((await service.getState()).serverVersion).toBe('0.14.0');

    const state = await service.setExecutablePath('/mock/bin/new-ollama');

    expect(writeOllamaConfigurationPreferenceMock).toHaveBeenCalledWith({
      executablePath: '/mock/bin/new-ollama',
    });
    expect(state).toMatchObject({
      status: 'stopped',
      installation: {
        ready: true,
        path: '/mock/bin/new-ollama',
        version: '0.15.0',
      },
    });
    expect(state.serverVersion).toBeUndefined();
    expect(statusMock).toHaveBeenCalledWith(
      expect.objectContaining({ serverVersion: undefined, status: 'stopped' }),
    );
    expect(modelRegistryUpdatedMock).toHaveBeenCalled();
  });

  it('does not install Ollama while manual mode is active', async () => {
    readOllamaPreferencesMock.mockResolvedValueOnce({
      mode: 'manual',
      port: 11534,
      executablePath: '/mock/bin/ollama',
    });

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();

    await expect(service.install()).rejects.toThrow(/disabled in manual mode/i);
    expect(installOllamaMock).not.toHaveBeenCalled();
  });

  it('rejects Ollama versions older than the Anthropic-compatible API minimum', async () => {
    mockServerVersion('0.5.7');

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');

    await expect(service.assertAnthropicCompatibleApi()).rejects.toThrow(
      /Upgrade Ollama to 0\.14\.0 or newer/i,
    );
  });

  it('accepts Ollama versions that support the Anthropic-compatible API', async () => {
    mockServerVersion('0.14.0');

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');

    await expect(
      service.assertAnthropicCompatibleApi(),
    ).resolves.toBeUndefined();
  });

  it('rejects Ollama versions older than the Responses API minimum', async () => {
    mockServerVersion('0.13.2');

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');

    await expect(service.assertResponsesCompatibleApi()).rejects.toThrow(
      /Responses API required for Codex-harness sessions.*0\.13\.3 or newer/i,
    );
  });

  it('reports an unreadable server version as a typed server-unavailable failure', async () => {
    // This is the "Ollama isn't running" shape of the Codex-harness precheck,
    // and callers that rewrite it into user-facing guidance ("Start Ollama…")
    // must be able to tell it apart from a reachable server that merely refused
    // the model or is too old. Substring-sniffing the message is not a contract;
    // the error name/code is.
    readOllamaPreferencesMock.mockResolvedValueOnce({
      mode: 'manual',
      port: 11534,
      executablePath: '',
    });
    fetchMock.mockRejectedValue(new Error('offline'));

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();

    await expect(service.assertResponsesCompatibleApi()).rejects.toMatchObject({
      name: 'OllamaServerUnavailableError',
      code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
    });
  });

  it('reports a too-old server version as a plain, non-server-unavailable failure', async () => {
    // The counterpart guarantee: the server answered, so a caller must not
    // rewrite this into "start the server". Upgrading is the only remedy.
    mockServerVersion('0.13.2');

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');

    const error: unknown = await service
      .assertResponsesCompatibleApi()
      .catch((caught: unknown) => caught);
    if (!(error instanceof Error)) {
      throw new Error('Expected a Responses-API compatibility error');
    }
    expect(error.name).toBe('Error');
    expect('code' in error).toBe(false);
  });

  it('accepts Ollama versions that support the Responses API', async () => {
    mockServerVersion('0.13.3');

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    await service.initialize();
    await service.ensureServerRunning('chat');

    await expect(
      service.assertResponsesCompatibleApi(),
    ).resolves.toBeUndefined();
  });
});
