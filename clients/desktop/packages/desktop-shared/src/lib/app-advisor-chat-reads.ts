import { BRAND } from '@canopy/brand/current';
import { chatTabLabel } from '@canopy/protocol';
import { z } from 'zod';
import {
  getProviderForModel,
  isDefaultCoworkWorkspaceId,
  isVisiblePersistedChatMessage,
  modelConfigForProviderSupportsFastMode,
  type AppAdvisorJson,
  type ChatProjectData,
  type ChatTabPluginSelections,
  type PersistedChatMessage,
  type PersistedChatTab,
  type StandaloneChatMeta,
} from '../types';
import {
  legacyChatHistoryMessageText,
  serializeLegacyChatHistoryMessage,
} from './chat-history-serialization';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
  type CodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import { flattenMcpServerRows } from './mcp-server-rows';

/*
 * App Advisor's chat read results (CAN-5999), shared by the renderer
 * dispatcher and Electron main so a moved read answers exactly as the
 * renderer did. Callers load the tabs, transcripts and inventories; these
 * functions shape the answer.
 */

export const CHAT_HISTORY_DEFAULT_LIMIT = 20;
export const CHAT_HISTORY_MAX_LIMIT = 100;
export const CHAT_PLUGIN_LIST_DEFAULT_LIMIT = 50;
export const CHAT_PLUGIN_LIST_MAX_LIMIT = 200;
export const STANDALONE_LIST_DEFAULT_LIMIT = 50;
export const STANDALONE_LIST_MAX_LIMIT = 200;

/** A chat tab as these reads see it: the renderer's tab, or main's stored tab with its runtime status. */
export type AdvisorChatTab = Pick<
  PersistedChatTab,
  | 'id'
  | 'title'
  | 'description'
  | 'customTitle'
  | 'kind'
  | 'filePath'
  | 'readOnly'
  | 'staleSessionDetected'
> & {
  messages: readonly PersistedChatMessage[];
  status: 'idle' | 'streaming' | 'error';
  queuedMessages: readonly unknown[];
};

export interface AdvisorChatHistoryTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
  tab: AdvisorChatTab;
}

export type ChatHistoryMode =
  | 'last_user_message'
  | 'last_agent_response'
  | 'transcript';

export interface ChatTurnInspectionResult {
  [key: string]: AppAdvisorJson;
  status: AdvisorChatTab['status'];
  inProgress: boolean;
  state: 'in_progress' | 'paused' | 'completed' | 'error';
  startedAt: number | null;
  pausedAt: number | null;
  resumedAt: number | null;
  accumulatedPausedDurationMs: number;
  completedAt: number | null;
  durationMs: number | null;
}

export type PluginRowKind = 'collection' | 'skill' | 'plugin' | 'mcp';

export interface AvailablePluginRow {
  [key: string]: AppAdvisorJson;
  kind: PluginRowKind;
  key: string;
  name: string;
  description: string;
  source: string;
  selected: boolean;
}

/** The plugin inventories a plugin list reads, each as its window IPC answers. */
export interface AdvisorPluginInventories {
  skills: {
    success: boolean;
    data?: ReadonlyArray<{
      sourceId: string;
      name: string;
      description: string;
      builtIn?: boolean;
    }>;
  };
  marketplaces: {
    success: boolean;
    data?: {
      marketplaces: ReadonlyArray<{
        name: string;
        plugins: ReadonlyArray<{
          marketplaceId: string;
          name: string;
          description?: string;
          providerSupport: { claude: AppAdvisorJson; codex: AppAdvisorJson };
        }>;
      }>;
    };
  };
  collections: ReadonlyArray<{
    id: string;
    name: string;
    description: string;
  }>;
  mcp: { servers: Parameters<typeof flattenMcpServerRows>[0] };
}

function jsonValue(value: unknown): AppAdvisorJson {
  return z.json().parse(JSON.parse(JSON.stringify(value ?? null)));
}

