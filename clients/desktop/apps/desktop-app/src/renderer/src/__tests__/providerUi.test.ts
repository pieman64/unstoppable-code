// Tests for the pure label-resolution functions in providerLabels.
// The icon components (AgentProviderIcon, PlanSourceIcon) are JSX and are
// verified via the TypeScript compiler and manual inspection rather than
// jest, which runs in a Node-only test environment without React rendering.

import { getModelCatalogProviderLabel } from '@canopy/ui-shared';
import { getPlanSourceLabel } from '../lib/providerLabels';
import { resolveChatTabProvider } from '../lib/providerUi';
import {
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
} from '@canopy/desktop-shared/types';

describe('getModelCatalogProviderLabel', () => {
  it.each([
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['ollama', 'Ollama'],
  ] as const)('returns %s → %s', (provider, expected) => {
    expect(getModelCatalogProviderLabel(provider)).toBe(expected);
  });
});

describe('getPlanSourceLabel', () => {
  it.each([
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['ollama', 'Ollama'],
    ['pipeline', 'Workflow'],
    ['imported', 'Imported'],
    ['detected', 'Detected'],
  ] as const)('returns %s → %s', (source, expected) => {
    expect(getPlanSourceLabel(source)).toBe(expected);
  });
});

describe('resolveChatTabProvider', () => {
  beforeEach(() => {
    initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initOllamaModels([]);
    initAgentModels([]);
  });

  afterEach(() => {
    initClaudeModels([]);
    initCodexModels([]);
    initOllamaModels([]);
    initAgentModels([]);
  });

  it('uses an explicit provider without requiring a model lookup', () => {
    expect(resolveChatTabProvider({ providerType: 'codex' }, undefined)).toBe(
      'codex',
    );
  });

  it('derives providers only for registered model ids', () => {
    expect(resolveChatTabProvider({ model: 'gpt-5.5' }, undefined)).toBe(
      'codex',
    );
    expect(
      resolveChatTabProvider({ model: 'retired-model' }, undefined),
    ).toBeUndefined();
  });

  it('does not derive a provider for unavailable Agent models', () => {
    initAgentModels([
      {
        id: 'agent_model_stale',
        name: 'Stale Agent',
        baseModel: 'retired-model',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        available: false,
      },
    ]);

    expect(
      resolveChatTabProvider({ model: 'agent_model_stale' }, undefined),
    ).toBeUndefined();
  });
});
