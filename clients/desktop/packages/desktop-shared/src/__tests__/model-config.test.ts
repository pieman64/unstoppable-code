import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  modelPackageConfigSchema,
  parseModelPackageConfig,
  runtimeCodexModelEntrySchema,
} from '../model-config';
import { DEFAULT_CODEX_MODEL } from '../types';

describe('model package configuration', () => {
  const familyFields = {
    family: 'opus',
    familyLabel: 'Opus',
    vendor: 'anthropic',
    sortOrder: 1,
  };
  it('defaults Codex to GPT 6.1 Sol', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-6.1-sol');
  });

  it('validates and normalizes the real package.json', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    const config = parseModelPackageConfig(pkg);

    expect(config.claudeModels).toHaveLength(11);
    expect(config.codexModels).toHaveLength(9);
    const astra = config.codexModels[0];
    const gpt61Sol = config.codexModels.find(
      (entry) => entry.id === 'gpt-6.1-sol',
    );
    const gpt61Terra = config.codexModels.find(
      (entry) => entry.id === 'gpt-6.1-terra',
    );
    const gpt6Sol = config.codexModels.find(
      (entry) => entry.id === 'gpt-6-sol',
    );
    const gpt6Luna = config.codexModels.find(
      (entry) => entry.id === 'gpt-6-luna',
    );
    const sol = config.codexModels.find((entry) => entry.id === 'gpt-5.6-sol');
    const terra = config.codexModels.find(
      (entry) => entry.id === 'gpt-5.6-terra',
    );
    expect(astra).toMatchObject({
      id: 'gpt-6-astra',
      label: 'GPT 6 Astra',
      family: 'codex',
      familyLabel: 'Codex',
      vendor: 'openai',
      sortOrder: 40,
    });
    expect(astra?.gatewayId).toBeUndefined();
    expect(astra?.description).toBe(
      'Frontier Codex model for complex coding work',
    );
    expect(gpt61Sol).toMatchObject({
      label: 'GPT 6.1 Sol',
      sortOrder: 41,
      description: 'Reliable Codex model for everyday coding work',
      showMoreOnly: false,
      cursorModelId: 'gpt-6.1-sol',
    });
    expect(gpt61Terra).toMatchObject({
      label: 'GPT 6.1 Terra',
      sortOrder: 42,
      description: 'Balanced Codex model for everyday development',
      contextWindow: 500000,
      showMoreOnly: false,
      cursorModelId: 'gpt-6.1-terra',
    });
    expect(gpt61Terra?.gatewayId).toBeUndefined();
    expect(gpt6Sol).toMatchObject({
      label: 'GPT 6 Sol',
      sortOrder: 44,
      description: 'Reliable Codex model for everyday coding work',
      showMoreOnly: true,
      cursorModelId: 'gpt-6-sol',
    });
    expect(gpt6Luna).toMatchObject({
      label: 'GPT 6 Luna',
      sortOrder: 43,
      description: 'Fast Codex model for focused coding tasks',
      gatewayId: 'openai/gpt-6-luna',
      showMoreOnly: false,
      cursorModelId: 'gpt-6-luna',
    });
    expect(sol?.description).toBe(
      'Reliable Codex model for complex coding work',
    );
    expect(astra?.supportedThinkingLevels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(gpt61Sol?.supportedThinkingLevels).toEqual(
      astra?.supportedThinkingLevels,
    );
    expect(gpt61Terra?.supportedThinkingLevels).toEqual(
      astra?.supportedThinkingLevels,
    );
    expect(gpt6Sol?.supportedThinkingLevels).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    const gpt56Levels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
    expect(gpt6Luna?.supportedThinkingLevels).toEqual(gpt56Levels);
    expect(sol?.supportedThinkingLevels).toEqual(gpt56Levels);
    expect(terra?.supportedThinkingLevels).toEqual(gpt56Levels);
    expect(terra?.showMoreOnly).toBe(true);
    expect(
      config.claudeModels.find(({ id }) => id === 'opus[1m]'),
    ).toMatchObject({
      label: 'Opus 5.5',
      gatewayId: 'anthropic/claude-opus-5.5',
    });
    expect(
      config.claudeModels.find(({ id }) => id === 'claude-opus-5'),
    ).toMatchObject({
      label: 'Opus 5',
      gatewayId: 'anthropic/claude-opus-5',
    });
    expect(config.claudeModels.find(({ id }) => id === 'sonnet')).toMatchObject(
      {
        label: 'Sonnet 5.5',
        gatewayId: 'anthropic/claude-sonnet-5.5',
        cursorModelId: 'claude-sonnet-5-5',
        showMoreOnly: false,
      },
    );
    expect(
      config.claudeModels.find(({ id }) => id === 'claude-sonnet-5'),
    ).toMatchObject({
      label: 'Sonnet 5',
      gatewayId: 'anthropic/claude-sonnet-5',
      showMoreOnly: true,
    });
    expect(config.claudeModels.find(({ id }) => id === 'haiku')).toMatchObject({
      label: 'Haiku 5.5',
      contextWindow: 1000000,
      gatewayId: 'anthropic/claude-haiku-5.5',
      cursorModelId: 'claude-haiku-5-5',
      showMoreOnly: false,
    });
    expect(
      config.claudeModels.find(({ id }) => id === 'claude-haiku-4-5-20251001'),
    ).toMatchObject({
      label: 'Haiku 4.5',
      contextWindow: 200000,
      gatewayId: 'anthropic/claude-haiku-4.5',
      showMoreOnly: true,
    });
    const fable = config.claudeModels.find(
      (entry) => entry.id === 'claude-fable-5-1',
    );
    expect(fable).toMatchObject({
      label: 'Fable 5.1',
      gatewayId: 'anthropic/claude-fable-5.1',
      extraChargeOnly: true,
      extraChargeMessage:
        'Depending on your Claude plan, this model may require extra usage credits',
    });
    expect(fable?.featureFlag).toBeUndefined();
    expect(config.modelAliases).toMatchObject({
      fable: 'claude-fable-5-1',
      'fable[1m]': 'claude-fable-5-1',
      'claude-opus-5-5': 'opus[1m]',
      'claude-sonnet-5-5': 'sonnet',
      'claude-haiku-5-5': 'haiku',
      'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
    });
    expect(config.modelAliases).not.toHaveProperty('haiku');
    expect(config.modelAliases).not.toHaveProperty('claude-sonnet-5');
    expect(config.modelAliases).not.toHaveProperty('claude-fable-5');
    expect(config.modelAliases).not.toHaveProperty('claude-opus-4-8');
    expect(config.modelAliases).not.toHaveProperty('claude-opus-4-7');
    expect(config.modelAliases).not.toHaveProperty('claude-opus-4-6');
    // Retired Codex models resolve to their GPT 6 successors.
    expect(config.modelAliases).toMatchObject({
      'gpt-5.4': 'gpt-6-sol',
      'gpt-5.4-mini': 'gpt-6-luna',
      'gpt-5.5': 'gpt-6.1-sol',
    });
    expect(config.codexModels.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining(['gpt-5.4', 'gpt-5.4-mini']),
    );
    expect(config.codexModels.map(({ id }) => id)).not.toContain('gpt-5.5');

    expect(
      config.claudeModels.map(({ family, familyLabel }) => [
        family,
        familyLabel,
      ]),
    ).toEqual(Array(11).fill(['claude', 'Claude']));
    expect(
      config.codexModels.map(({ family, familyLabel }) => [
        family,
        familyLabel,
      ]),
    ).toEqual(Array(9).fill(['codex', 'Codex']));
    expect(
      config.claudeModels
        .filter(({ showMoreOnly }) => showMoreOnly)
        .map(({ id }) => id),
    ).toEqual([
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-haiku-4-5-20251001',
    ]);
    expect(
      config.codexModels
        .filter(({ showMoreOnly }) => showMoreOnly)
        .map(({ id }) => id),
    ).toEqual(['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  });

  it('applies native-section harness defaults', () => {
    const config = parseModelPackageConfig({
      'claude-code': {
        models: [{ id: 'claude-a', label: 'Claude A', ...familyFields }],
      },
      codex: {
        models: [
          {
            id: 'codex-a',
            label: 'Codex A',
            ...familyFields,
            sortOrder: 2,
          },
        ],
      },
    });

    expect(config.claudeModels.map(({ id, harness }) => [id, harness])).toEqual(
      [['claude-a', 'claude']],
    );
    expect(config.codexModels[0]?.harness).toBe('codex');
  });

  it('rejects duplicate ids, gateway IDs, and unknown aliases', () => {
    const result = modelPackageConfigSchema.safeParse({
      'claude-code': {
        models: [
          {
            id: 'duplicate',
            label: 'Claude',
            gatewayId: 'vendor/shared',
            ...familyFields,
          },
        ],
        modelAliases: { missing: 'not-configured' },
      },
      codex: {
        models: [
          { id: 'duplicate', label: 'Codex', ...familyFields },
          {
            id: 'second',
            label: 'Second',
            gatewayId: 'vendor/shared',
            ...familyFields,
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(({ message }) => message);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringContaining('duplicate model id'),
          expect.stringContaining('alias targets unknown model id'),
          expect.stringContaining('duplicate gatewayId'),
        ]),
      );
    }
  });

  it('merges Codex-section aliases and validates them like Claude aliases', () => {
    const config = parseModelPackageConfig({
      'claude-code': {
        models: [{ id: 'claude-a', label: 'Claude A', ...familyFields }],
        modelAliases: { 'claude-old': 'claude-a' },
      },
      codex: {
        models: [
          { id: 'codex-a', label: 'Codex A', ...familyFields, sortOrder: 2 },
        ],
        modelAliases: { 'codex-old': 'codex-a' },
      },
    });
    expect(config.modelAliases).toEqual({
      'claude-old': 'claude-a',
      'codex-old': 'codex-a',
    });

    const result = modelPackageConfigSchema.safeParse({
      'claude-code': {
        models: [{ id: 'claude-a', label: 'Claude A', ...familyFields }],
        modelAliases: { shared: 'claude-a' },
      },
      codex: {
        models: [
          { id: 'codex-a', label: 'Codex A', ...familyFields, sortOrder: 2 },
        ],
        modelAliases: {
          shared: 'codex-a',
          'codex-a': 'claude-a',
          'codex-missing': 'not-configured',
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.map(({ path, message }) => [
          path.join('.'),
          message,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['codex.modelAliases.shared', 'duplicate model alias: shared'],
          [
            'codex.modelAliases.codex-a',
            'alias collides with canonical model id: codex-a',
          ],
          [
            'codex.modelAliases.codex-missing',
            'alias targets unknown model id: not-configured',
          ],
        ]),
      );
    }
  });

  it('rejects duplicate sortOrder values within a vendor', () => {
    const result = modelPackageConfigSchema.safeParse({
      codex: {
        models: [
          {
            id: 'sol',
            label: 'Sol',
            family: 'gpt-5.6',
            familyLabel: 'GPT 5.6',
            vendor: 'openai',
            sortOrder: 50,
          },
          {
            id: 'terra',
            label: 'Terra',
            family: 'gpt-5.6',
            familyLabel: 'GPT 5.6',
            vendor: 'openai',
            sortOrder: 50,
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ message }) => message)).toContainEqual(
        expect.stringContaining('duplicate sortOrder for vendor openai: 50'),
      );
    }
  });

  it('allows the same sortOrder for different vendors', () => {
    expect(
      modelPackageConfigSchema.safeParse({
        'claude-code': {
          models: [
            {
              id: 'opus',
              label: 'Opus',
              family: 'opus',
              familyLabel: 'Opus',
              vendor: 'anthropic',
              sortOrder: 10,
            },
          ],
        },
        codex: {
          models: [
            {
              id: 'sol',
              label: 'Sol',
              family: 'gpt-5.6',
              familyLabel: 'GPT 5.6',
              vendor: 'openai',
              sortOrder: 10,
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('permits an explicitly empty thinking-level array', () => {
    expect(
      modelPackageConfigSchema.safeParse({
        codex: {
          models: [
            {
              id: 'no-thinking',
              label: 'No Thinking',
              supportedThinkingLevels: [],
              ...familyFields,
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('accepts an optional model description', () => {
    const result = modelPackageConfigSchema.safeParse({
      codex: {
        models: [
          {
            id: 'described',
            label: 'Described',
            description: 'A model.',
            ...familyFields,
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('preserves explicit showMoreOnly values from package configuration', () => {
    const config = parseModelPackageConfig({
      codex: {
        models: [
          {
            id: 'primary',
            label: 'Primary',
            showMoreOnly: false,
            ...familyFields,
          },
          {
            id: 'specialized',
            label: 'Specialized',
            showMoreOnly: true,
            ...familyFields,
            sortOrder: 2,
          },
        ],
      },
    });

    expect(
      config.codexModels.map(({ id, showMoreOnly }) => [id, showMoreOnly]),
    ).toEqual([
      ['primary', false],
      ['specialized', true],
    ]);
  });
});

describe('runtime gateway model config', () => {
  const entry = (family: string): Record<string, unknown> => ({
    id: 'gateway-model',
    label: 'Gateway model',
    gateway: {
      gatewayId: `${family}/gateway-model`,
      family,
      recommendedHarness: 'codex',
      gatewayOnly: true,
      contextWindow: 128_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard',
    },
  });

  it('accepts any catalog family key, including one added after this build', () => {
    for (const family of ['anthropic', 'mistral', 'custom']) {
      expect(
        runtimeCodexModelEntrySchema.safeParse(entry(family)).success,
      ).toBe(true);
    }
  });

  it('rejects a malformed family key', () => {
    expect(
      runtimeCodexModelEntrySchema.safeParse(entry('Not A Family')).success,
    ).toBe(false);
  });
});
