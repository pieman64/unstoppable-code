/**
 * @jest-environment jsdom
 */
import {
  AI_GATEWAY_MODELS,
  ALL_MODELS,
  getCanonicalCursorModel,
  getModelDisplayName,
  CLAUDE_MODELS,
  CODEX_MODELS,
  OLLAMA_MODELS,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  type CanopyCloudAccountPublicState,
  type ModelRegistrySnapshot,
  type PreferencesData,
} from '@canopy/desktop-shared/types';

const mockReconcileModelRegistry = jest.fn();
const mockSyncActiveEmptyTabToDefaults = jest.fn();
const mockApplyModelDefaults = jest.fn();
const mockApplyDeferredToolsDefaults = jest.fn();

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

let mockScopingContext:
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string }
  | undefined;

jest.mock('@/components/sidebar/useSidebarScopingContext', () => ({
  getSidebarScopingContext: (): typeof mockScopingContext => mockScopingContext,
}));

jest.mock('../chatStore', () => ({
  useChatStore: {
    getState: (): {
      applyModelDefaults: typeof mockApplyModelDefaults;
      applyDeferredToolsDefaults: typeof mockApplyDeferredToolsDefaults;
      reconcileModelRegistry: typeof mockReconcileModelRegistry;
      syncActiveEmptyTabToDefaults: typeof mockSyncActiveEmptyTabToDefaults;
    } => ({
      applyModelDefaults: mockApplyModelDefaults,
      applyDeferredToolsDefaults: mockApplyDeferredToolsDefaults,
      reconcileModelRegistry: mockReconcileModelRegistry,
      syncActiveEmptyTabToDefaults: mockSyncActiveEmptyTabToDefaults,
    }),
  },
}));

import { useModelCatalogStore } from '../modelCatalogStore';
import { useAppAdvisorStore } from '../appAdvisorStore';
import { makeTestPreferences } from '../../test-utils/preferences';
import {
  getRendererModelFactsVersion,
  isRendererModelPolicyHydrated,
  getRendererModelPolicy,
  resetRendererModelPolicyForTests,
  subscribeRendererModelFacts,
} from '../modelPolicyRuntime';

function setOllamaEnabled(enabled: boolean): void {
  (globalThis as Record<string, unknown>).__CANOPY_OLLAMA_ENABLED__ = enabled;
}

const SNAPSHOT: ModelRegistrySnapshot = {
  claude: [],
  codex: [],
  ollama: [
    {
      id: 'ollama-llama3:8b',
      rawModelId: 'llama3:8b',
      label: 'Llama 3 8B',
      show: { capabilities: ['completion', 'tools'] },
    },
  ],
  aliases: {},
};

/**
 * Catalog with one gateway-routable model per provider plus a local Ollama
 * model, which is what the org-policy cases need to distinguish "blocked",
 * "allowed", and "never governed".
 */
const POLICY_SNAPSHOT: ModelRegistrySnapshot = {
  claude: [
    {
      id: 'claude-opus-5',
      label: 'Claude Opus 5',
      gatewayId: 'anthropic/claude-opus-5',
    },
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      gatewayId: 'anthropic/claude-sonnet-5',
    },
  ],
  codex: [{ id: 'gpt-5.3-codex-spark', label: 'GPT 5.3-Codex-Spark' }],
  aiGatewayModels: [
    {
      id: 'gateway-only-policy-test',
      label: 'Gateway Only Policy Test',
      recommendedHarness: 'codex',
      contextWindow: 128_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard',
    },
  ],
  gatewayRoutes: [
    {
      modelId: 'gateway-only-policy-test',
      gatewayId: 'provider/gateway-only-policy-test',
      recommendedHarness: 'codex',
      gatewayOnly: true,
      contextWindow: 128_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard',
    },
  ],
  ollama: [
    {
      id: 'ollama-llama3:8b',
      rawModelId: 'llama3:8b',
      label: 'Llama 3 8B',
      show: { capabilities: ['completion', 'tools'] },
    },
  ],
  aliases: {},
  harnessAssignments: {
    revision: 1,
    assignments: [
      {
        modelId: 'claude-opus-5',
        source: 'claude-managed',
        harness: 'claude',
        defaultHarness: 'claude',
        configurable: false,
        overridden: false,
      },
      {
        modelId: 'claude-sonnet-5',
        source: 'claude-managed',
        harness: 'claude',
        defaultHarness: 'claude',
        configurable: false,
        overridden: false,
      },
    ],
  },
};

