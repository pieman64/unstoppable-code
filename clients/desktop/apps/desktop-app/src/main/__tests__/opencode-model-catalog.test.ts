import {
  getChatHarnessOptions,
  getExecutionHarnessForModel,
  getProviderForChatModel,
  getProviderForModel,
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  getCursorModelMappings,
  initModelAliases,
  initOllamaModels,
  initOpenCodeModels,
  type GatewayRouteEntry,
  type ModelHarness,
} from '@canopy/desktop-shared/types';
import { buildModelCatalogOption } from '@canopy/desktop-shared/lib/model-catalog-projection';

const mockRuntimeAvailable = jest.fn<boolean | undefined, []>(() => true);
const mockVerifyRuntime = jest.fn<Promise<boolean>, []>();
let mockStoredOverrides: Record<string, ModelHarness> = {};
jest.mock('../opencode/runtime-availability', () => ({
  peekOpenCodeRuntimeAvailability: (): boolean | undefined =>
    mockRuntimeAvailable(),
  isOpenCodeRuntimeAvailable: (): Promise<boolean> => mockVerifyRuntime(),
}));
jest.mock('../ollama', () => ({
  getOllamaService: (): { getCachedModels: () => never[] } => ({
    getCachedModels: (): never[] => [],
  }),
}));
jest.mock('@canopy/desktop-shared/node/model-harnesses', () => ({
  ModelHarnessOverrideStore: class {
    load(): Promise<Record<string, ModelHarness>> {
      return Promise.resolve({ ...mockStoredOverrides });
    }
    getCachedOverrides(): Record<string, ModelHarness> {
      return { ...mockStoredOverrides };
    }
  },
}));
import {
  getSynchronousModelRegistrySnapshot,
  initializeModelHarnessRegistry,
  refreshModelHarnessAssignments,
  resetModelHarnessRegistryForTests,
} from '../models/model-registry';

function route(
  modelId: string,
  recommendedHarness: 'claude' | 'codex' = 'codex',
): GatewayRouteEntry {
  return {
    modelId,
    gatewayId: `provider/${modelId}`,
    family: recommendedHarness === 'claude' ? 'claude' : 'gpt',
    recommendedHarness,
    gatewayOnly: modelId !== 'native-claude',
    contextWindow: 64_000,
    supportsPromptCaching: false,
    supportedThinkingLevels: ['high'],
    toolSchemaProfile: 'standard',
  };
}