/** An empty selection set, in the shape the renderer's chat store writes. */
export function emptyChatTabPluginSelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    mcpHttpAuthPreferences: [],
  };
}

export function clampLimit(
  limit: number | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return defaultLimit;
  }
  return Math.max(1, Math.min(maxLimit, Math.floor(limit)));
}

export function fuzzyMatchText(
  query: string | undefined,
  values: string[],
): boolean {
  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const haystack = values.join(' ').toLowerCase();
  if (haystack.includes(normalizedQuery)) return true;
  let index = 0;
  for (const char of normalizedQuery) {
    index = haystack.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

export function clampChatHistoryLimit(limit: number | undefined): number {
  return clampLimit(limit, CHAT_HISTORY_DEFAULT_LIMIT, CHAT_HISTORY_MAX_LIMIT);
}

/**
 * The label a user already associates with a chat: a custom title, then the
 * generated description, then the creation title, then the id.
 */
export function getChatTabLabel(
  tab: Pick<PersistedChatTab, 'id' | 'title' | 'description' | 'customTitle'>,
): string {
  if (tab.customTitle?.trim()) return tab.customTitle.trim();
  if (tab.description?.trim()) return tab.description;
  if (tab.title?.trim()) return tab.title;
  return tab.id;
}

export function lastUserMessageResult(tab: AdvisorChatTab): AppAdvisorJson {
  for (let index = tab.messages.length - 1; index >= 0; index -= 1) {
    const message = tab.messages[index];
    if (message.role !== 'user') {
      continue;
    }
    const text = legacyChatHistoryMessageText(message);
    return {
      id: message.id,
      timestamp: message.timestamp,
      text: text.text,
      truncated: text.truncated,
    };
  }
  return null;
}

export function chatSessionResult(
  tab: AdvisorChatTab,
): Record<string, AppAdvisorJson> {
  const staleSession = tab.staleSessionDetected;
  return {
    state: staleSession
      ? 'expired'
      : tab.status === 'streaming'
        ? 'active'
        : tab.status === 'error'
          ? 'error'
          : 'idle',
    expired: staleSession !== undefined,
    readOnly: tab.readOnly === true,
    canHandOff: staleSession !== undefined,
    undeliveredMessagePresent:
      (staleSession?.droppedMessageText.trim().length ?? 0) > 0,
    undeliveredMessageLength: staleSession?.droppedMessageText.length ?? 0,
    undeliveredFileReferenceCount:
      staleSession?.droppedFileReferences?.length ?? 0,
    undeliveredInputMode: staleSession?.droppedInputMode ?? null,
  };
}

export function latestTurnInspection(
  tab: AdvisorChatTab,
  now: () => number = Date.now,
): ChatTurnInspectionResult {
  for (let index = tab.messages.length - 1; index >= 0; index -= 1) {
    const message = tab.messages[index];
    for (
      let blockIndex = message.blocks.length - 1;
      blockIndex >= 0;
      blockIndex -= 1
    ) {
      const block = message.blocks[blockIndex];
      if (block.type !== 'turn_timer') {
        continue;
      }
      const completedAt = block.completedAt;
      const pausedAt = block.pausedAt ?? null;
      const resumedAt = block.resumedAt ?? null;
      const startedAt = block.startedAt ?? null;
      const accumulatedPausedDurationMs = Math.max(
        0,
        block.accumulatedPausedDurationMs ??
          (startedAt !== null && pausedAt !== null && resumedAt !== null
            ? resumedAt - Math.max(startedAt, pausedAt)
            : 0),
      );
      const inProgress =
        (pausedAt === null || resumedAt !== null) &&
        (completedAt === null || tab.status === 'streaming');
      const end =
        completedAt ?? (resumedAt !== null ? now() : pausedAt) ?? now();
      const activePausedDurationMs =
        pausedAt !== null && resumedAt === null
          ? Math.max(0, end - pausedAt)
          : 0;
      return {
        status: tab.status,
        inProgress,
        state:
          tab.status === 'error'
            ? 'error'
            : pausedAt !== null && resumedAt === null && completedAt === null
              ? 'paused'
              : inProgress
                ? 'in_progress'
                : 'completed',
        startedAt,
        pausedAt,
        resumedAt,
        accumulatedPausedDurationMs,
        completedAt,
        durationMs:
          startedAt === null
            ? null
            : Math.max(
                0,
                end -
                  startedAt -
                  accumulatedPausedDurationMs -
                  activePausedDurationMs,
              ),
      };
    }
  }

  return {
    status: tab.status,
    inProgress: tab.status === 'streaming',
    state:
      tab.status === 'error'
        ? 'error'
        : tab.status === 'streaming'
          ? 'in_progress'
          : 'completed',
    startedAt: null,
    pausedAt: null,
    resumedAt: null,
    accumulatedPausedDurationMs: 0,
    completedAt: null,
    durationMs: null,
  };
}

export function chatHistoryPayload(
  target: AdvisorChatHistoryTarget,
  mode: ChatHistoryMode,
  query: string | undefined,
  limit: number,
): AppAdvisorJson {
  const visibleMessages = target.tab.messages.filter(
    isVisiblePersistedChatMessage,
  );
  const base = {
    mode,
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    tabTitle: target.tab.title,
    totalMessages: visibleMessages.length,
    session: chatSessionResult(target.tab),
    agentTurn: latestTurnInspection(target.tab),
  };

  if (mode === 'last_user_message') {
    const message = [...visibleMessages]
      .reverse()
      .find((candidate) => candidate.role === 'user');
    return {
      ...base,
      message: message ? serializeLegacyChatHistoryMessage(message) : null,
    };
  }

  if (mode === 'last_agent_response') {
    const message = [...visibleMessages]
      .reverse()
      .find(
        (candidate) =>
          candidate.role === 'assistant' &&
          legacyChatHistoryMessageText(candidate).text.length,
      );
    return {
      ...base,
      message: message ? serializeLegacyChatHistoryMessage(message) : null,
    };
  }

  const normalizedQuery = query?.toLowerCase();
  const matching = visibleMessages.filter((message) => {
    if (!normalizedQuery) return true;
    return legacyChatHistoryMessageText(message)
      .text.toLowerCase()
      .includes(normalizedQuery);
  });
  const selected = matching.slice(-limit);
  return {
    ...base,
    ...(query ? { query } : {}),
    limit,
    matchedMessages: matching.length,
    returnedMessages: selected.length,
    messages: selected.map(serializeLegacyChatHistoryMessage),
  };
}

export function chatTabSummaryResult(
  tab: AdvisorChatTab,
  activeTabId: string,
): Record<string, AppAdvisorJson> {
  return {
    id: tab.id,
    title: tab.title,
    description: tab.description ?? null,
    customTitle: tab.customTitle ?? null,
    displayName: getChatTabLabel(tab),
    active: tab.id === activeTabId,
    state: tab.status === 'streaming' ? 'active' : 'idle',
    status: tab.status,
    queuedMessageCount: tab.queuedMessages.length,
    session: chatSessionResult(tab),
    lastUserMessage: lastUserMessageResult(tab),
  };
}

/**
 * A worktree's tabs as list_tabs answers. `unsavedChanges(tabId)` reports a
 * file tab's unsaved edits; null when that cannot be known.
 */
export function worktreeTabsResult(
  projectId: string,
  worktreeId: string,
  tabs: readonly AdvisorChatTab[],
  activeTabId: string,
  unsavedChanges: (tabId: string) => boolean | null,
): AppAdvisorJson {
  const chatTabs = tabs
    .filter((tab) => (tab.kind ?? 'chat') === 'chat')
    .map((tab) => chatTabSummaryResult(tab, activeTabId));
  const fileTabs = tabs
    .filter((tab) => tab.kind === 'file')
    .map((tab) => ({
      id: tab.id,
      title: tab.title,
      active: tab.id === activeTabId,
      filePath: tab.filePath ?? null,
      unsavedChanges: unsavedChanges(tab.id),
    }));
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  return {
    projectId,
    worktreeId,
    activeTabId: activeTabId || null,
    activeTabKind: activeTab ? (activeTab.kind ?? 'chat') : null,
    totalTabs: tabs.length,
    chatTabs,
    fileTabs,
  };
}

function selectedKeys(selections: ChatTabPluginSelections): {
  collections: Set<string>;
  skills: Set<string>;
  plugins: Set<string>;
  mcp: Set<string>;
} {
  return {
    collections: new Set(selections.collectionIds),
    skills: new Set(
      selections.skillRefs.map((ref) => `${ref.sourceId}/${ref.skillName}`),
    ),
    plugins: new Set(
      selections.pluginRefs.map(
        (ref) => `${ref.marketplaceId}/${ref.pluginName}`,
      ),
    ),
    mcp: new Set(
      (selections.mcpServerRefs ?? []).map(
        (ref) => `${ref.serverId}/${ref.configId}`,
      ),
    ),
  };
}

function pluginRowMatches(
  row: AvailablePluginRow,
  query: string,
  kind: PluginRowKind | undefined,
): boolean {
  if (kind && row.kind !== kind) {
    return false;
  }
  if (!query) {
    return true;
  }
  const haystack = [row.kind, row.key, row.name, row.description, row.source]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

/** The plugin list a list_plugins read answers, from the loaded inventories. */
export function availablePluginListResult(
  inventories: AdvisorPluginInventories,
  currentSelections: ChatTabPluginSelections | null,
  targetMeta: AppAdvisorJson | null,
  action: { query?: string; kind?: PluginRowKind; limit?: number },
): AppAdvisorJson {
  const selected = selectedKeys(
    currentSelections ?? emptyChatTabPluginSelections(),
  );
  const rows: AvailablePluginRow[] = [];

  if (inventories.skills.success && inventories.skills.data) {
    for (const skill of inventories.skills.data) {
      const key = `${skill.sourceId}/${skill.name}`;
      rows.push({
        kind: 'skill',
        key,
        name: skill.name,
        description: skill.description,
        source: skill.builtIn
          ? `${BRAND.displayName} (built-in)`
          : skill.sourceId,
        selected: selected.skills.has(key),
      });
    }
  }

  if (inventories.marketplaces.success && inventories.marketplaces.data) {
    for (const marketplace of inventories.marketplaces.data.marketplaces) {
      for (const plugin of marketplace.plugins) {
        const key = `${plugin.marketplaceId}/${plugin.name}`;
        rows.push({
          kind: 'plugin',
          key,
          name: plugin.name,
          description: plugin.description ?? '',
          source: marketplace.name,
          providers: {
            claude: plugin.providerSupport.claude,
            codex: plugin.providerSupport.codex,
          },
          selected: selected.plugins.has(key),
        });
      }
    }
  }

  for (const collection of inventories.collections) {
    rows.push({
      kind: 'collection',
      key: collection.id,
      name: collection.name,
      description: collection.description,
      source: 'Collection',
      selected: selected.collections.has(collection.id),
    });
  }

  for (const server of flattenMcpServerRows(inventories.mcp.servers)) {
    for (const config of server.configs) {
      if (!config.enabled) continue;
      const key = `${server.id}/${config.id}`;
      rows.push({
        kind: 'mcp',
        key,
        name: `${server.name} - ${config.name}`,
        description: server.description,
        source: server.type === 'command' ? 'CLI MCP' : 'HTTP MCP',
        selected: selected.mcp.has(key),
      });
    }
  }

  const query = action.query?.trim() ?? '';
  const limit = Math.max(
    1,
    Math.min(
      CHAT_PLUGIN_LIST_MAX_LIMIT,
      Math.floor(action.limit ?? CHAT_PLUGIN_LIST_DEFAULT_LIMIT),
    ),
  );
  const filtered = rows
    .filter((row) => pluginRowMatches(row, query, action.kind))
    .sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    );

  return {
    ...(targetMeta ? { target: targetMeta } : {}),
    currentSelections: jsonValue(
      currentSelections ?? emptyChatTabPluginSelections(),
    ),
    query,
    ...(action.kind ? { kind: action.kind } : {}),
    totalMatches: filtered.length,
    returned: Math.min(filtered.length, limit),
    rows: filtered.slice(0, limit),
  };
}

export function standaloneProjectSummary(
  project: ChatProjectData,
): AppAdvisorJson {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    color: project.color ?? '',
    description: project.description ?? '',
    defaultModel: project.defaultModel ?? '',
    defaultPresetId: project.defaultPresetId ?? '',
    presetCount: project.presets?.length ?? 0,
    hasDefaultPluginSelections: project.defaultPluginSelections !== undefined,
    archiveRetentionDays: project.archiveRetentionDays ?? null,
    isDefault: isDefaultCoworkWorkspaceId(project.id),
  };
}

export function standaloneChatSummary(
  chat: StandaloneChatMeta,
  workEntryId?: string | null,
  groupId?: string,
): AppAdvisorJson {
  return {
    id: chat.id,
    ...(groupId ? { groupId } : {}),
    title: chat.title ?? '',
    description: chat.description,
    createdAt: chat.createdAt,
    messageCount: chat.messageCount ?? 0,
    lastMessageAt: chat.lastMessageAt ?? '',
    providerType: chat.providerType ?? '',
    archived: chat.archived === true,
    archivedAt: chat.archivedAt ?? '',
    hasPluginSelections: chat.pluginSelections !== undefined,
    // Owning Work Entry for live cowork chats; null = legacy archived chat.
    ...(workEntryId !== undefined ? { workEntryId } : {}),
  };
}

export function standaloneWorkspaceListResult<T>(
  items: readonly T[],
  query: string | undefined,
  limit: number | undefined,
  values: (item: T) => string[],
): AppAdvisorJson {
  const matching = items.filter((item) => fuzzyMatchText(query, values(item)));
  const max = clampLimit(
    limit,
    STANDALONE_LIST_DEFAULT_LIMIT,
    STANDALONE_LIST_MAX_LIMIT,
  );
  const filtered = matching.slice(0, max);
  return {
    query: query?.trim() ?? '',
    totalMatches: matching.length,
    returned: filtered.length,
    items: jsonValue(filtered),
  };
}

/** The name a chat tab shows in the tab strips. */
export function chatTabStripLabel(
  tab: Pick<PersistedChatTab, 'title' | 'description' | 'customTitle'>,
): string {
  return chatTabLabel(tab);
}

/** A chat tab with the settings App Advisor's setters report. */
export type AdvisorChatSettingsTab = AdvisorChatTab &
  Pick<
    PersistedChatTab,
    'model' | 'providerType' | 'pluginSelections' | 'codexFastModeEnabled'
  > & {
    planMode?: boolean;
    thinkingLevel?: string;
    modelConfig?: {
      thinkingLevel?: string;
      speed?: unknown;
      fastMode?: unknown;
    };
  };

function mcpHttpAuthTargetResult(
  target: NonNullable<
    ChatTabPluginSelections['mcpHttpAuthPreferences']
  >[number]['target'],
): Record<string, AppAdvisorJson> {
  if (target.kind === 'standalone') {
    return {
      kind: target.kind,
      serverId: target.serverId,
      configId: target.configId,
    };
  }
  return {
    kind: target.kind,
    marketplaceId: target.marketplaceId,
    pluginName: target.pluginName,
    serverName: target.serverName,
  };
}

export function pluginSelectionsResult(
  selections: ChatTabPluginSelections,
): AppAdvisorJson {
  const result: Record<string, AppAdvisorJson> = {
    collectionIds: selections.collectionIds.map((id) => id),
    skillRefs: selections.skillRefs.map((ref) => ({
      sourceId: ref.sourceId,
      skillName: ref.skillName,
    })),
    pluginRefs: selections.pluginRefs.map((ref) => ({
      marketplaceId: ref.marketplaceId,
      pluginName: ref.pluginName,
    })),
  };
  if (selections.bundleIds) {
    result.bundleIds = selections.bundleIds.map((id) => id);
  }
  if (selections.mcpServerRefs) {
    result.mcpServerRefs = selections.mcpServerRefs.map((ref) => ({
      serverId: ref.serverId,
      configId: ref.configId,
    }));
  }
  if (selections.mcpHttpAuthPreferences) {
    result.mcpHttpAuthPreferences = selections.mcpHttpAuthPreferences.map(
      (preference) => ({
        target: mcpHttpAuthTargetResult(preference.target),
        handler: preference.handler,
      }),
    );
  }
  return result;
}

/** Whether App Advisor can read or change a Codex speed on this chat tab. */
export function tabUsesCodexSpeed(
  tab: Pick<AdvisorChatSettingsTab, 'providerType' | 'model'>,
): boolean {
  const provider =
    tab.providerType ??
    (tab.model ? getProviderForModel(tab.model) : undefined);
  return (
    provider !== undefined && modelConfigForProviderSupportsFastMode(provider)
  );
}

/** The Codex speed a tab requests: its config's speed, then the legacy boolean, else Regular. */
export function tabRequestedCodexSpeed(
  tab: Pick<AdvisorChatSettingsTab, 'modelConfig' | 'codexFastModeEnabled'>,
): CodexSpeed {
  return (
    readCodexSpeedRecord(tab.modelConfig, tab.codexFastModeEnabled) ??
    DEFAULT_CODEX_SPEED
  );
}

export function chatSettingsResult(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  tab: AdvisorChatSettingsTab;
}): Record<string, AppAdvisorJson> {
  return {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    title: target.tab.title,
    planMode: target.tab.planMode === true,
    thinkingLevel:
      target.tab.modelConfig?.thinkingLevel ?? target.tab.thinkingLevel ?? null,
    model: target.tab.model ?? '',
    providerType: target.tab.providerType ?? '',
    pluginSelections: pluginSelectionsResult(
      target.tab.pluginSelections ?? emptyChatTabPluginSelections(),
    ),
    session: chatSessionResult(target.tab),
    agentTurn: latestTurnInspection(target.tab),
    ...(tabUsesCodexSpeed(target.tab)
      ? { speed: tabRequestedCodexSpeed(target.tab) }
      : {}),
  };
}