function accountWithPolicy(
  blockedModelIds: string[],
  reviewedModelIds: string[],
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
    enforcedSettings: [
      {
        organizationId: ORG_A,
        organizationName: 'Acme',
        policies: [{ kind: 'model-policy', blockedModelIds, reviewedModelIds }],
      },
    ],
  };
}

function stubAccount(account: CanopyCloudAccountPublicState | null): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      loadCanopyCloudAccount:
        (): Promise<CanopyCloudAccountPublicState | null> =>
          Promise.resolve(account),
    },
  });
}

describe('modelCatalogStore — org model policy filter', () => {
  beforeEach(() => {
    mockReconcileModelRegistry.mockClear();
    mockSyncActiveEmptyTabToDefaults.mockClear();
    mockSyncActiveEmptyTabToDefaults.mockResolvedValue(undefined);
  });

  afterEach(() => {
    initClaudeModels([]);
    initCodexModels([]);
    initAiGatewayModels([], []);
    initOllamaModels([]);
    useModelCatalogStore.setState({
      snapshot: null,
      policy: new Set(),
      modelGatewayEnforced: false,
    });
    setOllamaEnabled(true);
  });

  it('retains Cursor identity metadata after organization filtering removes the native row', async () => {
    const rawModelId = 'claude-opus-5[thinking=true]';
    const id = `cursor:${encodeURIComponent(rawModelId)}`;
    stubAccount(
      accountWithPolicy(
        ['anthropic/claude-opus-5'],
        ['anthropic/claude-opus-5'],
      ),
    );
    useModelCatalogStore.getState().hydrate({
      ...POLICY_SNAPSHOT,
      cursor: [{ id, rawModelId, label: 'Cursor Opus' }],
    });
    await useModelCatalogStore.getState().refreshPolicy();
    expect(CLAUDE_MODELS).not.toContain('claude-opus-5');
    expect(getCanonicalCursorModel(id)).toBe('claude-opus-5');
    expect(getModelDisplayName(id)).toBe('Claude Opus 5');
  });

  it('leaves the catalog untouched for a user in no organization', async () => {
    stubAccount(null);
    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);
    await useModelCatalogStore.getState().refreshPolicy();

    expect(CLAUDE_MODELS).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(CODEX_MODELS).toEqual(['gpt-5.3-codex-spark']);
    expect(OLLAMA_MODELS).toContain('ollama-llama3:8b');
  });

  it('mirrors enforced model-gateway policy for picker affordances', async () => {
    const account = accountWithPolicy([], []);
    account.enforcedSettings = [
      {
        organizationId: ORG_A,
        organizationName: 'Acme',
        policies: [
          {
            kind: 'model-gateway',
            baseUrl: 'https://gateway.acme.test',
            models: [],
            enforced: true,
            promptCachePassthrough: true,
          },
        ],
      },
    ];
    stubAccount(account);

    await useModelCatalogStore.getState().refreshPolicy();

    expect(useModelCatalogStore.getState().modelGatewayEnforced).toBe(true);
  });

  it('re-resolves a pristine tab after a policy snapshot is applied', () => {
    stubAccount(null);
    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);

    expect(mockSyncActiveEmptyTabToDefaults).toHaveBeenCalledTimes(1);
  });

  it('notifies model-facts subscribers after the registries are applied', () => {
    // React cannot see the module-level registries/policy that lane resolution
    // reads, so components derived from them (the composer dead-end banner)
    // subscribe to this version. The notification must land AFTER hydration, or
    // a listener re-derives against a half-applied snapshot.
    stubAccount(null);
    const seen: number[] = [];
    const unsubscribe = subscribeRendererModelFacts(() => {
      seen.push(AI_GATEWAY_MODELS.length);
    });
    const before = getRendererModelFactsVersion();

    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);

    expect(getRendererModelFactsVersion()).toBeGreaterThan(before);
    expect(seen[seen.length - 1]).toBe(AI_GATEWAY_MODELS.length);
    unsubscribe();
  });

  it('keeps the org’s own gateway models under an active model policy', async () => {
    // The reported dead end: an org enforcing BOTH a model policy and a
    // gateway. Its gateway rows can never reach `reviewedModelIds` (the policy
    // card is populated from Canopy's hosted catalog plus native-only ids), so
    // "unreviewed ⇒ blocked" stripped the models AND their routes here, and the
    // picker showed nothing the org actually permits.
    const snapshot = {
      ...POLICY_SNAPSHOT,
      aiGatewayModels: [
        ...(POLICY_SNAPSHOT.aiGatewayModels ?? []),
        {
          id: 'org-1-sonnet-5',
          label: 'Acme Sonnet 5',
          recommendedHarness: 'claude' as const,
          contextWindow: 1_000_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard' as const,
          family: 'custom' as const,
          familyLabel: 'Acme',
          vendor: `org-gateway:${ORG_A}`,
        },
      ],
      gatewayRoutes: [
        ...(POLICY_SNAPSHOT.gatewayRoutes ?? []),
        {
          modelId: 'org-1-sonnet-5',
          gatewayId: 'anthropic/acme-sonnet-5',
          recommendedHarness: 'claude' as const,
          gatewayOnly: true,
          contextWindow: 1_000_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard' as const,
          origin: 'org-gateway' as const,
          baseUrl: 'https://ai-gateway.vercel.sh',
          organizationId: ORG_A,
          promptCachePassthrough: true,
        },
      ],
    };
    stubAccount(accountWithPolicy([], ['anthropic/claude-sonnet-5']));
    useModelCatalogStore.getState().hydrate(snapshot);
    await useModelCatalogStore.getState().refreshPolicy();

    expect(AI_GATEWAY_MODELS).toContain('org-1-sonnet-5');
    // Still governed: the hosted gateway model this policy never reviewed goes.
    expect(AI_GATEWAY_MODELS).not.toContain('gateway-only-policy-test');
  });

  it('omits an explicitly blocked model, matched on its gatewayId', async () => {
    stubAccount(
      accountWithPolicy(
        ['anthropic/claude-opus-5'],
        [
          'anthropic/claude-opus-5',
          'anthropic/claude-sonnet-5',
          'gpt-5.3-codex-spark',
        ],
      ),
    );
    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);
    await useModelCatalogStore.getState().refreshPolicy();

    expect(CLAUDE_MODELS).toEqual(['claude-sonnet-5']);
    expect(CODEX_MODELS).toEqual(['gpt-5.3-codex-spark']);
    expect(
      useModelCatalogStore
        .getState()
        .harnessAssignments?.assignments.map(({ modelId }) => modelId),
    ).toEqual(['claude-sonnet-5']);
  });

  it('filters blocked harness assignments loaded directly from main', async () => {
    const harnessAssignments = POLICY_SNAPSHOT.harnessAssignments;
    if (!harnessAssignments) {
      throw new Error('Expected policy fixture harness assignments');
    }
    const account = accountWithPolicy(
      ['anthropic/claude-opus-5'],
      [
        'anthropic/claude-opus-5',
        'anthropic/claude-sonnet-5',
        'gpt-5.3-codex-spark',
      ],
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadCanopyCloudAccount: (): Promise<CanopyCloudAccountPublicState> =>
          Promise.resolve(account),
        harnessAssignments: {
          load: (): Promise<
            NonNullable<ModelRegistrySnapshot['harnessAssignments']>
          > => Promise.resolve(harnessAssignments),
        },
      },
    });
    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);
    await useModelCatalogStore.getState().refreshPolicy();
    await useModelCatalogStore.getState().loadHarnessAssignments();

    expect(
      useModelCatalogStore
        .getState()
        .harnessAssignments?.assignments.map(({ modelId }) => modelId),
    ).toEqual(['claude-sonnet-5']);
  });

  it('announces new model facts after a harness assignment lands (round-2 finding 12)', async () => {
    // `resolveLaneForTarget` decides native-lane runnability through
    // `getExecutionHarnessForModel`, which authoritative assignments change.
    // Only `applySnapshot` bumped the facts version, so a broadcast or a direct
    // load left every lane-derived surface (pristine tabs, the dead-end banner)
    // stale behind an unmoved `useSyncExternalStore` snapshot.
    const harnessAssignments = POLICY_SNAPSHOT.harnessAssignments;
    if (!harnessAssignments) {
      throw new Error('Expected policy fixture harness assignments');
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadCanopyCloudAccount: (): Promise<CanopyCloudAccountPublicState> =>
          Promise.resolve(null),
        harnessAssignments: {
          load: (): Promise<
            NonNullable<ModelRegistrySnapshot['harnessAssignments']>
          > => Promise.resolve(harnessAssignments),
        },
      },
    });
    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);
    mockSyncActiveEmptyTabToDefaults.mockClear();
    const before = getRendererModelFactsVersion();

    await useModelCatalogStore.getState().loadHarnessAssignments();

    expect(getRendererModelFactsVersion()).toBeGreaterThan(before);
    expect(mockSyncActiveEmptyTabToDefaults).toHaveBeenCalled();
  });

  it('announces exactly once while a registry snapshot is applying', () => {
    // `applySnapshot` applies the assignments mid-flight and announces at the
    // end; the assignment apply must not fire a second, half-applied notice.
    stubAccount(null);
    const seen: number[] = [];
    const unsubscribe = subscribeRendererModelFacts(() => {
      seen.push(getRendererModelFactsVersion());
    });

    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);

    unsubscribe();
    // One notice from `setRendererModelPolicy`, one from the final
    // post-hydration bump — and none from the assignment apply in between.
    expect(seen).toHaveLength(2);
  });

  it('omits a blocked gateway-only model from gateway and combined registries', async () => {
    stubAccount(
      accountWithPolicy(
        ['provider/gateway-only-policy-test'],
        [
          'anthropic/claude-opus-5',
          'anthropic/claude-sonnet-5',
          'gpt-5.3-codex-spark',
          'provider/gateway-only-policy-test',
        ],
      ),
    );
    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);
    await useModelCatalogStore.getState().refreshPolicy();

    expect(AI_GATEWAY_MODELS).not.toContain('gateway-only-policy-test');
    expect(ALL_MODELS).not.toContain('gateway-only-policy-test');
  });

  it('omits a model the org has never reviewed, and blocks a native-only model by registry id', async () => {
    stubAccount(
      accountWithPolicy([], ['anthropic/claude-opus-5', 'gpt-5.3-codex-spark']),
    );
    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);
    await useModelCatalogStore.getState().refreshPolicy();

    // Sonnet is in the catalog but absent from the reviewed snapshot, so it is
    // blocked until an admin reviews it. Spark is native-only (no gatewayId)
    // and reviewed under its registry id, so it survives.
    expect(CLAUDE_MODELS).toEqual(['claude-opus-5']);
    expect(CODEX_MODELS).toEqual(['gpt-5.3-codex-spark']);
  });

  it('never blocks Ollama models, which can never appear in a reviewed snapshot', async () => {
    // The most dangerous over-block: an unqualified "unknown ⇒ blocked" would
    // kill every local model the moment an org enables the policy.
    stubAccount(accountWithPolicy([], []));
    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);
    await useModelCatalogStore.getState().refreshPolicy();

    expect(CLAUDE_MODELS).toEqual([]);
    expect(CODEX_MODELS).toEqual([]);
    expect(OLLAMA_MODELS).toContain('ollama-llama3:8b');
  });

  it('restores the full catalog when the policy is cleared, with no restart', async () => {
    stubAccount(
      accountWithPolicy(
        ['anthropic/claude-opus-5'],
        [
          'anthropic/claude-opus-5',
          'anthropic/claude-sonnet-5',
          'gpt-5.3-codex-spark',
        ],
      ),
    );
    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);
    await useModelCatalogStore.getState().refreshPolicy();
    expect(CLAUDE_MODELS).toEqual(['claude-sonnet-5']);

    stubAccount(null);
    await useModelCatalogStore.getState().refreshPolicy();
    expect(CLAUDE_MODELS).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('refreshes the policy when main broadcasts a periodic account change', async () => {
    let account: CanopyCloudAccountPublicState | null = accountWithPolicy(
      ['anthropic/claude-opus-5'],
      [
        'anthropic/claude-opus-5',
        'anthropic/claude-sonnet-5',
        'gpt-5.3-codex-spark',
      ],
    );
    let preferencesChanged: (() => void) | undefined;
    const unsubscribeRegistry = jest.fn();
    const unsubscribePolicy = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadCanopyCloudAccount:
          (): Promise<CanopyCloudAccountPublicState | null> =>
            Promise.resolve(account),
        onModelRegistryUpdated: (): (() => void) => unsubscribeRegistry,
        onPreferencesChanged: (callback: () => void): (() => void) => {
          preferencesChanged = callback;
          return unsubscribePolicy;
        },
      },
    });
    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);

    const unsubscribe = useModelCatalogStore.getState().subscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(CLAUDE_MODELS).toEqual(['claude-sonnet-5']);

    account = null;
    preferencesChanged?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(CLAUDE_MODELS).toEqual(['claude-opus-5', 'claude-sonnet-5']);

    unsubscribe();
    expect(unsubscribeRegistry).toHaveBeenCalledTimes(1);
    expect(unsubscribePolicy).toHaveBeenCalledTimes(1);
  });
});

