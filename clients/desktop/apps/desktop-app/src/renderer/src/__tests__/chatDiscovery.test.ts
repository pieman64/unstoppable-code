import {
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  type WorktreeDiscovery,
} from '@canopy/desktop-shared/types';
import {
  resolveEffectiveProviderType,
  selectDiscoverySlashCommands,
} from '../lib/chatDiscovery';

describe('chatDiscovery', () => {
  beforeAll((): void => {
    initAgentModels([]);
    initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });
  });

  it('derives provider type from the selected model when needed', () => {
    expect(resolveEffectiveProviderType('gpt-5.5', undefined)).toBe('codex');
    expect(resolveEffectiveProviderType('claude-sonnet-4-6', undefined)).toBe(
      'claude',
    );
    expect(resolveEffectiveProviderType('gpt-6-sol', 'claude')).toBe('claude');
  });

  it('leaves a retired persisted model without an inferred provider', () => {
    expect(
      resolveEffectiveProviderType('gpt-6-sol', undefined),
    ).toBeUndefined();
  });

  it('filters out cached discovery from the wrong provider', () => {
    const codexDiscovery: WorktreeDiscovery = {
      slashCommands: [
        {
          name: 'ud-git:branch-naming',
          description: 'Branch naming',
          displayName: '$ud-git:branch-naming',
          insertText: '$ud-git:branch-naming ',
        },
      ],
      mcpServers: [],
      discoveredAt: '2026-04-01T00:00:00.000Z',
      providerType: 'codex',
    };
    const claudeDiscovery: WorktreeDiscovery = {
      slashCommands: [
        {
          name: 'compact',
          description: 'Compact the conversation',
        },
      ],
      mcpServers: [],
      discoveredAt: '2026-04-01T00:00:00.000Z',
      providerType: 'claude',
    };

    expect(
      selectDiscoverySlashCommands({
        providerType: 'codex',
        worktreeDiscovery: claudeDiscovery,
      }),
    ).toEqual([]);
    expect(
      selectDiscoverySlashCommands({
        providerType: 'codex',
        tabDiscovery: codexDiscovery,
        worktreeDiscovery: claudeDiscovery,
      }),
    ).toEqual(codexDiscovery.slashCommands);
  });
});
