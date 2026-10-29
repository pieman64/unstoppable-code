/**
 * Coverage for the desktop → portal model-catalog projection (CAN-1218).
 * `buildProjectedModelCatalog` derives the browser-safe `ModelCatalog` wire
 * shape from the runtime model registry singletons, so the portal picker can
 * show the same models the desktop has.
 */
import {
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  initModelAliases,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { replaceModelFamilyMetadata } from '@canopy/desktop-shared/model-config';
import { toCursorModelId } from '@canopy/desktop-shared/lib/cursor-models';
import { isOrgGatewayRouteUsableByOwner } from '@canopy/desktop-shared/lib/org-model-gateway';
const mockIsModelBlockedByCurrentPolicy = jest.fn(() => false);
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByCurrentPolicy: (id: string): boolean =>
    mockIsModelBlockedByCurrentPolicy(id),
}));
const mockIsModelExcludedByCurrentGatewayRequirement = jest.fn(() => false);
jest.mock('../lib/model-gateway-state', () => ({
  isModelExcludedByCurrentGatewayRequirement: (
    id: string,
    owner: WorkOwner | undefined,
  ): boolean => mockIsModelExcludedByCurrentGatewayRequirement(id, owner),
}));
const mockCursorFlag = jest.fn(() => true);
jest.mock('../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => mockCursorFlag(),
}));
import { buildProjectedModelCatalog } from '../portal/model-catalog-projection';

