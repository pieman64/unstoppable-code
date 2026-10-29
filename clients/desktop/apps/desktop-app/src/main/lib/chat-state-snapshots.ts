import type {
  ArchivedChatsFile,
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { isPersistedChatTab } from './chat-tabs-reader';

function dedupeLegacyMessages(messages: readonly PersistedChatMessage[]): {
  messages: PersistedChatMessage[];
  repaired: boolean;
} {
  const indexes = new Map<string, number>();
  const result: PersistedChatMessage[] = [];
  let repaired = false;
  for (const message of messages) {
    const existingIndex = indexes.get(message.id);
    if (existingIndex === undefined) {
      indexes.set(message.id, result.length);
      result.push(message);
      continue;
    }
    result[existingIndex] = message;
    repaired = true;
  }
  return { messages: repaired ? result : messages.slice(), repaired };
}

function repairLegacyTab(tab: PersistedChatTab): {
  tab: PersistedChatTab;
  repaired: boolean;
} {
  const messages = dedupeLegacyMessages(tab.messages);
  return {
    tab: messages.repaired ? { ...tab, messages: messages.messages } : tab,
    repaired: messages.repaired,
  };
}

export function repairLegacySnapshots(
  tabsFile: ChatTabsFile,
  archivesFile: ArchivedChatsFile,
): {
  tabsFile: ChatTabsFile;
  archivesFile: ArchivedChatsFile;
  repaired: boolean;
} {
  let repaired = false;
  const liveIds = new Set<string>();
  const tabs: PersistedChatTab[] = [];
  for (const candidate of tabsFile.tabs) {
    if (liveIds.has(candidate.id)) {
      repaired = true;
      continue;
    }
    liveIds.add(candidate.id);
    const normalized = repairLegacyTab(candidate);
    repaired = repaired || normalized.repaired;
    tabs.push(normalized.tab);
  }
  const activeTabId = liveIds.has(tabsFile.activeTabId)
    ? tabsFile.activeTabId
    : (tabs[0]?.id ?? '');
  repaired = repaired || activeTabId !== tabsFile.activeTabId;
  const lastActiveEditableChatId = tabsFile.lastActiveEditableChatId;
  const keepLastActiveEditable =
    lastActiveEditableChatId !== undefined &&
    tabs.some(
      (tab) =>
        tab.id === lastActiveEditableChatId &&
        tab.kind !== 'file' &&
        tab.readOnly !== true,
    );
  if (lastActiveEditableChatId !== undefined && !keepLastActiveEditable) {
    repaired = true;
  }
  const pendingQuestions = tabsFile.pendingQuestions?.filter((question) =>
    liveIds.has(question.chatId),
  );
  if (
    pendingQuestions &&
    pendingQuestions.length !== tabsFile.pendingQuestions?.length
  ) {
    repaired = true;
  }
  const archiveIds = new Set<string>();
  const archived: ArchivedChatsFile['archived'] = [];
  for (const entry of archivesFile.archived) {
    if (liveIds.has(entry.tab.id) || archiveIds.has(entry.tab.id)) {
      repaired = true;
      continue;
    }
    archiveIds.add(entry.tab.id);
    const normalized = repairLegacyTab(entry.tab);
    repaired = repaired || normalized.repaired;
    archived.push(
      normalized.tab === entry.tab ? entry : { ...entry, tab: normalized.tab },
    );
  }
  const repairedTabsFile: ChatTabsFile = {
    ...tabsFile,
    tabs,
    activeTabId,
    ...(pendingQuestions ? { pendingQuestions } : {}),
  };
  if (keepLastActiveEditable) {
    repairedTabsFile.lastActiveEditableChatId = lastActiveEditableChatId;
  } else {
    delete repairedTabsFile.lastActiveEditableChatId;
  }
  return {
    tabsFile: repairedTabsFile,
    archivesFile: { ...archivesFile, archived },
    repaired,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRevision(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

export function isChatTabsSnapshot(value: unknown): value is ChatTabsFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    validRevision(value.revision) &&
    Array.isArray(value.tabs) &&
    value.tabs.every(isPersistedChatTab) &&
    typeof value.activeTabId === 'string'
  );
}

export function isArchivedSnapshot(value: unknown): value is ArchivedChatsFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    validRevision(value.revision) &&
    Array.isArray(value.archived) &&
    value.archived.every(
      (entry) =>
        isRecord(entry) &&
        isPersistedChatTab(entry.tab) &&
        typeof entry.archivedAt === 'string' &&
        typeof entry.turnCount === 'number' &&
        Number.isFinite(entry.turnCount) &&
        (entry.unread === undefined || typeof entry.unread === 'boolean'),
    )
  );
}
