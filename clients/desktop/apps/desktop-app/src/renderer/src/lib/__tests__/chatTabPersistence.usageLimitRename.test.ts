import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import { hydratePersistedChatTab } from '../chatTabPersistence';

type LegacyUsageLimitBannerTab = PersistedChatTab & {
  claudeUsageLimitBanner: {
    provider: 'claude' | 'codex';
    message: string;
    detectedAt: number;
    dismissKey: string;
  };
  dismissedClaudeUsageLimitBannerKey: string;
};

describe('usage-limit banner key read-compat', () => {
  it('reads a tab persisted with the legacy claudeUsageLimitBanner key', () => {
    const legacyRaw: LegacyUsageLimitBannerTab = {
      id: 'chat-1',
      title: 'Legacy',
      messages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      claudeUsageLimitBanner: {
        provider: 'claude',
        message: 'Claude usage limit reached.',
        detectedAt: 1000,
        dismissKey: 'k1',
      },
      dismissedClaudeUsageLimitBannerKey: 'k1',
    };
    const tab = hydratePersistedChatTab(legacyRaw);
    expect(tab.llmProviderUsageLimitBanner?.dismissKey).toBe('k1');
    expect(tab.dismissedLlmProviderUsageLimitBannerKey).toBe('k1');
  });
});