describe('modelCatalogStore — policy hydration flag (CAN-1929)', () => {
  afterEach(() => {
    resetRendererModelPolicyForTests();
    initClaudeModels([]);
    initCodexModels([]);
    initAiGatewayModels([], []);
    initOllamaModels([]);
    useModelCatalogStore.setState({ snapshot: null, policy: new Set() });
  });

  it('records hydration from the ACCOUNT READ even when the registry snapshot has not arrived', async () => {
    // `main.tsx` starts `getModelRegistry()` and `refreshPolicy()` in the same
    // tick, and the account read is one small decrypt against assembling the
    // whole registry snapshot — so it can land first with `snapshot` still
    // null. Recording hydration only inside `applySnapshot` left the flag false
    // for the rest of the session, which made every renderer lane resolution
    // provisional and suppressed the credits billing seed entirely.
    resetRendererModelPolicyForTests();
    expect(isRendererModelPolicyHydrated()).toBe(false);
    stubAccount(null);

    await useModelCatalogStore.getState().refreshPolicy();

    expect(useModelCatalogStore.getState().snapshot).toBeNull();
    expect(isRendererModelPolicyHydrated()).toBe(true);
  });

  it('does NOT record hydration from a registry snapshot alone', () => {
    // The registry path forwards whatever the store already holds — an empty
    // set until a real read lands — so treating it as hydrated would make a
    // blocked model read as a definitive allow for an org member whose account
    // read failed.
    resetRendererModelPolicyForTests();
    stubAccount(null);

    useModelCatalogStore.getState().hydrate(POLICY_SNAPSHOT);

    expect(isRendererModelPolicyHydrated()).toBe(false);
  });
});

