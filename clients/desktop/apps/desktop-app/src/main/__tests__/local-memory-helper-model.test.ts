import {
  DEFAULT_LOCAL_MEMORY_MODEL,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import { LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE } from '@canopy/desktop-shared/types/local-memory';
import {
  LocalMemoryModelUnavailableError,
  resolveLocalMemoryHelperModel,
} from '../memory/local/helper-model';

type HelperPreferences = Pick<
  PreferencesData,
  | 'localMemoryModel'
  | 'localMemoryThinkingLevel'
  | 'providerModelConfigDefaults'
  | 'summaryModel'
  | 'summaryThinkingLevel'
>;

function preferences(
  overrides: Partial<HelperPreferences> = {},
): HelperPreferences {
  const preferences: Partial<HelperPreferences> = {
    localMemoryModel: DEFAULT_LOCAL_MEMORY_MODEL,
    localMemoryThinkingLevel: 'medium',
    summaryModel: 'claude-haiku-4-5-20251001',
    summaryThinkingLevel: 'off',
    ...overrides,
  };
  // A partial fixture: these tests rely on unset preferences staying undefined.
  return preferences as HelperPreferences;
}

describe('resolveLocalMemoryHelperModel', () => {
  beforeAll(() => {
    initClaudeModels([
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    ]);
    initCodexModels([{ id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol' }]);
  });

  it('defaults to the Codex memory model instead of the chat description model', () => {
    expect(DEFAULT_LOCAL_MEMORY_MODEL).toBe('gpt-6.1-sol');
    expect(resolveLocalMemoryHelperModel(preferences())).toMatchObject({
      model: 'gpt-6.1-sol',
      thinkingLevel: 'medium',
      modelConfig: { thinkingLevel: 'medium' },
    });
  });

  it('follows the local memory model and thinking level the user chose', () => {
    expect(
      resolveLocalMemoryHelperModel(
        preferences({
          localMemoryModel: 'claude-sonnet-4-6',
          localMemoryThinkingLevel: 'high',
          summaryModel: 'gpt-6.1-sol',
          summaryThinkingLevel: 'low',
        }),
      ),
    ).toMatchObject({
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'high',
      modelConfig: { thinkingLevel: 'high' },
    });
  });

  it('refuses a model this install cannot run instead of substituting one', () => {
    expect(() =>
      resolveLocalMemoryHelperModel(
        preferences({ localMemoryModel: 'retired-model' }),
      ),
    ).toThrow(LocalMemoryModelUnavailableError);
    expect(() =>
      resolveLocalMemoryHelperModel(
        preferences({ localMemoryModel: 'retired-model' }),
      ),
    ).toThrow(LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE);
  });

  it('runs a chosen Ollama model only while Ollama lists it', () => {
    const chosen = preferences({ localMemoryModel: 'ollama-llama' });
    initOllamaModels([]);
    expect(() => resolveLocalMemoryHelperModel(chosen)).toThrow(
      LocalMemoryModelUnavailableError,
    );
    initOllamaModels([
      {
        id: 'ollama-llama',
        rawModelId: 'llama',
        label: 'llama',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    try {
      expect(resolveLocalMemoryHelperModel(chosen)).toMatchObject({
        model: 'ollama-llama',
      });
    } finally {
      initOllamaModels([]);
    }
  });
});