/** Selections with one plugin row turned on or off, sorted as the chat store writes them. */
export function updatePluginSelection(
  selections: ChatTabPluginSelections,
  kind: PluginRowKind,
  key: string,
  enabled: boolean,
): ChatTabPluginSelections {
  const sets = selectedKeys(selections);
  const set =
    kind === 'collection'
      ? sets.collections
      : kind === 'skill'
        ? sets.skills
        : kind === 'plugin'
          ? sets.plugins
          : sets.mcp;
  if (enabled) set.add(key);
  else set.delete(key);
  const split = (value: string, at: number): [string, string] => [
    value.slice(0, at),
    value.slice(at + 1),
  ];
  return {
    collectionIds: Array.from(sets.collections).sort(),
    skillRefs: Array.from(sets.skills)
      .sort()
      .map((entry) => {
        const [sourceId, skillName] = split(entry, entry.lastIndexOf('/'));
        return { sourceId, skillName };
      }),
    pluginRefs: Array.from(sets.plugins)
      .sort()
      .map((entry) => {
        const [marketplaceId, pluginName] = split(
          entry,
          entry.lastIndexOf('/'),
        );
        return { marketplaceId, pluginName };
      }),
    mcpServerRefs: Array.from(sets.mcp)
      .sort()
      .map((entry) => {
        const [serverId, configId] = split(entry, entry.indexOf('/'));
        return { serverId, configId };
      }),
  };
}