describe('modelCatalogStore — Ollama build gate', () => {
  afterEach(() => {
    initOllamaModels([]);
    setOllamaEnabled(true);
  });

  it('hydrates Ollama models when Ollama is enabled (macOS)', () => {
    setOllamaEnabled(true);
    useModelCatalogStore.getState().hydrate(SNAPSHOT);
    expect(OLLAMA_MODELS).toContain('ollama-llama3:8b');
  });

  it('keeps the Ollama catalog empty when Ollama is disabled (Windows)', () => {
    setOllamaEnabled(false);
    useModelCatalogStore.getState().hydrate(SNAPSHOT);
    expect(OLLAMA_MODELS).toHaveLength(0);
  });
});

test('reconciles a pristine tab with refreshed defaults when its saved model returns', async () => {
  let registryUpdated: ((snapshot: ModelRegistrySnapshot) => void) | undefined;
  let completeLoad: (() => void) | undefined;
  let defaultModel = 'gpt-5.5';
  let activeModel = defaultModel;
  const returnedPreferences = makeTestPreferences({
    appAdvisorModel: 'gpt-future-code',
  });
  const loadPreferences = (): Promise<PreferencesData> =>
    new Promise<typeof returnedPreferences>((resolve) => {
      completeLoad = (): void => resolve(returnedPreferences);
    });
  mockApplyModelDefaults.mockImplementationOnce((prefs: PreferencesData) => {
    defaultModel = prefs.appAdvisorModel;
  });
  useAppAdvisorStore.setState({ appAdvisorModel: 'gpt-5.5' });
  mockSyncActiveEmptyTabToDefaults.mockImplementation(() => {
    activeModel = defaultModel;
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences,
      loadCanopyCloudAccount: () => Promise.resolve(null),
      onModelRegistryUpdated: (
        callback: (snapshot: ModelRegistrySnapshot) => void,
      ) => {
        registryUpdated = callback;
        return (): void => undefined;
      },
      onPreferencesChanged: () => (): void => undefined,
    },
  });
  const unsubscribe = useModelCatalogStore.getState().subscribe();
  try {
    await Promise.resolve();
    registryUpdated?.({
      ...SNAPSHOT,
      codex: [{ id: 'gpt-future-code', label: 'Future code' }],
    });
    expect(activeModel).toBe('gpt-5.5');
    completeLoad?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(activeModel).toBe('gpt-future-code');
    expect(useAppAdvisorStore.getState().appAdvisorModel).toBe(
      'gpt-future-code',
    );
  } finally {
    unsubscribe();
    mockApplyModelDefaults.mockReset();
    mockSyncActiveEmptyTabToDefaults.mockReset();
  }
});

