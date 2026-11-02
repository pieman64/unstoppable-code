import {
  applyModelHarnessOverrideMutation,
  buildModelHarnessAssignmentSnapshot,
  canonicalizeModelAlias,
  DEFAULT_OLLAMA_HARNESS,
  getEffectiveModelHarness,
  getHydratedModelHarnessAssignment,
  getModelHarnessSource,
  getModelHarnessAssignmentSnapshot,
  initModelHarnessAssignments,
  normalizeModelHarnessOverrides,
  requireEffectiveModelHarness,
  ModelHarnessPolicyError,
  getAvailableModelHarnesses,
  requireHeadlessHarness,
  type ModelHarnessCatalog,
  type ModelHarnessAssignmentSnapshot,
  type ModelHarnessOverridesFile,
} from '../model-harnesses';

const catalog: ModelHarnessCatalog = {
  claudeModels: ['managed-claude'],
  codexModels: ['managed-codex'],
  aiGatewayModels: [{ id: 'gateway-model', recommendedHarness: 'codex' }],
  ollamaModels: ['ollama-local'],
  modelAliases: {
    gateway_alias: 'gateway-model',
    gateway_alias_2: 'gateway_alias',
  },
  agentBaseModels: {
    agent_gateway: 'gateway-model',
    agent_ollama: 'ollama-local',
  },
};

