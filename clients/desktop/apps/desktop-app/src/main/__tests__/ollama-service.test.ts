import { EventEmitter } from 'node:events';
import { OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE } from '@canopy/desktop-shared/types';
import type * as DesktopSharedTypes from '@canopy/desktop-shared/types';

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
const getEnhancedEnvMock = jest.fn(() => ({ PATH: '/mock/bin' }));
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
    readOllamaPreferencesMock.mockResolvedValueOnce({
      mode: 'managed',
      port: 11535,
      executablePath: '',
    });
    mockServerVersion('0.14.0');

    const { getOllamaService } = await import('../ollama/service');
    const service = getOllamaService();

    const result = await service.testConnection();

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
    } finally {
      dateNowSpy.mockRestore();
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
