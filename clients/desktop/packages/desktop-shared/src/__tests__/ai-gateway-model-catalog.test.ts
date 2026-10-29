import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeAiGatewayModelCatalog } from '../ai-gateway-model-catalog';
import {
  initOrgGatewayModelAliases,
  resolveOwnerScopedModelId,
} from '../lib/gateway-model-availability';
import { parseModelPackageConfig } from '../model-config';
import * as sharedTypes from '../types';
import type { GatewayRouteEntry } from '../types';
import {
  AI_GATEWAY_MODEL_CATALOG_VERSION,
  type AiGatewayModelCatalogResponse,
} from '@canopy/protocol/ai-gateway-models';

const packageConfig = parseModelPackageConfig({
  'claude-code': {
    models: [
      {
        id: 'native-a',
        label: 'Native A',
        family: 'claude',
        familyLabel: 'Claude',
        vendor: 'anthropic',
        sortOrder: 10,
        gatewayId: 'provider/a',
        featureFlag: 'canopy-shared-claude-model-fable5',
        contextWindow: 200,
        supportedThinkingLevels: [],
      },
    ],
    modelAliases: { alias_a: 'native-a' },
  },
  codex: {
    models: [
      {
        id: 'native-b',
        label: 'Native B',
        family: 'codex',
        familyLabel: 'Codex',
        vendor: 'openai',
        sortOrder: 20,
        gatewayId: 'provider/b',
      },
      {
        id: 'native-only',
        label: 'Native Only',
        family: 'codex',
        familyLabel: 'Codex',
        vendor: 'openai',
        sortOrder: 30,
      },
    ],
  },
});

function catalog(
  models: Array<{
    id: string;
    gatewayId: string;
    recommendedHarness: 'claude' | 'codex';
    description?: string;
    requiresLocalHarnessSupport?: boolean;
    showMoreOnly?: boolean;
    cursorModelId?: string;
  }>,
): AiGatewayModelCatalogResponse {
  return {
    version: AI_GATEWAY_MODEL_CATALOG_VERSION,
    models: models.map((model) => ({
      ...model,
      label: `API ${model.id}`,
      family: 'anthropic' as const,
      familyLabel: 'Anthropic',
      contextWindow: 999,
      supportsPromptCaching: false,
      requiresLocalHarnessSupport: model.requiresLocalHarnessSupport ?? false,
      showMoreOnly: model.showMoreOnly ?? false,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard' as const,
    })),
  };
}

