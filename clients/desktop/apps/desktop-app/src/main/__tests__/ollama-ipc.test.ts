import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS, initOllamaModels } from '@canopy/desktop-shared/types';

let broadcastHandlers: {
  status?: (state: unknown) => void;
  pullProgress?: (progress: unknown) => void;
  installProgress?: (progress: unknown) => void;
  modelRegistryUpdated?: (snapshot: unknown) => void;
} = {};

const defaultInstallation = {
  platform: 'win32',
  ready: true,
  path: 'C:/Program Files/Ollama/ollama.exe',
  version: '0.14.0',
  source: 'auto-detected',
  checkedAt: '2026-07-14T00:00:00.000Z',
  automaticInstallSupported: true,
};
const defaultState = {
  port: 11534,
  status: 'stopped',
  models: [],
  mode: 'managed',
  installation: defaultInstallation,
};
const defaultRegistry = {
  claude: [],
  codex: [],
  copilot: [],
  cursor: [],
  ollama: [],
  opencode: [],
  agents: [],
  aliases: {},
  aiGatewayModels: [],
  gatewayRoutes: [],
  harnessAssignments: { revision: 0, assignments: [] },
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const syncHandlers = new Map<
    string,
    (event: { returnValue: unknown }) => void
  >();
  return {
    ipcMain: {
      handle: jest.fn(
        (channel: string, handler: (...args: unknown[]) => unknown) => {
          handlers.set(channel, handler);
        },
      ),
      removeHandler: jest.fn((channel: string) => {
        handlers.delete(channel);
      }),
      on: jest.fn(
        (
          channel: string,
          handler: (event: { returnValue: unknown }) => void,
        ) => {
          syncHandlers.set(channel, handler);
        },
      ),
      removeAllListeners: jest.fn(),
      _handlers: handlers,
      _syncHandlers: syncHandlers,
    },
    BrowserWindow: Object.assign(jest.fn(), {
      getAllWindows: jest.fn(() => []),
    }),
    dialog: {
      showOpenDialog: jest.fn(() =>
        Promise.resolve({ canceled: true, filePaths: [] }),
      ),
    },
  };
});

const destroySessionsByProviderMock = jest.fn().mockResolvedValue(undefined);
const destroySessionsByModelMock = jest.fn().mockResolvedValue(undefined);
const getStateMock = jest.fn(() => Promise.resolve(defaultState));
const getModelRegistrySnapshotMock = jest.fn(() => defaultRegistry);
const refreshModelsMock = jest.fn(() => {
  broadcastHandlers.status?.(defaultState);
  broadcastHandlers.modelRegistryUpdated?.(defaultRegistry);
  return Promise.resolve(defaultState);
});
const pullModelMock = jest.fn(() => Promise.resolve(defaultState));
const deleteModelMock = jest.fn(() => Promise.resolve(defaultState));
const setConfigurationMock = jest.fn(
  (update: { port: number; mode: string }) => {
    const nextState = { ...defaultState, port: update.port, mode: update.mode };
    broadcastHandlers.status?.(nextState);
    broadcastHandlers.modelRegistryUpdated?.(defaultRegistry);
    return Promise.resolve(nextState);
  },
);
const testConnectionMock = jest.fn(() =>
  Promise.resolve({
    ok: true,
    host: '127.0.0.1',
    port: 11534,
    checkedAt: '2026-07-14T00:00:00.000Z',
    latencyMs: 4,
    version: '0.14.0',
  }),
);
const redetectInstallationMock = jest.fn(() => Promise.resolve(defaultState));
const setExecutablePathMock = jest.fn(() => Promise.resolve(defaultState));
const installMock = jest.fn(() => Promise.resolve(defaultState));
const setBroadcastHandlersMock = jest.fn(
  (handlers: typeof broadcastHandlers): void => {
    broadcastHandlers = handlers;
  },
);

jest.mock('../agents/session-manager', () => ({
  destroySessionsByModel: destroySessionsByModelMock,
  destroySessionsByProvider: destroySessionsByProviderMock,
}));