describe('model harness transport contracts', () => {
  it('keeps Copilot native billing and execution separate across cold starts', () => {
    const model = 'copilot:claude-sonnet-4.5';
    expect(getModelHarnessSource(model, catalog)).toBe('copilot-managed');
    expect(
      getEffectiveModelHarness(model, catalog, { [model]: 'claude' }),
    ).toBe('copilot');
    expect(getAvailableModelHarnesses(model, catalog)).toEqual(['copilot']);
    expect(() => requireHeadlessHarness('copilot')).toThrow('dispatch path');
    expect(() =>
      applyModelHarnessOverrideMutation({
        modelId: model,
        harness: 'codex',
        catalog,
        overrides: {},
      }),
    ).toThrow('locked to its managed harness');
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'does not interpret an inherited key as a model alias or agent: %s',
    (model) => {
      expect(canonicalizeModelAlias(model)).toBe(model);
      expect(getHydratedModelHarnessAssignment(model)).toBeUndefined();
      expect(getModelHarnessSource(model, catalog)).toBeUndefined();
      expect(getEffectiveModelHarness(model, catalog)).toBeUndefined();
    },
  );

  it.each(['constructor', '__proto__'])(
    'resolves explicitly configured alias and agent keys: %s',
    (model) => {
      expect(canonicalizeModelAlias(model, { [model]: 'managed-codex' })).toBe(
        'managed-codex',
      );
      expect(
        getEffectiveModelHarness(model, {
          ...catalog,
          agentBaseModels: { [model]: 'managed-codex' },
        }),
      ).toBe('codex');
    },
  );

  const snapshot: ModelHarnessAssignmentSnapshot = {
    revision: 7,
    assignments: [
      {
        modelId: 'gateway-model',
        source: 'ai-gateway',
        harness: 'claude',
        defaultHarness: 'codex',
        configurable: true,
        overridden: true,
      },
    ],
  };

  it('round-trips the frozen assignment snapshot shape through JSON', () => {
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('stores defensive copies for subprocess hydration', () => {
    initModelHarnessAssignments(snapshot);
    snapshot.assignments[0].harness = 'codex';
    const hydrated = getModelHarnessAssignmentSnapshot();
    expect(hydrated.assignments[0]?.harness).toBe('claude');
    hydrated.assignments[0].harness = 'codex';
    expect(getModelHarnessAssignmentSnapshot().assignments[0]?.harness).toBe(
      'claude',
    );
  });

  it('isolates per-chat choices from caller mutations and assignment defaults', () => {
    const chatHarnesses: NonNullable<
      ModelHarnessAssignmentSnapshot['assignments'][number]['chatHarnesses']
    > = ['claude', 'opencode'];
    const assignment = Object.assign(
      {
        modelId: 'managed-claude',
        source: 'claude-managed',
        harness: 'claude',
        defaultHarness: 'claude',
        configurable: false,
        overridden: false,
        availableHarnesses: ['claude'],
      } satisfies ModelHarnessAssignmentSnapshot['assignments'][number],
      {
        chatHarnesses,
      },
    );
    initModelHarnessAssignments({ revision: 4, assignments: [assignment] });
    assignment.availableHarnesses.length = 0;
    assignment.chatHarnesses.length = 0;
    const first = getModelHarnessAssignmentSnapshot();
    expect(first.assignments[0]).toMatchObject({
      availableHarnesses: ['claude'],
      chatHarnesses: ['claude', 'opencode'],
    });
    first.assignments[0].availableHarnesses?.pop();
    expect(getHydratedModelHarnessAssignment('managed-claude')).toMatchObject({
      availableHarnesses: ['claude'],
      chatHarnesses: ['claude', 'opencode'],
    });
  });

  it('locks the v1 overrides-file schema and Ollama default', () => {
    const file: ModelHarnessOverridesFile = {
      version: 1,
      overrides: { 'gateway-model': 'claude' },
    };
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
    expect(DEFAULT_OLLAMA_HARNESS).toBe('codex');
  });

  it('separates managed source ownership from immutable native harnesses', () => {
    expect(getModelHarnessSource('managed-claude', catalog)).toBe(
      'claude-managed',
    );
    expect(
      getEffectiveModelHarness('managed-claude', catalog, {
        'managed-claude': 'codex',
      }),
    ).toBe('claude');
    expect(
      getEffectiveModelHarness('managed-codex', catalog, {
        'managed-codex': 'claude',
      }),
    ).toBe('codex');
    expect(() =>
      applyModelHarnessOverrideMutation({
        modelId: 'managed-claude',
        harness: 'codex',
        catalog,
        overrides: {},
      }),
    ).toThrow('locked to its managed harness');
  });

  it('uses gateway recommendations and the Codex Ollama default unless overridden', () => {
    expect(getEffectiveModelHarness('gateway-model', catalog)).toBe('codex');
    expect(getEffectiveModelHarness('ollama-local', catalog)).toBe('codex');
    expect(
      getEffectiveModelHarness('gateway-model', catalog, {
        'gateway-model': 'claude',
      }),
    ).toBe('claude');
    expect(
      getEffectiveModelHarness('ollama-local', catalog, {
        'ollama-local': 'claude',
      }),
    ).toBe('claude');
  });

  it('pins explicit overrides across recommendation changes until reset', () => {
    const first = applyModelHarnessOverrideMutation({
      modelId: 'gateway-model',
      harness: 'claude',
      catalog,
      overrides: {},
    });
    const refreshed: ModelHarnessCatalog = {
      ...catalog,
      aiGatewayModels: [{ id: 'gateway-model', recommendedHarness: 'claude' }],
    };
    const assignment = buildModelHarnessAssignmentSnapshot({
      catalog: refreshed,
      overrides: first.overrides,
    }).assignments.find((value) => value.modelId === 'gateway-model');
    expect(assignment).toMatchObject({
      harness: 'claude',
      defaultHarness: 'claude',
      overridden: true,
    });
    expect(
      applyModelHarnessOverrideMutation({
        modelId: 'gateway-model',
        harness: 'claude',
        catalog: refreshed,
        overrides: first.overrides,
      }).overrides,
    ).toEqual({});
  });

  it('moves only unoverridden gateway assignments on recommendation refresh', () => {
    const refreshed: ModelHarnessCatalog = {
      ...catalog,
      aiGatewayModels: [{ id: 'gateway-model', recommendedHarness: 'claude' }],
    };
    expect(getEffectiveModelHarness('gateway-model', refreshed)).toBe('claude');
    expect(
      getEffectiveModelHarness('gateway-model', refreshed, {
        'gateway-model': 'codex',
      }),
    ).toBe('codex');
  });

  it('canonicalizes transitive aliases and stores only canonical keys', () => {
    expect(
      canonicalizeModelAlias('gateway_alias_2', catalog.modelAliases),
    ).toBe('gateway-model');
    expect(
      applyModelHarnessOverrideMutation({
        modelId: 'gateway_alias_2',
        harness: 'claude',
        catalog,
        overrides: {},
      }),
    ).toEqual({
      modelId: 'gateway-model',
      overrides: { 'gateway-model': 'claude' },
    });
  });

  it('retains valid stale overrides while rejecting malformed entries', () => {
    expect(
      normalizeModelHarnessOverrides({
        'stale-model': 'claude',
        'bad model': 'codex',
        'gateway-model': 'invalid',
      }),
    ).toEqual({ 'stale-model': 'claude' });
    expect(
      buildModelHarnessAssignmentSnapshot({
        catalog,
        overrides: { 'stale-model': 'claude' },
      }).assignments.some((value) => value.modelId === 'stale-model'),
    ).toBe(false);
  });

  it('rejects unknown execution and alias cycles', () => {
    expect(() => requireEffectiveModelHarness('missing', catalog)).toThrow(
      ModelHarnessPolicyError,
    );
    expect(() =>
      canonicalizeModelAlias('one', { one: 'two', two: 'one' }),
    ).toThrow('alias cycle');
  });

  it('inherits effective assignments through Custom Agent base models', () => {
    expect(getModelHarnessSource('agent_gateway', catalog)).toBe('ai-gateway');
    expect(
      getEffectiveModelHarness('agent_gateway', catalog, {
        'gateway-model': 'claude',
      }),
    ).toBe('claude');
    expect(getEffectiveModelHarness('agent_ollama', catalog)).toBe('codex');
  });
});