describe('modelCatalogStore — AI Gateway catalog status', () => {
  it('mirrors the snapshot status and treats a missing status as unknown', () => {
    useModelCatalogStore
      .getState()
      .hydrate({ ...SNAPSHOT, aiGatewayCatalogStatus: 'failed' });
    expect(useModelCatalogStore.getState().aiGatewayCatalogStatus).toBe(
      'failed',
    );
    useModelCatalogStore.getState().hydrate(SNAPSHOT);
    expect(useModelCatalogStore.getState().aiGatewayCatalogStatus).toBeNull();
  });

  it('updates the status from registry broadcasts', async () => {
    let registryUpdated:
      | ((snapshot: ModelRegistrySnapshot) => void)
      | undefined;
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadPreferences: () => new Promise(() => undefined),
        loadCanopyCloudAccount: () => Promise.resolve(null),
        onModelRegistryUpdated: (
          callback: (snapshot: ModelRegistrySnapshot) => void,
        ) => {
          registryUpdated = callback;
          return (): void => undefined;
        },
        onPreferencesChanged: () => (): void => undefined,
      },
    });
    useModelCatalogStore
      .getState()
      .hydrate({ ...SNAPSHOT, aiGatewayCatalogStatus: 'loading' });
    const unsubscribe = useModelCatalogStore.getState().subscribe();
    await Promise.resolve();
    registryUpdated?.({ ...SNAPSHOT, aiGatewayCatalogStatus: 'ready' });
    expect(useModelCatalogStore.getState().aiGatewayCatalogStatus).toBe(
      'ready',
    );
    unsubscribe();
  });

  it('asks main to retry and swallows a failed request', async () => {
    const retryAiGatewayModelCatalog = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ipc'));
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { retryAiGatewayModelCatalog },
    });
    await useModelCatalogStore.getState().retryAiGatewayCatalog();
    await expect(
      useModelCatalogStore.getState().retryAiGatewayCatalog(),
    ).resolves.toBeUndefined();
    expect(retryAiGatewayModelCatalog).toHaveBeenCalledTimes(2);
  });
});

