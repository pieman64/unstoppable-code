import {
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  initModelAliases,
  initOllamaModels,
  resolveDefaultChatModel,
} from '@canopy/desktop-shared/types';

const mockListCursorModels = jest.fn(() =>
  Promise.resolve([
    {
      id: 'cursor:managed-codex%5B%5D',
      rawModelId: 'managed-codex[]',
      label: 'Cursor model',
    },
  ]),
);
jest.mock('../cursor/models', () => ({
  listCursorModels: mockListCursorModels,
}));

const mockCursorStatus = jest.fn(() =>
  Promise.resolve({
    enabled: true,
    supported: true,
    installed: true,
  }),
);
jest.mock('../cursor/runtime-status', () => ({
  cursorConnectionStatus: mockCursorStatus,
}));
jest.mock('../cursor/feature-flag', () => ({
  assertCursorHarnessEnabled: jest.fn(),
}));

const mockGatewayEnforced = jest.fn(() => Promise.resolve(false));
jest.mock('../lib/model-gateway-state', () => ({
  getModelGatewayRequirementForOwner: async (): Promise<unknown> =>
    (await mockGatewayEnforced())
      ? { kind: 'enforced', organizationIds: ['org-1'] }
      : { kind: 'unrestricted' },
}));
jest.mock('../agents/work-owner', () => ({
  resolveNavigationWorkOwner: jest
    .fn()
    .mockResolvedValue({ kind: 'organization', organizationId: 'org-1' }),
}));

let diskOverrides: Record<string, 'claude' | 'codex' | 'cursor'> = {};
const loadMock = jest.fn(() => Promise.resolve({ ...diskOverrides }));
const setMock = jest.fn(
  (modelId: string, harness: 'claude' | 'codex' | 'cursor') => {
    modelId = modelId === 'gateway_alias' ? 'gateway-model' : modelId;
    diskOverrides =
      harness === 'codex'
        ? Object.fromEntries(
            Object.entries(diskOverrides).filter(([id]) => id !== modelId),
          )
        : { ...diskOverrides, [modelId]: harness };
    return Promise.resolve({
      modelId,
      overrides: { ...diskOverrides },
      changed: true,
    });
  },
);
const resetMock = jest.fn((modelId: string) => {
  const { [modelId]: _removed, ...remaining } = diskOverrides;
  void _removed;
  diskOverrides = remaining;
  return Promise.resolve({
    modelId,
    overrides: { ...diskOverrides },
    changed: true,
  });
});

jest.mock('@canopy/desktop-shared/node/model-harnesses', () => ({
  ModelHarnessOverrideStore: class {
    load = loadMock;
    set = setMock;
    reset = resetMock;
    getCachedOverrides(): Record<string, 'claude' | 'codex' | 'cursor'> {
      return { ...diskOverrides };
    }
  },
}));

jest.mock('../ollama', () => ({
  getOllamaService: (): { getCachedModels(): never[] } => ({
    getCachedModels: (): never[] => [],
  }),
}));

import {
  initializeModelHarnessRegistry,
  modelHarnessAssignmentController,
  resetModelHarnessRegistryForTests,
} from '../models/model-registry';

describe('authoritative model harness registry', () => {
  it('hydrates a persisted Cursor default before the first chat without opening a picker', async () => {
    diskOverrides = { 'managed-codex': 'cursor' };
    await modelHarnessAssignmentController.load();
    expect(resolveDefaultChatModel('managed-codex')).toBe(
      'cursor:managed-codex%5B%5D',
    );
  });
  it('bounds startup waiting while slow discovery can publish later', async () => {
    jest.useFakeTimers();
    let finish!: (
      models: Awaited<ReturnType<typeof mockListCursorModels>>,
    ) => void;
    mockListCursorModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    diskOverrides = { 'managed-codex': 'cursor' };
    let ready = false;
    const initialization = initializeModelHarnessRegistry().then(() => {
      ready = true;
    });
    try {
      await jest.advanceTimersByTimeAsync(2_000);
      expect(ready).toBe(true);
    } finally {
      finish([
        {
          id: 'cursor:managed-codex%5B%5D',
          rawModelId: 'managed-codex[]',
          label: 'Cursor',
        },
      ]);
      await initialization;
      jest.useRealTimers();
    }
    expect(resolveDefaultChatModel('managed-codex')).toBe(
      'cursor:managed-codex%5B%5D',
    );
  });
  beforeEach(() => {
    jest.clearAllMocks();
    diskOverrides = {};
    initCursorModels([]);
    initClaudeModels([{ id: 'managed-claude', label: 'Managed Claude' }]);
    initCodexModels([{ id: 'managed-codex', label: 'Managed Codex' }]);
    initOllamaModels([]);
    initModelAliases({ gateway_alias: 'gateway-model' });
    initAiGatewayModels(
      [
        {
          id: 'gateway-model',
          label: 'Gateway Model',
          recommendedHarness: 'codex',
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'gateway-model',
          gatewayId: 'provider/gateway-model',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    resetModelHarnessRegistryForTests();
  });

  it('checks runtime availability before saving a supported Cursor default', async () => {
    const rawModelId = 'managed-codex[]';
    initCursorModels([
      {
        id: `cursor:${encodeURIComponent(rawModelId)}`,
        rawModelId,
        label: 'Cursor model',
      },
    ]);
    const saved = await modelHarnessAssignmentController.set({
      modelId: 'managed-codex',
      harness: 'cursor',
    });
    expect(
      saved.assignments.find((row) => row.modelId === 'managed-codex'),
    ).toMatchObject({ harness: 'cursor', configurable: true });
    mockCursorStatus.mockResolvedValueOnce({
      enabled: false,
      supported: true,
      installed: true,
    });
    setMock.mockClear();
    await expect(
      modelHarnessAssignmentController.set({
        modelId: 'managed-codex',
        harness: 'cursor',
      }),
    ).rejects.toThrow('unavailable');
    expect(setMock).not.toHaveBeenCalled();
  });

  it('rejects Cursor defaults when the organization requires its gateway', async () => {
    mockGatewayEnforced.mockResolvedValueOnce(true);
    await expect(
      modelHarnessAssignmentController.set({
        modelId: 'managed-codex',
        harness: 'cursor',
      }),
    ).rejects.toThrow('organization');
    expect(setMock).not.toHaveBeenCalled();
  });

  it('loads disk once and increments revisions only when effective assignments change', async () => {
    const initial = await modelHarnessAssignmentController.load();
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(initial.revision).toBe(1);
    expect(initial.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'gateway-model',
          harness: 'codex',
          configurable: true,
        }),
      ]),
    );

    const changed = await modelHarnessAssignmentController.set({
      modelId: 'gateway_alias',
      harness: 'claude',
    });
    expect(changed.revision).toBe(2);
    expect(changed.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'gateway-model',
          harness: 'claude',
          overridden: true,
        }),
      ]),
    );

    const unchanged = await modelHarnessAssignmentController.load();
    expect(unchanged.revision).toBe(2);
    expect(loadMock).toHaveBeenCalledTimes(1);

    const reset = await modelHarnessAssignmentController.reset({
      modelId: 'gateway-model',
    });
    expect(reset.revision).toBe(3);
    expect(reset.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'gateway-model',
          harness: 'codex',
          overridden: false,
        }),
      ]),
    );
  });
});
