import {
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import {
  getEffectiveChatProvider,
  isClaudeBackedChatTab,
} from '../lib/chat-provider';

describe('chat-provider', () => {
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

  it('prefers persisted provider metadata over model lookup', () => {
    expect(
      getEffectiveChatProvider({
        model: 'retired-model',
        providerType: 'codex',
      }),
    ).toBe('codex');
  });

  it('derives the provider for a registered model', () => {
    expect(getEffectiveChatProvider({ model: 'gpt-5.5' })).toBe('codex');
    expect(isClaudeBackedChatTab({ model: 'gpt-5.5' })).toBe(false);
  });

  it('keeps a stale persisted model renderable with the safe Claude fallback', () => {
    expect(getEffectiveChatProvider({ model: 'retired-model' })).toBe('claude');
    expect(isClaudeBackedChatTab({ model: 'retired-model' })).toBe(true);
  });
});
