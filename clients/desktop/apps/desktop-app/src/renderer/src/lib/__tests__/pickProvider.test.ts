import {
  initAgentModels,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { pickProvider } from '../pickProvider';

beforeAll(() => {
  initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
  initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  initAgentModels([
    {
      id: 'agent_model_follows',
      name: 'Follows',
      baseModel: 'default',
      instructions: '',
      createdAt: '2026-10-14T00:00:00.000Z',
      updatedAt: '2026-10-14T00:00:00.000Z',
      available: true,
    },
  ]);
});

afterAll(() => {
  initAgentModels([]);
});

describe('pickProvider', () => {
  it("judges an Agent on the default model by the chat's default", () => {
    expect(pickProvider('agent_model_follows', 'gpt-5.5')).toBe('codex');
    expect(pickProvider('agent_model_follows', 'claude-sonnet-4-6')).toBe(
      'claude',
    );
  });

  it('judges any other model by its own provider', () => {
    expect(pickProvider('claude-sonnet-4-6', 'gpt-5.5')).toBe('claude');
  });

  it('has no provider for an Agent on the default model without a default', () => {
    expect(pickProvider('agent_model_follows', undefined)).toBeUndefined();
  });
});