describe('mergeAiGatewayModelCatalog', () => {
  it('keeps two organizations rows distinct and resolves colliding bare ids by owner', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      orgGateways: [
        {
          organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          organizationName: 'Globex',
          baseUrl: 'https://gateway.globex.test',
          promptCachePassthrough: true,
          models: [
            {
              id: 'shared-model',
              gatewayId: 'globex/shared',
              label: 'Globex Shared',
              harness: 'codex',
              contextWindow: 100_000,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
        },
        {
          organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          organizationName: 'Acme',
          baseUrl: 'https://gateway.acme.test',
          promptCachePassthrough: false,
          models: [
            {
              id: 'shared-model',
              gatewayId: 'acme/shared',
              label: 'Acme Shared',
              harness: 'claude',
              contextWindow: 200_000,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
        },
      ],
    });

    expect(merged.aiGatewayModels.map(({ id }) => id)).toEqual([
      'shared-model@aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'shared-model@bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
    expect(
      merged.gatewayRoutes.map(({ organizationId }) => organizationId),
    ).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
    initOrgGatewayModelAliases(merged.orgGatewayModelAliases);
    expect(
      resolveOwnerScopedModelId('shared-model', {
        kind: 'organization',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).toBe('shared-model@aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(
      resolveOwnerScopedModelId('shared-model', {
        kind: 'organization',
        organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ).toBe('shared-model@bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('does not let an org row override a hosted package pin', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      featureFlags: { 'canopy-shared-claude-model-fable5': true },
      orgGateways: [
        {
          organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          organizationName: 'Acme',
          baseUrl: 'https://gateway.acme.test',
          promptCachePassthrough: true,
          models: [
            {
              id: 'acme-native-a',
              gatewayId: 'provider/a',
              label: 'Acme Native A',
              harness: 'claude',
              contextWindow: 500,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
        },
      ],
    });

    expect(merged.claudeModels[0]?.gateway?.origin).not.toBe('org-gateway');
    expect(merged.aiGatewayModels).toEqual([
      expect.objectContaining({
        id: 'acme-native-a',
        vendor: 'org-gateway:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ]);
  });
  it('carries explicit Cursor mappings onto both native and API-only entries', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      catalog: catalog([
        {
          id: 'api-native-b',
          gatewayId: 'provider/b',
          recommendedHarness: 'codex',
          cursorModelId: 'cursor-b',
        },
        {
          id: 'api-only',
          gatewayId: 'provider/c',
          recommendedHarness: 'codex',
          cursorModelId: 'cursor-c',
        },
      ]),
    });
    expect(
      merged.codexModels.find((entry) => entry.id === 'native-b'),
    ).toMatchObject({ cursorModelId: 'cursor-b' });
    expect(
      merged.aiGatewayModels.find((entry) => entry.id === 'api-only'),
    ).toMatchObject({ cursorModelId: 'cursor-c' });
  });
  it('injects org models as direct custom-family routes', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      featureFlags: { 'canopy-shared-claude-model-fable5': true },
      orgGateways: [
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          baseUrl: 'https://gateway.acme.test/v1',
          promptCachePassthrough: false,
          models: [
            {
              id: 'acme-qwen',
              gatewayId: 'vertex/qwen',
              label: 'Acme Qwen',
              harness: 'codex',
              contextWindow: 131_072,
              supportedThinkingLevels: ['low', 'high'],
              toolSchemaProfile: 'flat',
            },
          ],
        },
      ],
    });

    expect(merged.aiGatewayModels).toContainEqual(
      expect.objectContaining({
        id: 'acme-qwen',
        family: 'custom',
        familyLabel: 'Acme',
        vendor: 'org-gateway:org-1',
        supportsPromptCaching: false,
      }),
    );
    expect(merged.gatewayRoutes).toContainEqual(
      expect.objectContaining({
        modelId: 'acme-qwen',
        gatewayId: 'vertex/qwen',
        origin: 'org-gateway',
        baseUrl: 'https://gateway.acme.test/v1',
        organizationId: 'org-1',
        promptCachePassthrough: false,
      }),
    );
  });

  it('keeps an org gateway row separate from a package pin', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      featureFlags: { 'canopy-shared-claude-model-fable5': true },
      orgGateways: [
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          baseUrl: 'https://gateway.acme.test',
          promptCachePassthrough: true,
          models: [
            {
              id: 'acme-native-a',
              gatewayId: 'provider/a',
              label: 'Acme Native A',
              harness: 'claude',
              contextWindow: 500,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
        },
      ],
    });

    expect(merged.aiGatewayModels).toContainEqual(
      expect.objectContaining({
        id: 'acme-native-a',
        familyLabel: 'Acme',
        vendor: 'org-gateway:org-1',
      }),
    );
    expect(merged.claudeModels[0]?.gateway?.origin).not.toBe('org-gateway');
    expect(merged.claudeModels[0]?.familyLabel).toBe('Claude');
  });
  it('matches exact gateway IDs while preserving package identity and native data', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      catalog: catalog([
        {
          id: 'api-a',
          gatewayId: 'provider/a',
          recommendedHarness: 'claude',
        },
        {
          id: 'api-b',
          gatewayId: 'provider/b',
          recommendedHarness: 'codex',
        },
      ]),
      featureFlags: { 'canopy-shared-claude-model-fable5': true },
    });
    expect(merged.claudeModels[0]).toMatchObject({
      id: 'native-a',
      label: 'Native A',
      family: 'claude',
      familyLabel: 'Claude',
      contextWindow: 200,
      supportedThinkingLevels: [],
      gateway: { contextWindow: 999, gatewayOnly: false },
    });
    expect(merged.codexModels[0]).toMatchObject({
      family: 'codex',
      familyLabel: 'Codex',
    });
    expect(merged.modelAliases).toEqual({ alias_a: 'native-a' });
  });

  it('suppresses a matching API row when its package feature flag is disabled', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      catalog: catalog([
        {
          id: 'api-a',
          gatewayId: 'provider/a',
          recommendedHarness: 'claude',
        },
      ]),
    });
    expect(merged.claudeModels).toEqual([]);
    expect(merged.codexModels.map((model) => model.id)).not.toContain('api-a');
    expect(merged.modelAliases).toEqual({});
  });

  it('fails a mismatched managed gateway route closed and separates API-only rows', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      catalog: catalog([
        {
          id: 'mismatch',
          gatewayId: 'provider/b',
          recommendedHarness: 'claude',
        },
        {
          id: 'alias_a',
          gatewayId: 'provider/collision',
          recommendedHarness: 'codex',
        },
        {
          id: 'api-only',
          gatewayId: 'provider/only',
          recommendedHarness: 'codex',
        },
      ]),
      featureFlags: { 'canopy-shared-claude-model-fable5': true },
    });
    expect(
      merged.codexModels.find((model) => model.id === 'native-b')?.gateway,
    ).toBeUndefined();
    expect(merged.claudeModels.map((model) => model.id)).not.toContain(
      'mismatch',
    );
    expect(merged.codexModels.map((model) => model.id)).toEqual([
      'native-b',
      'native-only',
    ]);
    expect(merged.aiGatewayModels).toEqual([
      expect.objectContaining({
        id: 'api-only',
        family: 'anthropic',
        familyLabel: 'Anthropic',
        vendor: 'anthropic',
        recommendedHarness: 'codex',
      }),
    ]);
    expect(merged.gatewayRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'api-only',
          recommendedHarness: 'codex',
          gatewayOnly: true,
        }),
      ]),
    );
    expect(merged.gatewayRoutes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'native-b' }),
      ]),
    );
  });

  it('rejects gateway-only models that use the reserved Ollama prefix', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      catalog: catalog([
        {
          id: 'ollama-cloud-model',
          gatewayId: 'provider/cloud-model',
          recommendedHarness: 'codex',
        },
      ]),
      featureFlags: { 'canopy-shared-claude-model-fable5': true },
    });

    expect(merged.aiGatewayModels).toEqual([]);
    expect(merged.gatewayRoutes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'ollama-cloud-model' }),
      ]),
    );
  });

  it('hides harness-gated API models until package config explicitly supports their gateway ID', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      catalog: catalog([
        {
          id: 'gated-matched',
          gatewayId: 'provider/b',
          recommendedHarness: 'codex',
          requiresLocalHarnessSupport: true,
        },
        {
          id: 'gated-api-only',
          gatewayId: 'provider/gated',
          recommendedHarness: 'codex',
          requiresLocalHarnessSupport: true,
        },
        {
          id: 'ungated-api-only',
          gatewayId: 'provider/ungated',
          recommendedHarness: 'codex',
        },
      ]),
      featureFlags: { 'canopy-shared-claude-model-fable5': true },
    });

    expect(merged.codexModels.map((model) => model.id)).toContain('native-b');
    expect(merged.aiGatewayModels.map((model) => model.id)).toEqual([
      'ungated-api-only',
    ]);
    expect(merged.gatewayRoutes.map((route) => route.gatewayId)).not.toContain(
      'provider/gated',
    );
  });

  it('routes a harness-gated GPT 6 Luna row once the package claims its gateway ID', () => {
    const lunaPackageConfig = parseModelPackageConfig({
      'claude-code': { models: [] },
      codex: {
        models: [
          {
            id: 'gpt-6-luna',
            label: 'GPT 6 Luna',
            family: 'codex',
            familyLabel: 'Codex',
            vendor: 'openai',
            sortOrder: 42,
            contextWindow: 272_000,
            gatewayId: 'openai/gpt-6-luna',
          },
          {
            id: 'gpt-5.6-luna',
            label: 'GPT 5.6 Luna',
            family: 'codex',
            familyLabel: 'Codex',
            vendor: 'openai',
            sortOrder: 70,
            contextWindow: 272_000,
            gatewayId: 'openai/gpt-5.6-luna',
          },
        ],
      },
    });
    const hosted = catalog([
      {
        id: 'gpt-6-luna',
        gatewayId: 'openai/gpt-6-luna',
        recommendedHarness: 'codex',
        requiresLocalHarnessSupport: true,
      },
      {
        id: 'gpt-5.6-luna',
        gatewayId: 'openai/gpt-5.6-luna',
        recommendedHarness: 'codex',
      },
    ]);

    const merged = mergeAiGatewayModelCatalog({
      packageConfig: lunaPackageConfig,
      catalog: hosted,
    });

    const route = (modelId: string): GatewayRouteEntry | undefined =>
      merged.gatewayRoutes.find((entry) => entry.modelId === modelId);
    expect(route('gpt-6-luna')).toMatchObject({
      gatewayId: 'openai/gpt-6-luna',
      recommendedHarness: 'codex',
      gatewayOnly: false,
    });
    // Both Lunas carry a 272000 package value; the route takes the hosted
    // row's window, the same way for each.
    expect(route('gpt-6-luna')?.contextWindow).toBe(999);
    expect(route('gpt-6-luna')?.contextWindow).toBe(
      route('gpt-5.6-luna')?.contextWindow,
    );
    expect(merged.aiGatewayModels).toEqual([]);
  });

  it('carries the catalog description onto gateway-only and matched package models', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      catalog: catalog([
        {
          id: 'api-a',
          gatewayId: 'provider/a',
          recommendedHarness: 'claude',
          description: 'Catalog-owned subtitle',
        },
        {
          id: 'api-only',
          gatewayId: 'provider/only',
          recommendedHarness: 'codex',
          description: 'Gateway-only subtitle',
        },
      ]),
      featureFlags: { 'canopy-shared-claude-model-fable5': true },
    });

    expect(merged.claudeModels[0]).toMatchObject({
      id: 'native-a',
      description: 'Catalog-owned subtitle',
    });
    expect(
      merged.aiGatewayModels.find((model) => model.id === 'api-only')
        ?.description,
    ).toBe('Gateway-only subtitle');
  });

  it('lets an explicit package showMoreOnly value override the API value', () => {
    const config = parseModelPackageConfig({
      'claude-code': {
        models: [
          {
            id: 'package-true',
            label: 'Package True',
            gatewayId: 'provider/true',
            showMoreOnly: true,
            family: 'fable',
            familyLabel: 'Fable',
            vendor: 'anthropic',
            sortOrder: 1,
          },
          {
            id: 'package-false',
            label: 'Package False',
            gatewayId: 'provider/false',
            showMoreOnly: false,
            family: 'fable',
            familyLabel: 'Fable',
            vendor: 'anthropic',
            sortOrder: 2,
          },
          {
            id: 'package-inherits',
            label: 'Package Inherits',
            gatewayId: 'provider/inherits',
            family: 'fable',
            familyLabel: 'Fable',
            vendor: 'anthropic',
            sortOrder: 3,
          },
        ],
      },
    });
    const merged = mergeAiGatewayModelCatalog({
      packageConfig: config,
      catalog: catalog([
        {
          id: 'api-true-overridden',
          gatewayId: 'provider/true',
          recommendedHarness: 'claude',
          showMoreOnly: false,
        },
        {
          id: 'api-false-overridden',
          gatewayId: 'provider/false',
          recommendedHarness: 'claude',
          showMoreOnly: true,
        },
        {
          id: 'api-inherited',
          gatewayId: 'provider/inherits',
          recommendedHarness: 'claude',
          showMoreOnly: true,
        },
        {
          id: 'api-only',
          gatewayId: 'provider/api-only',
          recommendedHarness: 'codex',
          showMoreOnly: true,
        },
      ]),
    });

    expect(
      merged.claudeModels.map(({ id, showMoreOnly }) => [id, showMoreOnly]),
    ).toEqual([
      ['package-true', true],
      ['package-false', false],
      ['package-inherits', true],
    ]);
    expect(
      merged.aiGatewayModels.find(({ id }) => id === 'api-only')?.showMoreOnly,
    ).toBe(true);
  });

  it('leaves the package description in place when the catalog row has none', () => {
    const configWithDescription = parseModelPackageConfig({
      'claude-code': {
        models: [
          {
            id: 'native-a',
            label: 'Native A',
            family: 'fable',
            familyLabel: 'Fable',
            vendor: 'anthropic',
            sortOrder: 10,
            description: 'Package subtitle',
            gatewayId: 'provider/a',
          },
        ],
      },
    });
    const merged = mergeAiGatewayModelCatalog({
      packageConfig: configWithDescription,
      catalog: catalog([
        { id: 'api-a', gatewayId: 'provider/a', recommendedHarness: 'claude' },
      ]),
    });

    expect(merged.claudeModels[0]?.description).toBe('Package subtitle');
  });

  it('reverts a package-pinned model to package copy when the catalog clears its description', () => {
    // Deliberate: the package description is a fallback, not something the
    // catalog can blank. An admin PATCH of `description: null` serializes the
    // row without a description, and a package-pinned model then shows its
    // shipped copy rather than losing its subtitle — so it reads the same
    // online, offline, and before the first refresh. Changing copy means
    // setting a new description, not clearing it.
    const configWithDescription = parseModelPackageConfig({
      'claude-code': {
        models: [
          {
            id: 'native-a',
            label: 'Native A',
            family: 'fable',
            familyLabel: 'Fable',
            vendor: 'anthropic',
            sortOrder: 10,
            description: 'Package subtitle',
            gatewayId: 'provider/a',
          },
        ],
      },
    });
    const cleared = catalog([
      { id: 'api-a', gatewayId: 'provider/a', recommendedHarness: 'claude' },
    ]);
    expect(cleared.models[0]).not.toHaveProperty('description');

    const merged = mergeAiGatewayModelCatalog({
      packageConfig: configWithDescription,
      catalog: cleared,
    });

    expect(merged.claudeModels[0]?.description).toBe('Package subtitle');
  });

  it('ships a real offline description for every gateway-pinned package model', () => {
    // The merge above treats the package description as the offline fallback,
    // which is only true while the shipped package.json actually carries one.
    // Before the first successful catalog refresh — offline launch, an
    // unreachable origin, or the cache discarded by a catalog version bump —
    // this is the only subtitle any model picker has.
    const pkg: unknown = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    const realConfig = parseModelPackageConfig(pkg);
    const gatewayPinned = [
      ...realConfig.claudeModels,
      ...realConfig.codexModels,
    ].filter((entry) => entry.gatewayId);

    expect(gatewayPinned.length).toBeGreaterThan(0);
    expect(
      gatewayPinned
        .filter((entry) => !entry.description?.trim())
        .map((entry) => entry.id),
    ).toEqual([]);
  });

  it('falls back to package descriptions when no catalog is available', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    const merged = mergeAiGatewayModelCatalog({
      packageConfig: parseModelPackageConfig(pkg),
      catalog: undefined,
    });

    expect(
      [...merged.claudeModels, ...merged.codexModels]
        .filter((model) => model.gatewayId && !model.description?.trim())
        .map((model) => model.id),
    ).toEqual([]);
  });

  it('threads the vendor family into merged gateway routing metadata', () => {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig,
      catalog: catalog([
        { id: 'api-a', gatewayId: 'provider/a', recommendedHarness: 'claude' },
        {
          id: 'api-only',
          gatewayId: 'provider/only',
          recommendedHarness: 'codex',
        },
      ]),
      featureFlags: { 'canopy-shared-claude-model-fable5': true },
    });

    expect(merged.claudeModels[0]?.gateway?.family).toBe('anthropic');
    expect(
      merged.gatewayRoutes.find((route) => route.modelId === 'api-only')
        ?.family,
    ).toBe('anthropic');
  });

  describe('implicit `off` materialization (CAN-2339 review F1)', () => {
    // The v2 catalog wire contract keeps `off` implicit ("Empty means thinking
    // is unsupported. `off` is implicit and not stored"), so gateway rows can
    // never declare it. The desktop projection is the host that declares the
    // level set, so the merge must materialize the implicit `off` — otherwise
    // clamping `off` on an AI-Credits route silently lands on the lowest
    // thinking tier.
    const thinkingCatalog: AiGatewayModelCatalogResponse = {
      version: AI_GATEWAY_MODEL_CATALOG_VERSION,
      models: [
        {
          id: 'api-a',
          gatewayId: 'provider/a',
          label: 'API api-a',
          family: 'anthropic',
          recommendedHarness: 'claude',
          contextWindow: 999,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['low', 'medium', 'high'],
          toolSchemaProfile: 'standard',
        },
        {
          id: 'api-only',
          gatewayId: 'provider/only',
          label: 'API api-only',
          family: 'deepseek',
          recommendedHarness: 'codex',
          contextWindow: 999,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['low', 'medium', 'high'],
          toolSchemaProfile: 'standard',
        },
        {
          id: 'api-no-thinking',
          gatewayId: 'provider/none',
          label: 'API api-no-thinking',
          family: 'minimax',
          recommendedHarness: 'codex',
          contextWindow: 999,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    };

    const merge = (): ReturnType<typeof mergeAiGatewayModelCatalog> =>
      mergeAiGatewayModelCatalog({
        packageConfig,
        catalog: thinkingCatalog,
        featureFlags: { 'canopy-shared-claude-model-fable5': true },
      });

    afterEach(() => {
      sharedTypes.initAiGatewayModels([], []);
    });

    it('prepends the implicit `off` to matched and gateway-only level sets', () => {
      const merged = merge();
      expect(merged.claudeModels[0]?.gateway?.supportedThinkingLevels).toEqual([
        'off',
        'low',
        'medium',
        'high',
      ]);
      expect(
        merged.aiGatewayModels.find((entry) => entry.id === 'api-only')
          ?.supportedThinkingLevels,
      ).toEqual(['off', 'low', 'medium', 'high']);
      for (const modelId of ['native-a', 'api-only']) {
        expect(
          merged.gatewayRoutes.find((route) => route.modelId === modelId)
            ?.supportedThinkingLevels,
        ).toEqual(['off', 'low', 'medium', 'high']);
      }
    });

    it('keeps an empty set empty — thinking stays unsupported', () => {
      const merged = merge();
      expect(
        merged.gatewayRoutes.find(
          (route) => route.modelId === 'api-no-thinking',
        )?.supportedThinkingLevels,
      ).toEqual([]);
    });

    it('lets an AI-Credits-routed model support, clamp, and cycle to `off`', () => {
      const merged = merge();
      sharedTypes.initAiGatewayModels(
        merged.aiGatewayModels,
        merged.gatewayRoutes,
      );

      expect(
        sharedTypes.modelSupportsThinkingLevel(
          'api-only',
          'off',
          undefined,
          true,
        ),
      ).toBe(true);
      expect(
        sharedTypes.clampThinkingLevelForModel(
          'off',
          'api-only',
          undefined,
          true,
        ),
      ).toBe('off');
      expect([
        ...sharedTypes.getEffectiveSupportedThinkingLevelsForModel(
          'api-only',
          true,
        ),
      ]).toEqual(['off', 'low', 'medium', 'high']);
    });
  });
});
