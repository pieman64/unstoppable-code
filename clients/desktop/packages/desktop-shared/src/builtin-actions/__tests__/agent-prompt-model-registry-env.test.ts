const ENV_KEYS = [
  'CANOPY_CLAUDE_MODELS',
  'CANOPY_CODEX_MODELS',
  'CANOPY_OLLAMA_MODELS',
  'CANOPY_MODEL_ALIASES',
  'CANOPY_MODEL_THINKING_LEVELS',
  'CANOPY_PREF_RTK_ENABLED',
  'CANOPY_PREF_LOCAL_MEMORY_ENABLED',
] as const;

describe('agent-prompt model registry env hydration', () => {
  let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

  beforeEach(() => {
    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    jest.resetModules();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (typeof value === 'string') {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
    jest.resetModules();
  });

  it('preserves env-configured Claude ultra thinking support', async () => {
    process.env.CANOPY_CLAUDE_MODELS = JSON.stringify(['claude-ultra']);
    process.env.CANOPY_CODEX_MODELS = JSON.stringify([]);
    process.env.CANOPY_MODEL_THINKING_LEVELS = JSON.stringify({
      'claude-ultra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    });
    process.env.CANOPY_PREF_RTK_ENABLED = 'false';

    const { buildQueryOptions } = await import('../agent-prompt/logic');

    const options = buildQueryOptions({
      cwd: '/tmp/repo',
      maxTurns: 1,
      model: 'claude-ultra',
      permissionPreset: 'none',
      thinkingLevel: 'ultra',
    });

    expect(options.effort).toBe('xhigh');
    // Local memory is opt-in and the preference env var is absent here, so
    // no native-memory suppression key is added (CAN-1969).
    expect(options.settings).toEqual({
      ultracode: true,
    });
  });

  it('merges the native-memory suppression with ultra settings when local memory is enabled', async () => {
    process.env.CANOPY_CLAUDE_MODELS = JSON.stringify(['claude-ultra']);
    process.env.CANOPY_CODEX_MODELS = JSON.stringify([]);
    process.env.CANOPY_MODEL_THINKING_LEVELS = JSON.stringify({
      'claude-ultra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    });
    process.env.CANOPY_PREF_RTK_ENABLED = 'false';
    process.env.CANOPY_PREF_LOCAL_MEMORY_ENABLED = 'true';

    const { buildQueryOptions } = await import('../agent-prompt/logic');

    const options = buildQueryOptions({
      cwd: '/tmp/repo',
      maxTurns: 1,
      model: 'claude-ultra',
      permissionPreset: 'none',
      thinkingLevel: 'ultra',
    });

    expect(options.settings).toEqual({
      ultracode: true,
      autoMemoryEnabled: false,
    });
  });

  it('preserves an empty env-configured thinking-level list', async () => {
    process.env.CANOPY_CLAUDE_MODELS = JSON.stringify(['claude-no-thinking']);
    process.env.CANOPY_CODEX_MODELS = JSON.stringify([]);
    process.env.CANOPY_MODEL_THINKING_LEVELS = JSON.stringify({
      'claude-no-thinking': [],
    });

    await import('../agent-prompt/logic');
    const sharedTypes = await import('@canopy/desktop-shared/types');

    expect(
      sharedTypes.getConfiguredSupportedThinkingLevels('claude-no-thinking'),
    ).toEqual([]);
    expect(
      sharedTypes.clampThinkingLevelForModel('high', 'claude-no-thinking'),
    ).toBe('off');
  });

  it('preserves existing model registries when model env vars are absent', async () => {
    const sharedTypes = await import('@canopy/desktop-shared/types');
    sharedTypes.initClaudeModels([{ id: 'claude-existing', label: 'Claude' }]);
    sharedTypes.initCodexModels([{ id: 'gpt-existing', label: 'Codex' }]);
    sharedTypes.initOllamaModels([
      {
        id: 'ollama-existing',
        rawModelId: 'existing',
        label: 'existing',
        show: {
          capabilities: ['completion', 'tools'],
        },
      },
    ]);
    sharedTypes.initModelAliases({ 'claude-alias': 'claude-existing' });

    await import('../agent-prompt/logic');

    expect(sharedTypes.CLAUDE_MODELS).toContain('claude-existing');
    expect(sharedTypes.CODEX_MODELS).toContain('gpt-existing');
    expect(sharedTypes.OLLAMA_MODELS).toContain('ollama-existing');
    expect(sharedTypes.resolveModelAlias('claude-alias')).toBe(
      'claude-existing',
    );
  });
});
