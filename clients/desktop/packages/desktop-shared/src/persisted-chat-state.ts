import { readMcpActivationRecord } from '@canopy/protocol/mcp-servers';
import type {
  AgentModelConfig,
  AgentProviderType,
  ArchivedChatsFile,
  ChatInterfaceMode,
  ChatModel,
  ChatTabsFile,
  FileTabViewMode,
  PersistedChatMessage,
  PersistedChatTab,
} from './types';

export function createEmptyChatTabsFile(revision = 0): ChatTabsFile {
  return {
    version: 1,
    ...(revision > 0 ? { revision } : {}),
    tabs: [],
    activeTabId: '',
  };
}

export function createEmptyArchivedChatsFile(revision = 0): ArchivedChatsFile {
  return {
    version: 1,
    ...(revision > 0 ? { revision } : {}),
    archived: [],
  };
}

export function persistedFileRevision(file: { revision?: number }): number {
  return Number.isSafeInteger(file.revision) && (file.revision ?? 0) >= 0
    ? (file.revision ?? 0)
    : 0;
}

export function createPersistedChatTab(input: {
  id: string;
  title?: string;
  createdAt: string;
  providerType?: AgentProviderType;
  model?: ChatModel;
  defaultStampModel?: ChatModel;
  modelConfig?: AgentModelConfig;
  planMode?: boolean;
  proposalMode?: 'optional' | 'required';
  deferredToolsAllowed?: boolean;
  interfaceMode?: ChatInterfaceMode;
  selectedRepoId?: string;
}): PersistedChatTab {
  return {
    id: input.id,
    title: input.title?.trim() || 'New chat',
    createdAt: input.createdAt,
    messages: [],
    ...(input.providerType ? { providerType: input.providerType } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.defaultStampModel
      ? { defaultStampModel: input.defaultStampModel }
      : {}),
    ...(input.modelConfig ? { modelConfig: input.modelConfig } : {}),
    ...(input.planMode ? { planMode: true } : {}),
    ...(input.proposalMode && input.proposalMode !== 'optional'
      ? { proposalMode: input.proposalMode }
      : {}),
    ...(typeof input.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: input.deferredToolsAllowed }
      : {}),
    ...(input.interfaceMode ? { interfaceMode: input.interfaceMode } : {}),
    ...(input.selectedRepoId ? { selectedRepoId: input.selectedRepoId } : {}),
  };
}

export function createPersistedFileTab(input: {
  id: string;
  filePath: string;
  title?: string;
  createdAt: string;
  viewMode?: FileTabViewMode;
  pinned?: boolean;
}): PersistedChatTab {
  const pathParts = input.filePath.split(/[\\/]/);
  const fallbackTitle = pathParts[pathParts.length - 1] || input.filePath;
  return {
    id: input.id,
    title: input.title?.trim() || fallbackTitle,
    createdAt: input.createdAt,
    kind: 'file',
    filePath: input.filePath,
    fileViewMode: input.viewMode ?? 'raw',
    ...(input.pinned ? { pinned: true } : {}),
    messages: [],
  };
}

/**
 * Merge a compatibility renderer snapshot without allowing an older message
 * list to erase stable-id provider output already committed by main.
 */
export function mergePersistedMessagesById(
  canonical: PersistedChatMessage[],
  incoming: readonly PersistedChatMessage[],
): PersistedChatMessage[] {
  // A compatibility snapshot can have been read before a provider commit.
  // Stable ids are main/provider-owned once present canonically, so selecting
  // an incoming same-id value here could erase later transcript blocks.
  if (
    canonical.length === incoming.length &&
    canonical.every((message, index) => message.id === incoming[index]?.id)
  ) {
    return canonical;
  }
  let result: PersistedChatMessage[] | undefined;
  const canonicalIds = new Set(canonical.map((message) => message.id));
  for (const message of incoming) {
    if (!canonicalIds.has(message.id)) {
      result ??= canonical.slice();
      result.push(message);
    }
  }
  return result ?? canonical;
}

/**
 * Read-compat canonicalization for a persisted tab written before the
 * `LlmProvider*` usage-limit banner rename. The pre-cutover renderer applied
 * this mapping during hydration and wrote the modern keys back on its next
 * save; with durable state main-owned, the canonical load performs the same
 * migration so checkpoints and snapshot consumers always see the modern keys.
 */
export function normalizeLegacyPersistedChatTab(
  tab: PersistedChatTab,
): PersistedChatTab {
  const activation = readMcpActivationRecord(tab.mcpActivation);
  const invalidActivation =
    tab.mcpActivation !== undefined && activation === undefined;
  if (
    !invalidActivation &&
    tab.claudeUsageLimitBanner === undefined &&
    tab.dismissedClaudeUsageLimitBannerKey === undefined
  ) {
    return tab;
  }
  const normalized: PersistedChatTab = { ...tab };
  if (invalidActivation) delete normalized.mcpActivation;
  delete normalized.claudeUsageLimitBanner;
  delete normalized.dismissedClaudeUsageLimitBannerKey;
  if (
    normalized.llmProviderUsageLimitBanner === undefined &&
    tab.claudeUsageLimitBanner !== undefined
  ) {
    normalized.llmProviderUsageLimitBanner = tab.claudeUsageLimitBanner;
  }
  if (
    normalized.dismissedLlmProviderUsageLimitBannerKey === undefined &&
    typeof tab.dismissedClaudeUsageLimitBannerKey === 'string'
  ) {
    normalized.dismissedLlmProviderUsageLimitBannerKey =
      tab.dismissedClaudeUsageLimitBannerKey;
  }
  return normalized;
}

/** Apply {@link normalizeLegacyPersistedChatTab} across a loaded tabs file. */
export function normalizeLegacyChatTabsFile(file: ChatTabsFile): ChatTabsFile {
  let changed = false;
  const tabs = file.tabs.map((tab) => {
    const normalized = normalizeLegacyPersistedChatTab(tab);
    if (normalized !== tab) changed = true;
    return normalized;
  });
  return changed ? { ...file, tabs } : file;
}
