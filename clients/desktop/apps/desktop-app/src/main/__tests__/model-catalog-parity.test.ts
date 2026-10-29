/**
 * CAN-2540 §1 — desktop renderer ↔ portal model-catalog projection parity.
 *
 * Both surfaces project the same runtime registry through the shared
 * `buildModelCatalogOption` builder: the portal via
 * `buildProjectedModelCatalog`, the renderer via the picker's
 * `rowToCatalogOption` (a thin wrapper passing each row's resolved provider,
 * exactly reproduced here). This test runs both projections over ONE registry
 * fixture covering every row shape — native Claude/Codex, Ollama, a
 * gateway-only model, an available Agent, a stale Agent — and diffs the
 * resulting rows field by field, so any field added to one surface without
 * the other fails loudly instead of drifting silently.
 */
import {
  getProviderForModel,
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  initOllamaModels,
  resolveAgentModelDefinition,
} from '@canopy/desktop-shared/types';
import { buildModelCatalogOption } from '@canopy/desktop-shared/lib/model-catalog-projection';
import type { ModelCatalogProvider } from '@canopy/protocol/models';

const mockIsModelBlockedByCurrentPolicy = jest.fn(() => false);
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByCurrentPolicy: (id: string): boolean =>
    mockIsModelBlockedByCurrentPolicy(id),
}));
import { buildProjectedModelCatalog } from '../portal/model-catalog-projection';

const DEFAULT_MODEL = 'opus';

/**
 * The renderer picker's per-row provider resolution (`ModelPicker`'s
 * `buildRows` / Agent row construction), reproduced verbatim: section
 * provider for native rows, per-row provider detection for the mixed
 * AI-Credits group, and the Agent's base-model provider.
 */
function rendererRowProvider(id: string): ModelCatalogProvider {
  const definition = resolveAgentModelDefinition(id);
  if (definition) {
    return getProviderForModel(definition.baseModel) ?? 'claude';
  }
  return getProviderForModel(id) ?? 'claude';
}

describe('renderer ↔ portal model catalog projection parity (CAN-2540)', () => {
  beforeEach(() => {
    mockIsModelBlockedByCurrentPolicy.mockReturnValue(false);
    initModelAliases({});
    initClaudeModels([
      {
        id: 'opus',
        label: 'Opus',
        description: 'Most capable model.',
        contextWindow: 1_000_000,
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
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    initAiGatewayModels(
      [
        {
          id: 'gateway-only',
          label: 'Gateway Only',
          recommendedHarness: 'codex',
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['off', 'medium', 'high'],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'gateway-only',
          gatewayId: 'provider/gateway-only',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['off', 'medium', 'high'],
          toolSchemaProfile: 'standard',
        },
      ],
    );
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

  it('projects identical rows, field by field, on both surfaces', () => {
    const portalCatalog = buildProjectedModelCatalog(DEFAULT_MODEL);
    expect(portalCatalog.length).toBeGreaterThanOrEqual(6);

    for (const portalRow of portalCatalog) {
      const rendererRow = buildModelCatalogOption(portalRow.id, {
        provider: rendererRowProvider(portalRow.id),
        // The desktop picker does not stamp `isDefault` (selection state is
        // its own); parity runs with the same default so every OTHER field
        // difference is isolated.
        defaultModel: DEFAULT_MODEL,
      });
      expect(rendererRow).toBeDefined();
      // Deep equality diffs the rows FIELD BY FIELD: a field emitted by one
      // surface and not the other fails naming the exact field and row.
      expect({ id: portalRow.id, row: rendererRow }).toEqual({
        id: portalRow.id,
        row: portalRow,
      });
    }
  });

  it('covers every registry row shape in the fixture', () => {
    const catalog = buildProjectedModelCatalog(DEFAULT_MODEL);
    const kinds = new Map(catalog.map((row) => [row.id, row]));
    expect(kinds.get('opus')?.isDefault).toBe(true);
    expect(kinds.get('gateway-only')?.source).toBe('ai-gateway');
    expect(kinds.get('gateway-only')?.extraChargeOnly).toBe(true);
    expect(kinds.get('agent_model_reviewer')?.kind).toBe('agent');
    expect(kinds.get('agent_model_stale')?.available).toBe(false);
    expect(kinds.get('ollama-llama')?.provider).toBe('ollama');
  });
});