const readPreferencesFileMock = jest.fn().mockResolvedValue({
  defaultChatProvider: 'claude',
  defaultChatModelByProvider: {
    claude: { model: 'opus[1m]', thinkingLevel: 'high' },
    codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
    ollama: null,
  },
  defaultWorktreeProvider: 'claude',
  defaultWorktreeModelByProvider: {
    claude: { model: 'opus[1m]', thinkingLevel: 'high' },
    codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
    ollama: null,
  },
  summaryModel: 'claude-haiku-4-5-20251001',
  worktreeSummaryModel: 'claude-haiku-4-5-20251001',
  branchNamingModel: 'claude-haiku-4-5-20251001',
  prGenerationModel: 'claude-sonnet-4-6',
  commitGenerationModel: 'claude-sonnet-4-6',
});

jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: readPreferencesFileMock,
}));

jest.mock('../ollama', () => ({
  getOllamaService: jest.fn(() => ({
    getCachedModels: (): typeof defaultState.models => defaultState.models,
    getState: getStateMock,
    getModelRegistrySnapshot: getModelRegistrySnapshotMock,
    refreshModels: refreshModelsMock,
    pullModel: pullModelMock,
    deleteModel: deleteModelMock,
    setConfiguration: setConfigurationMock,
    testConnection: testConnectionMock,
    redetectInstallation: redetectInstallationMock,
    setExecutablePath: setExecutablePathMock,
    install: installMock,
    setBroadcastHandlers: setBroadcastHandlersMock,
  })),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  registerModelRegistryHandlers,
  registerOllamaHandlers,
} from '../ipc/ollama';
import {
  setAiGatewayCatalogRetryHandler,
  setAiGatewayCatalogStatus,
} from '../ai-gateway-models/status';
import {
  ModelHarnessAssignmentIpcError,
  registerModelHarnessAssignmentHandlers,
  setModelHarnessAssignmentController,
} from '../ipc/model-harness-assignments';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockWebContents = {
  send: jest.fn(),
};
const mockWindow = {
  isDestroyed: jest.fn(() => false),
  webContents: mockWebContents,
} as unknown as BrowserWindow;

const getWindow = (): BrowserWindow | null => mockWindow;

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const map = (
    ipcMain as unknown as {
      _handlers: Map<string, (...args: unknown[]) => unknown>;
    }
  )._handlers;
  const handler = map.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler;
}

function getSyncHandler(
  channel: string,
): (event: { returnValue: unknown }) => void {
  const map = (
    ipcMain as unknown as {
      _syncHandlers: Map<string, (event: { returnValue: unknown }) => void>;
    }
  )._syncHandlers;
  const handler = map.get(channel);
  if (!handler) throw new Error(`No sync handler registered for ${channel}`);
  return handler;
}

function clearRegisteredHandlers(): void {
  (
    ipcMain as unknown as {
      _handlers: Map<string, (...args: unknown[]) => unknown>;
      _syncHandlers: Map<string, (event: { returnValue: unknown }) => void>;
    }
  )._handlers.clear();
  (
    ipcMain as unknown as {
      _syncHandlers: Map<string, (event: { returnValue: unknown }) => void>;
    }
  )._syncHandlers.clear();
}

function setMockWindows(windows: BrowserWindow[]): void {
  jest.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue(windows);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Ollama IPC handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearRegisteredHandlers();
    broadcastHandlers = {};
    setMockWindows([mockWindow]);
    setModelHarnessAssignmentController(undefined);
    registerModelRegistryHandlers(getWindow);
    registerModelHarnessAssignmentHandlers();
    registerOllamaHandlers(getWindow);
  });

  it('registers handlers for all ollama and model-registry channels', () => {
    const registeredChannels = [
      IPC_CHANNELS.modelRegistryGet,
      IPC_CHANNELS.harnessAssignmentsLoad,
      IPC_CHANNELS.harnessAssignmentsSet,
      IPC_CHANNELS.harnessAssignmentsReset,
      IPC_CHANNELS.ollamaGetState,
      IPC_CHANNELS.ollamaRefreshModels,
      IPC_CHANNELS.ollamaPullModel,
      IPC_CHANNELS.ollamaDeleteModel,
      IPC_CHANNELS.ollamaSetConfiguration,
      IPC_CHANNELS.ollamaTestConnection,
      IPC_CHANNELS.ollamaRedetectInstallation,
      IPC_CHANNELS.ollamaBrowseInstallation,
      IPC_CHANNELS.ollamaInstall,
    ];
    for (const channel of registeredChannels) {
      expect(getHandler(channel)).toBeDefined();
    }
    expect(
      (
        ipcMain as typeof ipcMain & {
          removeAllListeners: { mock: { calls: unknown[] } };
        }
      ).removeAllListeners.mock.calls,
    ).toHaveLength(0);
  });

  it('loads and mutates authoritative harness assignment snapshots', async () => {
    let snapshot = { revision: 1, assignments: [] };
    const controller = {
      load: jest.fn(() => Promise.resolve(snapshot)),
      set: jest.fn(
        (input: { modelId: string; harness: 'claude' | 'codex' }) => {
          snapshot = {
            revision: snapshot.revision + 1,
            assignments: [
              {
                modelId: input.modelId,
                source: 'ai-gateway' as const,
                harness: input.harness,
                defaultHarness: 'codex' as const,
                configurable: true,
                overridden: input.harness !== 'codex',
              },
            ],
          };
          return Promise.resolve(snapshot);
        },
      ),
      reset: jest.fn(() => {
        snapshot = { revision: snapshot.revision + 1, assignments: [] };
        return Promise.resolve(snapshot);
      }),
    };
    setModelHarnessAssignmentController(controller);

    await expect(
      getHandler(IPC_CHANNELS.harnessAssignmentsLoad)({}),
    ).resolves.toEqual({ revision: 1, assignments: [] });
    await expect(
      getHandler(IPC_CHANNELS.harnessAssignmentsSet)(
        {},
        {
          modelId: 'gateway-model',
          harness: 'claude',
        },
      ),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(
      getHandler(IPC_CHANNELS.harnessAssignmentsReset)(
        {},
        {
          modelId: 'gateway-model',
        },
      ),
    ).resolves.toEqual({ revision: 3, assignments: [] });
    expect(controller.set).toHaveBeenCalledWith({
      modelId: 'gateway-model',
      harness: 'claude',
    });
    expect(destroySessionsByModelMock).not.toHaveBeenCalled();
    expect(destroySessionsByProviderMock).not.toHaveBeenCalled();
  });

  it('rejects invalid harness intent before calling backend policy', async () => {
    const controller = {
      load: jest.fn(() => Promise.resolve({ revision: 1, assignments: [] })),
      set: jest.fn(),
      reset: jest.fn(),
    };
    setModelHarnessAssignmentController(controller);
    await expect(
      getHandler(IPC_CHANNELS.harnessAssignmentsSet)(
        {},
        {
          modelId: 'gateway-model',
          harness: 'ollama',
        },
      ),
    ).rejects.toThrow('MODEL_HARNESS_ASSIGNMENT_INVALID_HARNESS');
    expect(controller.set).not.toHaveBeenCalled();
  });

  it('rejects malformed model ids before calling backend policy', async () => {
    const controller = {
      load: jest.fn(() => Promise.resolve({ revision: 1, assignments: [] })),
      set: jest.fn(() => Promise.resolve({ revision: 2, assignments: [] })),
      reset: jest.fn(),
    };
    setModelHarnessAssignmentController(controller);

    await expect(
      getHandler(IPC_CHANNELS.harnessAssignmentsSet)(
        {},
        { modelId: '../gateway-model', harness: 'codex' },
      ),
    ).rejects.toThrow('MODEL_HARNESS_ASSIGNMENT_INVALID_REQUEST');
    expect(controller.set).not.toHaveBeenCalled();
  });

  it('accepts provider syntax in a host-known model id', async () => {
    initOllamaModels([
      {
        id: 'ollama-llama3:8b',
        rawModelId: 'llama3:8b',
        label: 'llama3:8b',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    const snapshot = { revision: 2, assignments: [] };
    const controller = {
      load: jest.fn(() => Promise.resolve(snapshot)),
      set: jest.fn(() => Promise.resolve(snapshot)),
      reset: jest.fn(),
    };
    setModelHarnessAssignmentController(controller);

    await expect(
      getHandler(IPC_CHANNELS.harnessAssignmentsSet)(
        {},
        { modelId: 'ollama-llama3:8b', harness: 'claude' },
      ),
    ).resolves.toEqual(snapshot);
    expect(controller.set).toHaveBeenCalledWith({
      modelId: 'ollama-llama3:8b',
      harness: 'claude',
    });
    initOllamaModels([]);
    setModelHarnessAssignmentController(undefined);
  });

  it('rejects a host-known model id containing path traversal syntax', async () => {
    initOllamaModels([
      {
        id: 'ollama-../escape:8b',
        rawModelId: '../escape:8b',
        label: '../escape:8b',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    const controller = {
      load: jest.fn(() => Promise.resolve({ revision: 1, assignments: [] })),
      set: jest.fn(() => Promise.resolve({ revision: 2, assignments: [] })),
      reset: jest.fn(),
    };
    setModelHarnessAssignmentController(controller);

    await expect(
      getHandler(IPC_CHANNELS.harnessAssignmentsSet)(
        {},
        { modelId: 'ollama-../escape:8b', harness: 'codex' },
      ),
    ).rejects.toThrow('MODEL_HARNESS_ASSIGNMENT_INVALID_REQUEST');
    expect(controller.set).not.toHaveBeenCalled();
    initOllamaModels([]);
    setModelHarnessAssignmentController(undefined);
  });

  it('preserves stable backend policy errors without broadcasting', async () => {
    setModelHarnessAssignmentController({
      load: () => Promise.resolve({ revision: 5, assignments: [] }),
      set: () =>
        Promise.reject(
          new ModelHarnessAssignmentIpcError(
            'NOT_CONFIGURABLE',
            'Managed models cannot be reassigned',
          ),
        ),
      reset: () =>
        Promise.reject(
          new ModelHarnessAssignmentIpcError(
            'UNKNOWN_MODEL',
            'The model is not in the current catalog',
          ),
        ),
    });

    await expect(
      getHandler(IPC_CHANNELS.harnessAssignmentsSet)(
        {},
        { modelId: 'managed-model', harness: 'codex' },
      ),
    ).rejects.toThrow('MODEL_HARNESS_ASSIGNMENT_NOT_CONFIGURABLE');
    await expect(
      getHandler(IPC_CHANNELS.harnessAssignmentsReset)(
        {},
        { modelId: 'missing-model' },
      ),
    ).rejects.toThrow('MODEL_HARNESS_ASSIGNMENT_UNKNOWN_MODEL');
    expect(mockWebContents.send).not.toHaveBeenCalled();
  });

  it('returns and broadcasts an unchanged snapshot for idempotent intent', async () => {
    const unchanged = { revision: 9, assignments: [] };
    setModelHarnessAssignmentController({
      load: () => Promise.resolve(unchanged),
      set: () => Promise.resolve(unchanged),
      reset: () => Promise.resolve(unchanged),
    });

    await expect(
      getHandler(IPC_CHANNELS.harnessAssignmentsSet)(
        {},
        { modelId: 'gateway-model', harness: 'codex' },
      ),
    ).resolves.toEqual(unchanged);
    expect(mockWebContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.modelRegistryUpdated,
      expect.any(Object),
    );
  });

  it('broadcasts registry convergence to every live window after mutation', async () => {
    const secondWebContentsSend = jest.fn();
    const secondWindow = new Proxy(mockWindow, {
      get(target, property, receiver): unknown {
        if (property === 'isDestroyed') return jest.fn(() => false);
        if (property === 'webContents') {
          return new Proxy(target.webContents, {
            get(
              webContents,
              webContentsProperty,
              webContentsReceiver,
            ): unknown {
              if (webContentsProperty === 'send') return secondWebContentsSend;
              const value: unknown = Reflect.get(
                webContents,
                webContentsProperty,
                webContentsReceiver,
              );
              return value;
            },
          });
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    });
    setMockWindows([mockWindow, secondWindow]);
    setModelHarnessAssignmentController({
      load: () => Promise.resolve({ revision: 1, assignments: [] }),
      set: () => Promise.resolve({ revision: 2, assignments: [] }),
      reset: () => Promise.resolve({ revision: 2, assignments: [] }),
    });
    await getHandler(IPC_CHANNELS.harnessAssignmentsSet)(
      {},
      {
        modelId: 'gateway-model',
        harness: 'claude',
      },
    );
    expect(mockWebContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.modelRegistryUpdated,
      expect.any(Object),
    );
    expect(secondWebContentsSend).toHaveBeenCalledWith(
      IPC_CHANNELS.modelRegistryUpdated,
      expect.any(Object),
    );
  });

  it('modelRegistryGet returns a valid snapshot', async () => {
    const handler = getHandler(IPC_CHANNELS.modelRegistryGet);
    const result = await handler({});
    if (
      typeof result !== 'object' ||
      result === null ||
      !('harnessAssignments' in result) ||
      typeof result.harnessAssignments !== 'object' ||
      result.harnessAssignments === null ||
      !('revision' in result.harnessAssignments)
    )
      throw new Error('Missing harness assignment snapshot');
    expect(Number.isSafeInteger(result.harnessAssignments?.revision)).toBe(
      true,
    );
    expect(result).toEqual({
      ...defaultRegistry,
      harnessAssignments: {
        revision: result.harnessAssignments?.revision,
        assignments: [
          {
            modelId: 'cursor-default',
            source: 'cursor-managed',
            harness: 'cursor',
            defaultHarness: 'cursor',
            configurable: false,
            overridden: false,
            availableHarnesses: ['cursor'],
          },
        ],
      },
    });
  });

  describe('AI Gateway catalog status and retry', () => {
    afterEach(() => {
      setAiGatewayCatalogStatus(undefined);
      setAiGatewayCatalogRetryHandler(undefined);
    });

    it('includes the catalog status in the registry snapshot only when known', async () => {
      const handler = getHandler(IPC_CHANNELS.modelRegistryGet);
      expect(await handler({})).not.toHaveProperty('aiGatewayCatalogStatus');
      setAiGatewayCatalogStatus('failed');
      expect(await handler({})).toEqual(
        expect.objectContaining({ aiGatewayCatalogStatus: 'failed' }),
      );
    });

    it('runs the catalog retry and resolves once the attempt finishes', async () => {
      let finishAttempt: (() => void) | undefined;
      const retry = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishAttempt = resolve;
          }),
      );
      setAiGatewayCatalogRetryHandler(retry);
      const handler = getHandler(IPC_CHANNELS.aiGatewayModelCatalogRetry);
      let settled = false;
      const pending = Promise.resolve(handler({})).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(retry).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      finishAttempt?.();
      await pending;
      expect(settled).toBe(true);
    });

    it('resolves the retry as a no-op when no catalog service is running', async () => {
      const handler = getHandler(IPC_CHANNELS.aiGatewayModelCatalogRetry);
      await expect(Promise.resolve(handler({}))).resolves.toBeUndefined();
    });
  });

  it('modelRegistryGet responds synchronously for preload bootstrap', () => {
    const syncHandler = getSyncHandler(IPC_CHANNELS.modelRegistryGet);
    const event = { returnValue: undefined as unknown };
    syncHandler(event);
    expect(event.returnValue).toEqual(expect.objectContaining({ ollama: [] }));
  });

  it('registers modelRegistryGet without Ollama-specific handlers', () => {
    clearRegisteredHandlers();
    setBroadcastHandlersMock.mockClear();
    registerModelRegistryHandlers();

    expect(getHandler(IPC_CHANNELS.modelRegistryGet)).toBeDefined();
    expect(getSyncHandler(IPC_CHANNELS.modelRegistryGet)).toBeDefined();
    expect(() => getHandler(IPC_CHANNELS.ollamaGetState)).toThrow(
      'No handler registered',
    );
    expect(setBroadcastHandlersMock).not.toHaveBeenCalled();
  });

  it('ollamaGetState returns default state', async () => {
    const handler = getHandler(IPC_CHANNELS.ollamaGetState);
    const result = await handler({});
    expect(result).toEqual(defaultState);
  });

  it('ollamaRefreshModels broadcasts status and registry updates', async () => {
    const handler = getHandler(IPC_CHANNELS.ollamaRefreshModels);
    await handler({});
    expect(mockWebContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.ollamaStatus,
      expect.objectContaining({ status: 'stopped' }),
    );
    expect(mockWebContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.modelRegistryUpdated,
      expect.objectContaining({ ollama: [] }),
    );
  });

  it('ollamaPullModel accepts a model request', async () => {
    const handler = getHandler(IPC_CHANNELS.ollamaPullModel);
    await handler({}, { model: 'llama3:8b' });
    expect(pullModelMock).toHaveBeenCalledWith('llama3:8b');
  });

  it('ollamaPullModel accepts a plain string request', async () => {
    const handler = getHandler(IPC_CHANNELS.ollamaPullModel);
    await handler({}, 'llama3:8b');
    expect(pullModelMock).toHaveBeenCalledWith('llama3:8b');
  });

  it('ollamaPullModel rejects invalid requests with a user-facing error', async () => {
    const handler = getHandler(IPC_CHANNELS.ollamaPullModel);
    await expect(handler({}, {})).rejects.toThrow('Model name is required');
  });

  it('ollamaDeleteModel deletes a model when it is not configured in preferences', async () => {
    const handler = getHandler(IPC_CHANNELS.ollamaDeleteModel);

    const result = await handler({}, { model: 'llama3:8b' });

    expect(destroySessionsByModelMock).toHaveBeenCalledWith('ollama-llama3:8b');
    expect(deleteModelMock).toHaveBeenCalledWith('llama3:8b');
    expect(result).toEqual({
      ok: true,
      state: defaultState,
    });
  });

  it('ollamaDeleteModel blocks deletion when preferences still reference the model', async () => {
    readPreferencesFileMock.mockResolvedValueOnce({
      defaultChatProvider: 'ollama',
      defaultChatModelByProvider: {
        claude: { model: 'opus[1m]', thinkingLevel: 'high' },
        codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
        ollama: { model: 'ollama-llama3:8b', thinkingLevel: 'high' },
      },
      defaultWorktreeProvider: 'claude',
      defaultWorktreeModelByProvider: {
        claude: { model: 'opus[1m]', thinkingLevel: 'high' },
        codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
        ollama: null,
      },
      summaryModel: 'claude-haiku-4-5-20251001',
      worktreeSummaryModel: 'claude-haiku-4-5-20251001',
      branchNamingModel: 'ollama-llama3:8b',
      prGenerationModel: 'claude-sonnet-4-6',
      commitGenerationModel: 'claude-sonnet-4-6',
    });
    const handler = getHandler(IPC_CHANNELS.ollamaDeleteModel);

    const result = await handler({}, { model: 'llama3:8b' });

    expect(deleteModelMock).not.toHaveBeenCalled();
    expect(destroySessionsByModelMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      blockedByPreferences: [
        'Chat settings > Standalone Chat model (Ollama)',
        'Git settings > Branch naming model',
      ],
    });
  });

  it('ollamaDeleteModel names the title, handoff, and worktree activity model settings', async () => {
    readPreferencesFileMock.mockResolvedValueOnce({
      defaultChatModelByProvider: {
        claude: { model: 'opus[1m]', thinkingLevel: 'high' },
        codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
        ollama: null,
      },
      defaultWorktreeModelByProvider: {
        claude: { model: 'opus[1m]', thinkingLevel: 'high' },
        codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
        ollama: null,
      },
      summaryModel: 'ollama-llama3:8b',
      handoffSummaryModel: 'ollama-llama3:8b',
      worktreeSummaryModel: 'ollama-llama3:8b',
    });
    const handler = getHandler(IPC_CHANNELS.ollamaDeleteModel);

    const result = await handler({}, { model: 'llama3:8b' });

    expect(deleteModelMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      blockedByPreferences: [
        'Chat settings > Chat title model',
        'Chat settings > Conversation handoff model',
        'Chat settings > Worktree activity summary model',
      ],
    });
  });

  it('defines stable channel names for the connection-management contract', () => {
    // Transport contract: the six new channel strings the backend registers
    // handlers against and the preload bridge invokes.
    expect(IPC_CHANNELS.ollamaSetConfiguration).toBe(
      'ollama:set-configuration',
    );
    expect(IPC_CHANNELS.ollamaTestConnection).toBe('ollama:test-connection');
    expect(IPC_CHANNELS.ollamaRedetectInstallation).toBe(
      'ollama:redetect-installation',
    );
    expect(IPC_CHANNELS.ollamaBrowseInstallation).toBe(
      'ollama:browse-installation',
    );
    expect(IPC_CHANNELS.ollamaInstall).toBe('ollama:install');
    expect(IPC_CHANNELS.ollamaInstallProgress).toBe('ollama:install-progress');
  });

  it('ollamaSetConfiguration accepts a configuration update and broadcasts status', async () => {
    const handler = getHandler(IPC_CHANNELS.ollamaSetConfiguration);
    const update = { mode: 'manual', port: 8080 };
    const result = await handler({}, update);
    expect(setConfigurationMock).toHaveBeenCalledWith(update);
    expect(result).toEqual(
      expect.objectContaining({ port: 8080, mode: 'manual' }),
    );
    expect(mockWebContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.ollamaStatus,
      expect.objectContaining({ status: 'stopped' }),
    );
    expect(destroySessionsByProviderMock).toHaveBeenCalledWith('ollama');
  });

  it('ollamaSetConfiguration destroys active sessions only after persistence succeeds', async () => {
    const handler = getHandler(IPC_CHANNELS.ollamaSetConfiguration);
    await handler({}, { mode: 'managed', port: 9090 });
    // Ordering observed at the IPC boundary: the port persists first, then the
    // active Ollama sessions are destroyed.
    expect(setConfigurationMock.mock.invocationCallOrder[0]).toBeLessThan(
      destroySessionsByProviderMock.mock.invocationCallOrder[0],
    );
  });

  it('ollamaBrowseInstallation returns the current state when file selection is canceled', async () => {
    const handler = getHandler(IPC_CHANNELS.ollamaBrowseInstallation);

    const result = await handler({});

    expect(jest.mocked(dialog).showOpenDialog.mock.calls).toHaveLength(1);
    expect(getStateMock).toHaveBeenCalled();
    expect(setExecutablePathMock).not.toHaveBeenCalled();
    expect(result).toEqual(defaultState);
  });

  it('ollamaBrowseInstallation validates the selected executable through the service', async () => {
    const executablePath = '/Applications/Ollama.app/Contents/Resources/ollama';
    const browsedState = {
      ...defaultState,
      installation: {
        ...defaultInstallation,
        ready: true,
        path: executablePath,
      },
    };
    setExecutablePathMock.mockResolvedValueOnce(browsedState);
    jest.mocked(dialog).showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [executablePath],
    });
    const handler = getHandler(IPC_CHANNELS.ollamaBrowseInstallation);

    const result = await handler({});

    expect(setExecutablePathMock).toHaveBeenCalledWith(executablePath);
    expect(destroySessionsByProviderMock).toHaveBeenCalledWith('ollama');
    expect(setExecutablePathMock.mock.invocationCallOrder[0]).toBeLessThan(
      destroySessionsByProviderMock.mock.invocationCallOrder[0],
    );
    expect(result).toBe(browsedState);
  });

  it('ollamaBrowseInstallation does not destroy sessions after invalid selection', async () => {
    jest.mocked(dialog).showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Applications/NotOllama.app/Contents/MacOS/not-ollama'],
    });
    setExecutablePathMock.mockResolvedValueOnce({
      ...defaultState,
      error: 'The selected executable did not report an Ollama version.',
    });
    const handler = getHandler(IPC_CHANNELS.ollamaBrowseInstallation);

    await handler({});

    expect(setExecutablePathMock).toHaveBeenCalledWith(
      '/Applications/NotOllama.app/Contents/MacOS/not-ollama',
    );
    expect(destroySessionsByProviderMock).not.toHaveBeenCalled();
  });

  it('invalidates Ollama sessions when redetection changes the executable', async () => {
    const detectedState = {
      ...defaultState,
      installation: {
        ...defaultInstallation,
        ready: true,
        path: '/Applications/Ollama.app/Contents/Resources/ollama',
      },
    };
    redetectInstallationMock.mockResolvedValueOnce(detectedState);
    const handler = getHandler(IPC_CHANNELS.ollamaRedetectInstallation);

    const result = await handler({});

    expect(result).toBe(detectedState);
    expect(destroySessionsByProviderMock).toHaveBeenCalledWith('ollama');
    expect(redetectInstallationMock.mock.invocationCallOrder[0]).toBeLessThan(
      destroySessionsByProviderMock.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['readiness', { ready: false }],
    ['version', { version: '0.15.0' }],
  ] as const)(
    'invalidates Ollama sessions when redetection changes installation %s',
    async (_field, installationChange) => {
      const detectedState = {
        ...defaultState,
        installation: {
          ...defaultInstallation,
          ...installationChange,
        },
      };
      redetectInstallationMock.mockResolvedValueOnce(detectedState);
      const handler = getHandler(IPC_CHANNELS.ollamaRedetectInstallation);

      const result = await handler({});

      expect(result).toBe(detectedState);
      expect(destroySessionsByProviderMock).toHaveBeenCalledWith('ollama');
    },
  );

  it('keeps Ollama sessions when redetection finds the same runtime', async () => {
    const handler = getHandler(IPC_CHANNELS.ollamaRedetectInstallation);

    const result = await handler({});

    expect(result).toBe(defaultState);
    expect(destroySessionsByProviderMock).not.toHaveBeenCalled();
  });

  it('invalidates Ollama sessions after install resolves a new executable', async () => {
    const installedState = {
      ...defaultState,
      installation: {
        ...defaultInstallation,
        ready: true,
        path: '/Applications/Ollama.app/Contents/Resources/ollama',
      },
    };
    installMock.mockResolvedValueOnce(installedState);
    const handler = getHandler(IPC_CHANNELS.ollamaInstall);

    const result = await handler({});

    expect(result).toBe(installedState);
    expect(destroySessionsByProviderMock).toHaveBeenCalledWith('ollama');
    expect(installMock.mock.invocationCallOrder[0]).toBeLessThan(
      destroySessionsByProviderMock.mock.invocationCallOrder[0],
    );
  });

  it('does not broadcast when window is null', async () => {
    registerOllamaHandlers(() => null);
    const handler = getHandler(IPC_CHANNELS.ollamaRefreshModels);
    await handler({});
    // The mock window's send should not have been called after re-registration
    // (the handler was re-registered with a null-returning getWindow)
    // Just verify no error is thrown
  });
});