describe('OpenCode managed model choices', () => {
  beforeEach(() => {
    mockRuntimeAvailable.mockReturnValue(true);
    mockStoredOverrides = {};
    mockVerifyRuntime.mockReset();
    resetModelHarnessRegistryForTests();
    initClaudeModels([
      { id: 'native-claude', label: 'Claude', contextWindow: 200_000 },
    ]);
    initCodexModels([]);
    initCursorModels([]);
    initOpenCodeModels([]);
    initOllamaModels([]);
    initModelAliases({ managed_alias: 'managed' });
    const routes: GatewayRouteEntry[] = [
      route('native-claude', 'claude'),
      route('managed'),
      { ...route('flat'), toolSchemaProfile: 'flat' },
    ];
    initAiGatewayModels(
      routes
        .filter((entry) => entry.gatewayOnly)
        .map((entry) => ({
          ...entry,
          id: entry.modelId,
          label: entry.modelId,
        })),
      routes,
    );
    initAgentModels([
      {
        id: 'agent_model_managed',
        name: 'Managed reviewer',
        baseModel: 'managed',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-12T00:00:00.000Z',
        updatedAt: '2026-10-12T00:00:00.000Z',
        available: true,
      },
    ]);
  });

  afterEach(() => {
    resetModelHarnessRegistryForTests();
    initAgentModels([]);
    initAiGatewayModels([], []);
    initModelAliases({});
    initClaudeModels([]);
  });

  it('offers explicit gateway choices without changing native defaults or requiring native model discovery', () => {
    const assignments = refreshModelHarnessAssignments();
    expect(
      assignments.assignments.find((row) => row.modelId === 'native-claude'),
    ).toMatchObject({
      source: 'claude-managed',
      harness: 'claude',
      availableHarnesses: ['claude'],
      chatHarnesses: ['claude', 'opencode'],
    });
    expect(
      assignments.assignments.find((row) => row.modelId === 'managed'),
    ).toMatchObject({
      source: 'ai-gateway',
      availableHarnesses: ['claude', 'codex', 'opencode'],
      chatHarnesses: ['claude', 'codex', 'opencode'],
    });
    expect(getSynchronousModelRegistrySnapshot().opencode).toEqual([]);
    expect(getExecutionHarnessForModel('native-claude')).toBe('claude');
    expect(getProviderForModel('native-claude')).toBe('claude');
    expect(getChatHarnessOptions('native-claude')).toContain('opencode');
    expect(getChatHarnessOptions('flat')).not.toContain('opencode');
    expect(getChatHarnessOptions('ollama:local')).not.toContain('opencode');
  });

  it.each([undefined, false])(
    'does not advertise a cold or disconnected runtime: %s',
    (available) => {
      mockRuntimeAvailable.mockReturnValue(available);
      refreshModelHarnessAssignments();
      expect(getChatHarnessOptions('managed')).not.toContain('opencode');
      expect(getChatHarnessOptions('native-claude')).not.toContain('opencode');
    },
  );

  it('resolves aliases and custom Agents to their exact route capabilities', () => {
    refreshModelHarnessAssignments();
    for (const id of [
      'native-claude',
      'managed_alias',
      'agent_model_managed',
    ]) {
      expect(getChatHarnessOptions(id)).toContain('opencode');
      const option = buildModelCatalogOption(id, { provider: 'claude' });
      if (!option) throw new Error(`Missing catalog option for ${id}`);
      expect(option.id).toBe(id);
      expect(option.harnessChoices).toContainEqual({
        harness: 'opencode',
        provider: 'opencode',
        supportedThinkingLevels: [],
        contextWindow: 64_000,
        supportsImages: false,
        supportsFastMode: false,
        funding: 'ai-credits',
      });
    }
  });

  it('keeps Cursor catalog choices on their managed model IDs', () => {
    initCursorModels([
      {
        id: 'cursor:native-claude',
        rawModelId: 'native-claude',
        label: 'Claude via Cursor',
      },
    ]);
    refreshModelHarnessAssignments();
    expect(getCursorModelMappings()['native-claude']).toBe(
      'cursor:native-claude',
    );
    expect(getChatHarnessOptions('native-claude')).toContain('cursor');
    const native = buildModelCatalogOption('native-claude', {
      provider: 'claude',
    });
    if (!native) throw new Error('Missing native Claude catalog option');
    expect(
      native.harnessChoices?.map((choice) => choice.harness),
    ).not.toContain('cursor');
    expect(native.harnessChoices?.map((choice) => choice.harness)).toContain(
      'opencode',
    );
    expect(
      buildModelCatalogOption('cursor:native-claude', { provider: 'cursor' }),
    ).toMatchObject({
      id: 'cursor:native-claude',
      harness: 'cursor',
      provider: 'cursor',
    });
  });

  it('projects a default-model Agent with the destination model harness choices', () => {
    initAgentModels([
      {
        id: 'agent_model_inherited',
        name: 'Inherited reviewer',
        baseModel: 'default',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-12T00:00:00.000Z',
        updatedAt: '2026-10-12T00:00:00.000Z',
        available: true,
      },
    ]);
    refreshModelHarnessAssignments();
    const option = buildModelCatalogOption('agent_model_inherited', {
      provider: 'claude',
      agentDefaultModel: 'managed',
    });
    if (!option) throw new Error('Missing inherited Agent catalog option');
    expect(option.id).toBe('agent_model_inherited');
    expect(option.harnessChoices).toContainEqual({
      harness: 'opencode',
      provider: 'opencode',
      supportedThinkingLevels: [],
      contextWindow: 64_000,
      supportsImages: false,
      supportsFastMode: false,
      funding: 'ai-credits',
    });
  });

  it('uses an API-only saved OpenCode default while keeping native IDs native', () => {
    refreshModelHarnessAssignments({
      managed: 'opencode',
      'native-claude': 'opencode',
    });
    expect(getProviderForModel('managed')).toBe('opencode');
    expect(getExecutionHarnessForModel('managed')).toBe('opencode');
    expect(getProviderForModel('native-claude')).toBe('claude');
    expect(getExecutionHarnessForModel('native-claude')).toBe('claude');
  });

  it('verifies a saved OpenCode default before the initial assignment snapshot', async () => {
    mockRuntimeAvailable.mockReturnValue(undefined);
    mockStoredOverrides = { managed: 'opencode' };
    mockVerifyRuntime.mockImplementation(() => {
      mockRuntimeAvailable.mockReturnValue(true);
      return Promise.resolve(true);
    });
    await initializeModelHarnessRegistry();
    expect(mockVerifyRuntime).toHaveBeenCalledTimes(1);
    expect(getExecutionHarnessForModel('managed')).toBe('opencode');
  });

  it('retains a disconnected saved default for explicit reconnection', async () => {
    mockRuntimeAvailable.mockReturnValue(undefined);
    mockStoredOverrides = { managed: 'opencode' };
    mockVerifyRuntime.mockImplementation(() => {
      mockRuntimeAvailable.mockReturnValue(false);
      return Promise.resolve(false);
    });
    await initializeModelHarnessRegistry();
    expect(mockVerifyRuntime).toHaveBeenCalledTimes(1);
    expect(getChatHarnessOptions('managed')).not.toContain('opencode');
    expect(mockStoredOverrides).toEqual({ managed: 'opencode' });
    mockRuntimeAvailable.mockReturnValue(true);
    refreshModelHarnessAssignments();
    expect(getExecutionHarnessForModel('managed')).toBe('opencode');
  });

  it('retains captured OpenCode identity after route availability is withdrawn', () => {
    refreshModelHarnessAssignments();
    mockRuntimeAvailable.mockReturnValue(false);
    refreshModelHarnessAssignments();
    for (const id of ['native-claude', 'managed', 'agent_model_managed']) {
      expect(getChatHarnessOptions(id)).not.toContain('opencode');
      expect(getExecutionHarnessForModel(id, 'opencode')).toBe('opencode');
      expect(getProviderForChatModel(id, 'opencode')).toBe('opencode');
    }
  });
});