describe('buildProjectedModelCatalog', () => {
  it('projects Cursor model identity separately from its execution route', () => {
    initClaudeModels([
      { id: 'sonnet', label: 'Sonnet', cursorModelId: 'claude-sonnet-5-5' },
    ]);
    replaceModelFamilyMetadata([
      {
        id: 'sonnet',
        family: 'sonnet',
        familyLabel: 'Sonnet',
        vendor: 'anthropic',
        sortOrder: 10,
      },
    ]);
    const raws = [
      'claude-sonnet-5-5[]',
      'claude-sonnet-5-5[thinking=false]',
      'gemini-3.1-pro[]',
      'composer-2.5[]',
      'opaque[]',
    ];
    initCursorModels(
      raws.map((rawModelId) => ({
        id: toCursorModelId(rawModelId),
        rawModelId,
        label: rawModelId,
      })),
    );
    try {
      const catalog = buildProjectedModelCatalog(undefined, {
        cursor: true,
        agentDefaultModel: undefined,
      });
      expect(
        catalog.find((row) => row.id === toCursorModelId(raws[0])),
      ).toMatchObject({
        canonicalModelId: 'sonnet',
        vendor: 'anthropic',
        family: 'sonnet',
        provider: 'cursor',
        source: 'cursor',
        harness: 'cursor',
      });
      expect(
        catalog.find((row) => row.id === toCursorModelId(raws[1])),
      ).toMatchObject({
        vendor: 'anthropic',
        provider: 'cursor',
      });
      expect(
        catalog.find((row) => row.id === toCursorModelId(raws[1])),
      ).not.toHaveProperty('canonicalModelId');
      expect(
        catalog.find((row) => row.id === toCursorModelId(raws[2])),
      ).toMatchObject({ vendor: 'google' });
      expect(
        catalog.find((row) => row.id === toCursorModelId(raws[3])),
      ).toMatchObject({ vendor: 'cursor' });
      expect(
        catalog.find((row) => row.id === toCursorModelId(raws[4])),
      ).not.toHaveProperty('vendor');
    } finally {
      replaceModelFamilyMetadata([]);
    }
  });
  beforeEach(() => {
    mockIsModelBlockedByCurrentPolicy.mockReturnValue(false);
    mockIsModelExcludedByCurrentGatewayRequirement.mockImplementation(
      (id: string, owner: WorkOwner | undefined) =>
        !isOrgGatewayRouteUsableByOwner(id, owner),
    );
    mockCursorFlag.mockReturnValue(true);
    initModelAliases({});
    initAiGatewayModels([], []);
    // The discovered Cursor catalog: the persisted default plus one live
    // variant, exactly as `initCursorModels` publishes them after Connect.
    initCursorModels([
      {
        id: 'cursor-default',
        rawModelId: 'default[]',
        label: 'Cursor default',
      },
      {
        id: 'cursor:gpt-6-luna%5Breasoning%3Dmedium%5D',
        rawModelId: 'gpt-6-luna[reasoning=medium]',
        label: 'GPT-6 Luna',
      },
    ]);
    initClaudeModels([
      {
        id: 'opus',
        label: 'Opus',
        description: 'Most capable model.',
        // `off` is exact per-model data (no auto-injection), matching how the
        // shipped catalog in package.json declares native models.
        supportedThinkingLevels: [
          'off',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ],
      },
      {
        id: 'sonnet',
        label: 'Sonnet',
        showMoreOnly: true,
        extraChargeOnly: true,
        extraChargeMessage: 'AI credits only.',
        supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
      },
    ]);
    initCodexModels([
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        supportedThinkingLevels: [
          'off',
          'low',
          'medium',
          'high',
          'xhigh',
          'ultra',
        ],
      },
    ]);
    initOllamaModels([
      {
        id: 'ollama-llama',
        rawModelId: 'llama',
        label: 'llama',
        // Only models advertising the required capabilities are registered.
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    initAgentModels([
      {
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'opus',
        instructions: '',
        pluginSelections: { collectionIds: [] },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        available: true,
      },
      {
        id: 'agent_model_stale',
        name: 'Stale',
        baseModel: 'ghost-model-that-does-not-exist',
        instructions: '',
        pluginSelections: { collectionIds: [] },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        available: true,
      },
    ]);
  });

  it('projects provider models in Claude → Codex → Ollama → Cursor → Agents order', () => {
    const catalog = buildProjectedModelCatalog(undefined, { cursor: true });
    expect(catalog.map((option) => option.id)).toEqual([
      'opus',
      'sonnet',
      'gpt-5.5',
      'ollama-llama',
      'cursor-default',
      'cursor:gpt-6-luna%5Breasoning%3Dmedium%5D',
      'agent_model_reviewer',
      'agent_model_stale',
    ]);
  });

  it('omits Cursor rows unless the caller opts in', () => {
    expect(
      buildProjectedModelCatalog().some(
        (option) => option.provider === 'cursor',
      ),
    ).toBe(false);
    expect(
      buildProjectedModelCatalog(undefined, { cursor: false }).some(
        (option) => option.provider === 'cursor',
      ),
    ).toBe(false);
  });

  it('projects Cursor rows after Ollama and before Agents when the harness flag is on', () => {
    const ids = buildProjectedModelCatalog(undefined, { cursor: true }).map(
      (option) => option.id,
    );
    expect(ids.indexOf('cursor-default')).toBeGreaterThan(
      ids.indexOf('ollama-llama'),
    );
    expect(ids.indexOf('cursor-default')).toBeLessThan(
      ids.indexOf('agent_model_reviewer'),
    );
    const row = buildProjectedModelCatalog(undefined, { cursor: true }).find(
      (option) => option.id === 'cursor-default',
    );
    expect(row).toMatchObject({
      provider: 'cursor',
      source: 'cursor',
      harness: 'cursor',
      kind: 'model',
      available: true,
      thinkingLevels: [],
    });
  });

  it('omits Cursor rows when the harness flag is off', () => {
    mockCursorFlag.mockReturnValue(false);
    expect(
      buildProjectedModelCatalog(undefined, { cursor: true }).some(
        (option) => option.provider === 'cursor',
      ),
    ).toBe(false);
  });

  it('omits Cursor rows blocked by org policy while retaining the rest', () => {
    mockIsModelBlockedByCurrentPolicy.mockImplementation(
      (id: string) => id === 'cursor-default',
    );
    const ids = buildProjectedModelCatalog(undefined, { cursor: true }).map(
      (option) => option.id,
    );
    expect(ids).not.toContain('cursor-default');
    expect(ids).toContain('cursor:gpt-6-luna%5Breasoning%3Dmedium%5D');
  });

  it('tags each row with its provider and kind', () => {
    const catalog = buildProjectedModelCatalog();
    const byId = new Map(catalog.map((option) => [option.id, option]));
    expect(byId.get('opus')).toMatchObject({
      provider: 'claude',
      kind: 'model',
      available: true,
    });
    expect(byId.get('gpt-5.5')).toMatchObject({
      provider: 'codex',
      kind: 'model',
    });
    expect(byId.get('ollama-llama')).toMatchObject({
      provider: 'ollama',
      kind: 'model',
    });
  });

  it('stamps exactly the lane-resolved default for Portal presentation', () => {
    const catalog = buildProjectedModelCatalog('gpt-5.5');
    expect(catalog.find((option) => option.id === 'gpt-5.5')).toMatchObject({
      isDefault: true,
    });
    expect(
      catalog.filter((option) => option.isDefault === true).map(({ id }) => id),
    ).toEqual(['gpt-5.5']);
  });

  it('omits provider and Agent rows blocked by org policy while retaining Ollama', () => {
    mockIsModelBlockedByCurrentPolicy.mockImplementation(
      (id: string) => id === 'opus' || id === 'agent_model_reviewer',
    );
    expect(
      buildProjectedModelCatalog(undefined, { cursor: true }).map(
        (option) => option.id,
      ),
    ).toEqual([
      'sonnet',
      'gpt-5.5',
      'ollama-llama',
      'cursor-default',
      'cursor:gpt-6-luna%5Breasoning%3Dmedium%5D',
      'agent_model_stale',
    ]);
  });

  it("projects only the owner's gateway routes when its gateway is enforced", () => {
    const gatewayModel = 'acme-gateway-model';
    initAiGatewayModels(
      [
        {
          id: gatewayModel,
          label: 'Acme Gateway Model',
          recommendedHarness: 'claude',
          contextWindow: 200_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: gatewayModel,
          gatewayId: 'vertex/acme-gateway-model',
          recommendedHarness: 'claude',
          gatewayOnly: true,
          contextWindow: 200_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
          origin: 'org-gateway',
          baseUrl: 'https://gateway.acme.test',
          organizationId: '11111111-1111-4111-8111-111111111111',
          promptCachePassthrough: true,
        },
      ],
    );
    mockIsModelExcludedByCurrentGatewayRequirement.mockImplementation(
      (id: string) => id !== gatewayModel,
    );
    const owner = {
      kind: 'organization' as const,
      organizationId: '11111111-1111-4111-8111-111111111111',
    };

    expect(
      buildProjectedModelCatalog(undefined, { owner }).map(({ id }) => id),
    ).toEqual([gatewayModel]);
    expect(mockIsModelExcludedByCurrentGatewayRequirement).toHaveBeenCalledWith(
      'opus',
      owner,
    );
  });

  it('projects API-owned family metadata without classifying the model ID', () => {
    initAiGatewayModels(
      [
        {
          id: 'deepseek-v4.1-flash',
          label: 'DeepSeek V4.1 Flash',
          family: 'deepseek',
          familyLabel: 'DeepSeek',
          vendor: 'deepseek',
          sortOrder: 91,
          recommendedHarness: 'codex',
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'deepseek-v4.1-flash',
          gatewayId: 'deepseek/deepseek-v4.1-flash',
          family: 'deepseek',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    const gateway = buildProjectedModelCatalog().find(
      (option) => option.id === 'deepseek-v4.1-flash',
    );
    expect(gateway).toMatchObject({
      provider: 'codex',
      source: 'ai-gateway',
      harness: 'codex',
      kind: 'model',
      available: true,
      family: 'deepseek',
      familyLabel: 'DeepSeek',
      vendor: 'deepseek',
      sortOrder: 91,
    });
  });

  it('omits gateway-only rows blocked by org policy', () => {
    initAiGatewayModels(
      [
        {
          id: 'gateway-only-blocked',
          label: 'Gateway Only Blocked',
          recommendedHarness: 'codex',
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'gateway-only-blocked',
          gatewayId: 'provider/gateway-only-blocked',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    mockIsModelBlockedByCurrentPolicy.mockImplementation(
      (id: string) => id === 'gateway-only-blocked',
    );

    expect(
      buildProjectedModelCatalog().some(
        (option) => option.id === 'gateway-only-blocked',
      ),
    ).toBe(false);
  });

  it('projects organization gateway routes only for their owning work', () => {
    const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const orgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    initAiGatewayModels(
      [
        {
          id: 'org-a-model',
          label: 'Org A model',
          recommendedHarness: 'claude',
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
        {
          id: 'org-b-model',
          label: 'Org B model',
          recommendedHarness: 'claude',
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'org-a-model',
          gatewayId: `${orgA}/model`,
          organizationId: orgA,
          origin: 'org-gateway',
          recommendedHarness: 'claude',
          gatewayOnly: true,
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
        {
          modelId: 'org-b-model',
          gatewayId: `${orgB}/model`,
          organizationId: orgB,
          origin: 'org-gateway',
          recommendedHarness: 'claude',
          gatewayOnly: true,
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );

    expect(
      buildProjectedModelCatalog(undefined, {
        owner: { kind: 'organization', organizationId: orgA },
      })
        .filter((option) => option.id.startsWith('org-'))
        .map((option) => option.id),
    ).toEqual(['org-a-model']);
    expect(
      buildProjectedModelCatalog(undefined, { owner: { kind: 'personal' } })
        .filter((option) => option.id.startsWith('org-'))
        .map((option) => option.id),
    ).toEqual([]);
  });

  it('carries extra-charge billing metadata onto the catalog row', () => {
    const sonnet = buildProjectedModelCatalog().find(
      (option) => option.id === 'sonnet',
    );
    expect(sonnet).toMatchObject({
      extraChargeOnly: true,
      extraChargeMessage: 'AI credits only.',
    });
    // A model without billing metadata omits the extra-charge fields.
    const opus = buildProjectedModelCatalog().find(
      (option) => option.id === 'opus',
    );
    expect(opus?.extraChargeOnly).toBeUndefined();
  });

  it('projects package-owned show-more placement without applying it to Agents', () => {
    const catalog = buildProjectedModelCatalog();
    expect(catalog.find((option) => option.id === 'sonnet')).toMatchObject({
      showMoreOnly: true,
    });
    expect(
      catalog.find((option) => option.id === 'agent_model_reviewer')
        ?.showMoreOnly,
    ).toBeUndefined();
  });

  it('projects configured descriptions for desktop and Portal pickers', () => {
    expect(
      buildProjectedModelCatalog().find((option) => option.id === 'opus'),
    ).toMatchObject({ description: 'Most capable model.' });
    expect(
      buildProjectedModelCatalog().find(
        (option) => option.id === 'agent_model_reviewer',
      ),
    ).toMatchObject({ description: 'Most capable model.' });
  });

  it('marks a stale custom Agent unavailable while an available Agent resolves its base provider', () => {
    const catalog = buildProjectedModelCatalog();
    const reviewer = catalog.find((o) => o.id === 'agent_model_reviewer');
    const stale = catalog.find((o) => o.id === 'agent_model_stale');
    expect(reviewer).toMatchObject({
      kind: 'agent',
      provider: 'claude',
      available: true,
      label: 'Reviewer',
    });
    expect(reviewer?.unavailableReason).toBeUndefined();
    expect(stale).toMatchObject({
      kind: 'agent',
      available: false,
      unavailableReason: 'base_model_unavailable',
    });
  });

  describe('per-model thinking levels (CAN-2441)', () => {
    const levelsFor = (id: string): unknown =>
      buildProjectedModelCatalog().find((option) => option.id === id)
        ?.thinkingLevels;

    it('projects each model its own configured efforts, including max and ultra', () => {
      expect(levelsFor('opus')).toEqual([
        'off',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      expect(levelsFor('gpt-5.5')).toEqual([
        'off',
        'medium',
        'high',
        'xhigh',
        'ultra',
      ]);
    });

    it('projects a narrower set for a model configured with fewer tiers', () => {
      expect(levelsFor('sonnet')).toEqual(['off', 'medium', 'high']);
    });

    it('never projects the internal-only `low` tier', () => {
      for (const option of buildProjectedModelCatalog()) {
        expect(option.thinkingLevels).not.toContain('low');
      }
    });

    it('always offers `off` first so the cycle has a defined start', () => {
      for (const option of buildProjectedModelCatalog(undefined, {
        cursor: true,
      })) {
        // Cursor rows carry no thinking chip at all (the CLI owns effort), so
        // their projected cycle is deliberately empty rather than `off`-led.
        if (option.provider === 'cursor') {
          expect(option.thinkingLevels).toEqual([]);
          continue;
        }
        expect(option.thinkingLevels?.[0]).toBe('off');
      }
    });

    it('gives an available Agent its base model efforts', () => {
      expect(levelsFor('agent_model_reviewer')).toEqual(levelsFor('opus'));
    });

    it('projects the base model effective declared set onto available Agent rows', () => {
      // Without `supportedThinkingLevels`, web resolves an Agent row through
      // the provider fallback while desktop resolves the base model's real
      // set (CAN-2540 §1) — the Agent row must declare the base model's
      // effective set like every provider row does.
      const catalog = buildProjectedModelCatalog();
      const reviewer = catalog.find((o) => o.id === 'agent_model_reviewer');
      const opus = catalog.find((o) => o.id === 'opus');
      expect(reviewer?.supportedThinkingLevels).toEqual(
        opus?.supportedThinkingLevels,
      );
      expect(reviewer?.supportedThinkingLevels).toEqual([
        'off',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      // A stale Agent has no base set; the field stays ABSENT so clients fall
      // back to their provider cycle rather than treating the fallback as a
      // declaration.
      const stale = catalog.find((o) => o.id === 'agent_model_stale');
      expect(stale?.supportedThinkingLevels).toBeUndefined();
    });
  });
});