describe('modelCatalogStore — owner-scoped policy and gateways (CAN-3464)', () => {
  const ORG_A_ROW = 'org-a-sonnet';
  const ORG_B_ROW = 'org-b-sonnet';

  function orgRow(
    id: string,
    organizationId: string,
    organizationName: string,
  ): {
    model: NonNullable<ModelRegistrySnapshot['aiGatewayModels']>[number];
    route: NonNullable<ModelRegistrySnapshot['gatewayRoutes']>[number];
  } {
    return {
      model: {
        id,
        label: `${organizationName} Sonnet`,
        recommendedHarness: 'claude',
        contextWindow: 1_000_000,
        supportsPromptCaching: true,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
        family: 'custom',
        familyLabel: organizationName,
        vendor: `org-gateway:${organizationId}`,
      },
      route: {
        modelId: id,
        gatewayId: `anthropic/${id}`,
        recommendedHarness: 'claude',
        gatewayOnly: true,
        contextWindow: 1_000_000,
        supportsPromptCaching: true,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
        origin: 'org-gateway',
        baseUrl: `https://gw.${organizationName.toLowerCase()}.test`,
        organizationId,
        promptCachePassthrough: true,
      },
    };
  }

  const rowA = orgRow(ORG_A_ROW, ORG_A, 'Acme');
  const rowB = orgRow(ORG_B_ROW, ORG_B, 'Beta');
  const TWO_ORG_SNAPSHOT: ModelRegistrySnapshot = {
    ...POLICY_SNAPSHOT,
    aiGatewayModels: [
      ...(POLICY_SNAPSHOT.aiGatewayModels ?? []),
      rowA.model,
      rowB.model,
    ],
    gatewayRoutes: [
      ...(POLICY_SNAPSHOT.gatewayRoutes ?? []),
      rowA.route,
      rowB.route,
    ],
  };

  /** Org A blocks Claude Opus 5 and enforces its gateway; Org B does neither. */
  function twoOrgAccount(): CanopyCloudAccountPublicState {
    return {
      hasApiKey: true,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      storageAvailable: true,
      enforcedSettings: [
        {
          organizationId: ORG_A,
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: ['anthropic/claude-opus-5'],
              reviewedModelIds: [
                'anthropic/claude-opus-5',
                'anthropic/claude-sonnet-5',
                'gpt-5.3-codex-spark',
                'provider/gateway-only-policy-test',
              ],
            },
            {
              kind: 'model-gateway',
              baseUrl: 'https://gw.acme.test',
              models: [],
              enforced: true,
              promptCachePassthrough: true,
            },
          ],
        },
        {
          organizationId: ORG_B,
          organizationName: 'Beta',
          policies: [
            {
              kind: 'model-gateway',
              baseUrl: 'https://gw.beta.test',
              models: [],
              enforced: false,
              promptCachePassthrough: true,
            },
          ],
        },
      ],
    };
  }

  async function hydrateForOwner(
    context: typeof mockScopingContext,
  ): Promise<void> {
    mockScopingContext = context;
    stubAccount(twoOrgAccount());
    useModelCatalogStore.getState().syncActiveOwner();
    useModelCatalogStore.getState().hydrate(TWO_ORG_SNAPSHOT);
    await useModelCatalogStore.getState().refreshPolicy();
  }

  beforeEach(() => {
    mockReconcileModelRegistry.mockClear();
    mockSyncActiveEmptyTabToDefaults.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockScopingContext = undefined;
    initClaudeModels([]);
    initCodexModels([]);
    initAiGatewayModels([], []);
    initOllamaModels([]);
    resetRendererModelPolicyForTests();
    useModelCatalogStore.setState({
      snapshot: null,
      policy: new Set(),
      policyIndex: { byOrganization: new Map(), union: new Set() },
      gatewayIndex: { byOrganization: new Map(), accountUnavailable: false },
      activeOwner: undefined,
      activeOrganizationName: undefined,
      modelGatewayEnforced: false,
    });
  });

  it("applies Org A's policy and gateway only to Org A's work", async () => {
    await hydrateForOwner({ kind: 'organization', organizationId: ORG_A });

    expect(CLAUDE_MODELS).not.toContain('claude-opus-5');
    expect(AI_GATEWAY_MODELS).toContain(ORG_A_ROW);
    expect(AI_GATEWAY_MODELS).not.toContain(ORG_B_ROW);
    expect(useModelCatalogStore.getState()).toMatchObject({
      modelGatewayEnforced: true,
      activeOrganizationName: 'Acme',
    });
  });

  it("leaves Org B's work free of Org A's policy and gateway", async () => {
    await hydrateForOwner({ kind: 'organization', organizationId: ORG_B });

    expect(CLAUDE_MODELS).toContain('claude-opus-5');
    expect(AI_GATEWAY_MODELS).toContain(ORG_B_ROW);
    expect(AI_GATEWAY_MODELS).not.toContain(ORG_A_ROW);
    expect(useModelCatalogStore.getState()).toMatchObject({
      modelGatewayEnforced: false,
      activeOrganizationName: 'Beta',
    });
  });

  it('gives Personal work no org policy and no org gateway rows', async () => {
    await hydrateForOwner({ kind: 'personal' });

    expect(CLAUDE_MODELS).toContain('claude-opus-5');
    expect(AI_GATEWAY_MODELS).not.toContain(ORG_A_ROW);
    expect(AI_GATEWAY_MODELS).not.toContain(ORG_B_ROW);
    expect(getRendererModelPolicy().size).toBe(0);
    expect(useModelCatalogStore.getState()).toMatchObject({
      modelGatewayEnforced: false,
      activeOrganizationName: undefined,
    });
  });

  it('applies the strict union while the owner is unknown', async () => {
    await hydrateForOwner(undefined);

    expect(CLAUDE_MODELS).not.toContain('claude-opus-5');
    // No org row is hidden for an unknown owner, but the union still governs
    // them: Org A's route is exempt only from Org A's policy, so Org A's
    // "unreviewed ⇒ blocked" rule removes Org B's row. Intentional, and the
    // reason main records an unknown owner.
    expect(AI_GATEWAY_MODELS).toContain(ORG_A_ROW);
    expect(AI_GATEWAY_MODELS).not.toContain(ORG_B_ROW);
    expect(useModelCatalogStore.getState().modelGatewayEnforced).toBe(true);
    expect(mockReconcileModelRegistry).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(Set),
      expect.objectContaining({
        owner: undefined,
        gatewayEnforced: true,
        gatewayEnforcingOrganizationIds: [ORG_A],
      }),
    );
  });

  it('re-projects the catalog when the navigation owner changes', async () => {
    await hydrateForOwner({ kind: 'personal' });
    expect(CLAUDE_MODELS).toContain('claude-opus-5');

    mockScopingContext = { kind: 'organization', organizationId: ORG_A };
    useModelCatalogStore.getState().syncActiveOwner();

    expect(CLAUDE_MODELS).not.toContain('claude-opus-5');
    expect(AI_GATEWAY_MODELS).toContain(ORG_A_ROW);
    expect(useModelCatalogStore.getState().activeOwner).toEqual({
      kind: 'organization',
      organizationId: ORG_A,
    });
  });

  it('does not re-project the catalog when the owner is unchanged', async () => {
    await hydrateForOwner({ kind: 'organization', organizationId: ORG_A });
    const snapshot = useModelCatalogStore.getState().snapshot;
    mockReconcileModelRegistry.mockClear();

    useModelCatalogStore.getState().syncActiveOwner();

    expect(useModelCatalogStore.getState().snapshot).toBe(snapshot);
    expect(mockReconcileModelRegistry).not.toHaveBeenCalled();
  });

  it('hands chat reconciliation the owner and its organization name', async () => {
    await hydrateForOwner({ kind: 'organization', organizationId: ORG_A });

    expect(mockReconcileModelRegistry).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(Set),
      expect.objectContaining({
        owner: { kind: 'organization', organizationId: ORG_A },
        organizationName: 'Acme',
      }),
    );
  });
});
