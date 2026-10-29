import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import { isDeepStrictEqual } from 'node:util';
import { enqueueChatTabMutation } from './chat-tab-mutation-queue';
import { readChatTabsFile } from './chat-tabs-reader';
import { writeChatTabsFile } from './chat-tabs';

const PERSISTED_USAGE_LIMIT_BANNER_KEYS = [
  'llmProviderUsageLimitBanner',
  'dismissedLlmProviderUsageLimitBannerKey',
  'claudeUsageLimitBanner',
  'dismissedClaudeUsageLimitBannerKey',
] as const;

export type PersistedUsageLimitBannerSnapshot = Partial<
  Record<(typeof PERSISTED_USAGE_LIMIT_BANNER_KEYS)[number], unknown>
>;

export function capturePersistedUsageLimitBannerSnapshot(
  tab: PersistedChatTab | undefined,
): PersistedUsageLimitBannerSnapshot {
  if (!tab) return {};

  const snapshot: PersistedUsageLimitBannerSnapshot = {};
  for (const key of PERSISTED_USAGE_LIMIT_BANNER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(tab, key)) {
      snapshot[key] = Reflect.get(tab, key);
    }
  }
  return snapshot;
}

function clearPersistedBannerFields(
  tab: PersistedChatTab,
  expectedBannerState: PersistedUsageLimitBannerSnapshot,
): PersistedChatTab {
  if (
    !isDeepStrictEqual(
      capturePersistedUsageLimitBannerSnapshot(tab),
      expectedBannerState,
    ) ||
    Object.keys(expectedBannerState).length === 0
  ) {
    return tab;
  }

  const updatedTab: PersistedChatTab = { ...tab };
  for (const key of PERSISTED_USAGE_LIMIT_BANNER_KEYS) {
    Reflect.deleteProperty(updatedTab, key);
  }
  return updatedTab;
}

/**
 * Clears persisted recovery-banner state without relying on a live renderer.
 * The mutation queue prevents this metadata-only write from racing transcript
 * or renderer-driven chat-tab persistence.
 */
export async function clearPersistedUsageLimitBanner(input: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  expectedBannerState: PersistedUsageLimitBannerSnapshot;
}): Promise<void> {
  await enqueueChatTabMutation(
    input.projectId,
    input.worktreeId,
    async (): Promise<void> => {
      const tabsFile = await readChatTabsFile(
        input.projectId,
        input.worktreeId,
      );
      const tabIndex = tabsFile.tabs.findIndex(
        (tab) => tab.id === input.chatId,
      );
      if (tabIndex === -1) return;

      const currentTab = tabsFile.tabs[tabIndex];
      const updatedTab = clearPersistedBannerFields(
        currentTab,
        input.expectedBannerState,
      );
      if (updatedTab === currentTab) return;

      const tabs = [...tabsFile.tabs];
      tabs[tabIndex] = updatedTab;
      await writeChatTabsFile(input.projectId, input.worktreeId, {
        ...tabsFile,
        tabs,
      });
    },
  );
}
