import {
  IPC_CHANNELS,
  type CanopyApi,
  type FeatureFlagsApi,
} from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';

type IpcRendererListener = (event: unknown, data: unknown) => void;

const exposed = new Map<string, unknown>();
const mockExposeInMainWorld = jest.fn<void, [string, unknown]>(
  (key: string, value: unknown): void => {
    exposed.set(key, value);
  },
);
const mockInvoke = jest.fn<Promise<unknown>, [string]>();
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
  (): {
    createBundlesAPI: () => Record<string, never>;
  } => ({
    createBundlesAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/pipelines-api',
  (): {
    createPipelinesAPI: () => Record<string, never>;
  } => ({
    createPipelinesAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/plugins-api',
  (): {
    createPluginsAPI: () => Record<string, never>;
  } => ({
    createPluginsAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/mcp-servers-api',
  (): {
    createMcpServersAPI: () => Record<string, never>;
  } => ({
    createMcpServersAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/skills-api',
  (): {
    createSkillsAPI: () => Record<string, never>;
  } => ({
    createSkillsAPI: (): Record<string, never> => ({}),
  }),
);

function loadFeatureFlagsApi(): FeatureFlagsApi {
  return loadApi().featureFlags;
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
  const api = exposed.get('api') as CanopyApi | undefined;
  if (!api) {
    throw new Error('preload API was not exposed');
  }
  return api;
}

describe('preload featureFlags API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('bridges snapshot fetch and context refresh to typed IPC channels', async () => {
    const featureFlags = loadFeatureFlagsApi();

    await featureFlags.getSnapshot();
    await featureFlags.refreshContext();

    expect(mockInvoke).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.featureFlagsGetSnapshot,
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.featureFlagsRefreshContext,
    );
  });

  it('subscribes to snapshot broadcasts and removes the exact listener on cleanup', () => {
    const featureFlags = loadFeatureFlagsApi();
    const callback = jest.fn();

    const unsubscribe = featureFlags.onSnapshotChanged(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.featureFlagsSnapshotChanged,
    )?.[1];
    if (typeof handler !== 'function') {
      throw new Error('snapshot changed listener was not registered');
    }
    const payload = {
      ...getDefaultFeatureFlagSnapshot('ready'),
      updatedAt: '2026-05-26T00:00:00.000Z',
    };
    handler({}, payload);
    unsubscribe();

    expect(callback).toHaveBeenCalledWith(payload);
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.featureFlagsSnapshotChanged,
      handler,
    );
  });

  it('ignores feature flag snapshots missing a registered flag', () => {
    const featureFlags = loadFeatureFlagsApi();
    const callback = jest.fn();

    featureFlags.onSnapshotChanged(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.featureFlagsSnapshotChanged,
    )?.[1];
    if (typeof handler !== 'function') {
      throw new Error('snapshot changed listener was not registered');
    }

    handler(
      {},
      {
        values: {
          [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: false,
          [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: false,
        },
        status: 'ready',
        initialized: true,
        updatedAt: '2026-05-26T00:00:00.000Z',
        error: null,
      },
    );

    expect(callback).not.toHaveBeenCalled();
  });

  it.each(['5', false, NaN, Infinity])(
    'rejects malformed numeric flags (%s)',
    (rate) => {
      const api = loadFeatureFlagsApi();
      const callback = jest.fn();
      api.onSnapshotChanged(callback);
      const handler = mockOn.mock.calls.find(
        ([channel]) => channel === IPC_CHANNELS.featureFlagsSnapshotChanged,
      )?.[1];
      if (!handler) throw new Error('Missing snapshot listener');
      const snapshot = getDefaultFeatureFlagSnapshot('ready');
      handler(
        {},
        {
          ...snapshot,
          values: {
            ...snapshot.values,
            'canopy-desktop-posthog-session-replay-sample-rate': rate,
          },
        },
      );
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it('ignores model registry snapshots with unknown feature flag keys', () => {
    const api = loadApi();
    const callback = jest.fn();
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    api.onModelRegistryUpdated(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.modelRegistryUpdated,
    )?.[1];
    if (typeof handler !== 'function') {
      throw new Error('model registry listener was not registered');
    }

    handler(
      {},
      {
        claude: [
          {
            id: 'flagged-claude',
            label: 'Flagged Claude',
            featureFlag: 'unknown-flag',
          },
        ],
        codex: [],
        ollama: [],
        aliases: {},
      },
    );

    expect(callback).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[preload] Rejected model registry snapshot; check featureFlag keys and payload shape.',
      {
        claude: [
          {
            id: 'flagged-claude',
            label: 'Flagged Claude',
            featureFlag: 'unknown-flag',
          },
        ],
        codex: [],
        ollama: [],
        aliases: {},
      },
    );
    consoleErrorSpy.mockRestore();
  });

  it('accepts runtime model registry snapshots with gateway metadata', () => {
    const api = loadApi();
    const callback = jest.fn();

    api.onModelRegistryUpdated(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.modelRegistryUpdated,
    )?.[1];
    if (typeof handler !== 'function') {
      throw new Error('model registry listener was not registered');
    }

    const snapshot = {
      claude: [
        {
          id: 'gateway-claude',
          label: 'Gateway Claude',
          family: 'sonnet',
          familyLabel: 'Sonnet',
          vendor: 'Anthropic',
          sortOrder: 20,
          contextWindow: 200_000,
          gateway: {
            gatewayId: 'anthropic/gateway-claude',
            family: 'anthropic',
            recommendedHarness: 'claude',
            gatewayOnly: false,
            contextWindow: 100_000,
            supportsPromptCaching: true,
            supportedThinkingLevels: ['low', 'high'],
            toolSchemaProfile: 'standard',
          },
        },
      ],
      codex: [],
      ollama: [],
      aliases: {},
    };

    handler({}, snapshot);

    expect(callback).toHaveBeenCalledWith(snapshot);
  });

  it('accepts runtime model registry snapshots without family metadata', () => {
    const api = loadApi();
    const callback = jest.fn();

    api.onModelRegistryUpdated(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.modelRegistryUpdated,
    )?.[1];
    if (typeof handler !== 'function') {
      throw new Error('model registry listener was not registered');
    }

    const snapshot = {
      claude: [],
      codex: [
        {
          id: 'future-gateway-model',
          label: 'Future Gateway Model',
          gateway: {
            gatewayId: 'openai/future-gateway-model',
            family: 'openai',
            recommendedHarness: 'codex',
            gatewayOnly: true,
            contextWindow: 128_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: ['low', 'high'],
            toolSchemaProfile: 'standard',
          },
        },
      ],
      ollama: [],
      aliases: {},
    };

    handler({}, snapshot);

    expect(callback).toHaveBeenCalledWith(snapshot);
  });
});

describe('preload approvals API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards valid approval events and ignores malformed payloads', () => {
    const approvals = loadApi().approvals;
    const requestCallback = jest.fn();
    const cancelledCallback = jest.fn();
    const ruleAddedCallback = jest.fn();

    approvals.onRequest(requestCallback);
    approvals.onCancelled(cancelledCallback);
    approvals.onRuleAdded(ruleAddedCallback);

    const requestHandler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.approvalRequest,
    )?.[1];
    const cancelledHandler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.approvalCancelled,
    )?.[1];
    const ruleAddedHandler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.approvalRuleAdded,
    )?.[1];
    if (!requestHandler || !cancelledHandler || !ruleAddedHandler) {
      throw new Error('approval listeners were not registered');
    }

    const request = {
      requestId: 'request-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      provider: 'claude',
      title: 'Run command',
      details: { kind: 'command', command: 'npm test', cwd: '/workspace' },
    };
    const cancelled = { requestId: 'request-1' };
    const ruleAdded = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      rule: {
        id: 'rule-1',
        behavior: 'allow',
        target: { kind: 'command', pattern: 'npm test' },
        createdAt: '2026-07-28T00:00:00.000Z',
        origin: 'prompt',
      },
    };

    const upload = {
      ...request,
      requestId: 'request-2',
      title: 'Upload report.csv?',
      details: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        topOrigin: 'https://app.example',
        files: [{ displayPath: 'exports/report.csv', sizeBytes: 8 }],
      },
    };
    const uploadRule = {
      ...ruleAdded,
      rule: {
        ...ruleAdded.rule,
        id: 'rule-2',
        target: { kind: 'browser-upload', origin: 'https://upload.example' },
      },
    };

    const fileRequest = {
      ...request,
      requestId: 'request-3',
      title: 'Choose a file for upload.example',
      details: {
        kind: 'browser-file-request',
        origin: 'https://upload.example',
        topOrigin: 'https://app.example',
        purpose: 'Your résumé',
        multiple: false,
      },
    };

    requestHandler({}, request);
    requestHandler({}, upload);
    requestHandler({}, fileRequest);
    requestHandler(
      {},
      { ...fileRequest, details: { ...fileRequest.details, multiple: 'no' } },
    );
    cancelledHandler({}, cancelled);
    ruleAddedHandler({}, ruleAdded);
    ruleAddedHandler({}, uploadRule);
    requestHandler(
      {},
      {
        ...upload,
        details: { ...upload.details, files: [{ displayPath: 'a' }] },
      },
    );
    requestHandler({}, { ...request, details: {} });
    cancelledHandler({}, { requestId: 42 });
    ruleAddedHandler({}, { ...ruleAdded, rule: { id: 'bad' } });

    expect(requestCallback).toHaveBeenCalledTimes(3);
    expect(requestCallback).toHaveBeenCalledWith(request);
    expect(requestCallback).toHaveBeenCalledWith(upload);
    expect(requestCallback).toHaveBeenCalledWith(fileRequest);
    expect(cancelledCallback).toHaveBeenCalledTimes(1);
    expect(cancelledCallback).toHaveBeenCalledWith(cancelled);
    expect(ruleAddedCallback).toHaveBeenCalledTimes(2);
    expect(ruleAddedCallback).toHaveBeenCalledWith(ruleAdded);
    expect(ruleAddedCallback).toHaveBeenCalledWith(uploadRule);
  });
});

it('loads release notes through main without exposing cloud credentials', async () => {
  const api = loadApi();
  mockInvoke.mockResolvedValue([]);
  await expect(api.loadCloudReleaseNotes('1.9.0')).resolves.toEqual([]);
  expect(mockInvoke).toHaveBeenCalledWith(
    IPC_CHANNELS.settingsLoadCloudReleaseNotes,
    '1.9.0',
  );
});
