/**
 * Tests for OllamaTab component logic and the modelCatalogStore.
 *
 * Since the project's renderer test setup runs in a Node-only environment
 * without a full React DOM, we test the supporting store logic rather than
 * rendering the component directly.
 */

import type { ModelRegistrySnapshot } from '@canopy/desktop-shared/types';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  OLLAMA_MODELS,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  initModelAliases,
} from '@canopy/desktop-shared/types';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '../stores/featureFlagsStore';
import { useModelCatalogStore } from '../stores/modelCatalogStore';

describe('modelCatalogStore hydration', () => {
  beforeEach(() => {
    // Reset model lists
    initClaudeModels([]);
    initCodexModels([]);
    initOllamaModels([]);
    initModelAliases({});
    useModelCatalogStore.setState({ snapshot: null });
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
  });

  it('initOllamaModels populates OLLAMA_MODELS from entries', () => {
    expect(OLLAMA_MODELS).toHaveLength(0);

    initOllamaModels([
      {
        id: 'ollama-llama3:8b',
        rawModelId: 'llama3:8b',
        label: 'Llama 3 8B',
        show: {
          capabilities: ['completion', 'tools'],
        },
      },
      {
        id: 'ollama-mistral:7b',
        rawModelId: 'mistral:7b',
        label: 'Mistral 7B',
        show: {
          capabilities: ['completion'],
        },
      },
    ]);

    expect(OLLAMA_MODELS).toHaveLength(1);
    expect(OLLAMA_MODELS).toContain('ollama-llama3:8b');
    expect(OLLAMA_MODELS).not.toContain('ollama-mistral:7b');
  });

  it('re-calling initOllamaModels replaces previous entries', () => {
    initOllamaModels([
      {
        id: 'ollama-llama3:8b',
        rawModelId: 'llama3:8b',
        label: 'Llama 3 8B',
        show: {
          capabilities: ['completion', 'tools'],
        },
      },
    ]);
    expect(OLLAMA_MODELS).toHaveLength(1);

    initOllamaModels([
      {
        id: 'ollama-mistral:7b',
        rawModelId: 'mistral:7b',
        label: 'Mistral 7B',
        show: {
          capabilities: ['completion', 'tools'],
        },
      },
    ]);
    expect(OLLAMA_MODELS).toHaveLength(1);
    expect(OLLAMA_MODELS[0]).toBe('ollama-mistral:7b');
  });

  it('snapshot hydration populates all model registries', () => {
    const snapshot: ModelRegistrySnapshot = {
      claude: [{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }],
      codex: [{ id: 'gpt-6-sol', label: 'GPT 6 Sol' }],
      ollama: [
        {
          id: 'ollama-llama3:8b',
          rawModelId: 'llama3:8b',
          label: 'Llama 3 8B',
          show: {
            capabilities: ['completion', 'tools'],
          },
        },
      ],
      aliases: { 'my-alias': 'claude-sonnet-4-6' },
    };

    initClaudeModels(snapshot.claude);
    initCodexModels(snapshot.codex);
    initOllamaModels(snapshot.ollama);
    initModelAliases(snapshot.aliases);

    expect(CLAUDE_MODELS).toContain('claude-sonnet-4-6');
    expect(CODEX_MODELS).toContain('gpt-6-sol');
    expect(OLLAMA_MODELS).toContain('ollama-llama3:8b');
  });

  it('trusts flagged models already included in the registry snapshot', () => {
    const snapshot: ModelRegistrySnapshot = {
      claude: [
        {
          id: 'fable[1m]',
          label: 'Fable 5 1M',
          featureFlag: 'canopy-shared-claude-model-fable5',
        },
      ],
      codex: [],
      ollama: [],
      aliases: {},
    };

    useModelCatalogStore.getState().hydrate(snapshot);

    expect(CLAUDE_MODELS).toContain('fable[1m]');

    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-shared-claude-model-fable5': true,
      },
    });

    expect(CLAUDE_MODELS).toContain('fable[1m]');
  });
});
