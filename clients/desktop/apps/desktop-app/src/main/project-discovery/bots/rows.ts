import type {
  BotChatRow,
  BotTaskRow,
  BotsListTasksAction,
  BotsListTaskChatsAction,
} from '@canopy/desktop-shared/lib/bot-discovery';
import type {
  ChatStateSnapshot,
  CoworkWorkEntryData,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { matchesChatFilters, projectChatRow } from '../chats-list';
import { workEntryBase, matchesTaskFilters } from '../tasks-list';
import { hasRunningChats, readTaskRuntimeSnapshot } from '../runtime-state';
import { DiscoveryError } from '../errors';
import { requireBot } from './registry';
import { readBotEntries } from './target';

/** Reuse metadata projection, never project authorization or mutation capability. */
export function botChatRow(
  botId: string,
  taskId: string,
  tab: PersistedChatTab,
  snapshot: ChatStateSnapshot,
): BotChatRow {
  const bot = requireBot(botId);
  const { projectId, ...row } = projectChatRow(
    bot.projectId,
    taskId,
    tab,
    snapshot,
  );
  void projectId;
  return {
    ...row,
    botId,
    capabilities: {
      canRead: true,
      canSend: row.capabilities.canSend,
      canWatch: true,
      canSteerQueuedMessage: false,
      unavailableReason: 'Steering Orchestrator chats is not available yet.',
    },
  };
}

export function botTaskRow(
  botId: string,
  entry: CoworkWorkEntryData,
): BotTaskRow {
  const bot = requireBot(botId);
  const { projectId, ...row } = workEntryBase(bot.projectId, entry);
  void projectId;
  return { ...row, botId };
}

export async function listBotTaskRows(
  action: BotsListTasksAction,
): Promise<BotTaskRow[]> {
  const bot = requireBot(action.botId);
  assertRetained(action.retentionStates);
  const entries = await readBotEntries(bot.botId);
  const items: BotTaskRow[] = [];
  for (const entry of entries) {
    const base = workEntryBase(bot.projectId, entry);
    if (!matchesTaskFilters(action, base, 'cowork', entry.id)) continue;
    const snapshot = await readTaskRuntimeSnapshot(bot.projectId, entry.id);
    const chatIds = snapshot.tabsFile.tabs
      .filter((tab) => tab.kind !== 'file')
      .map((tab) => tab.id);
    const running = hasRunningChats(snapshot, chatIds);
    if (
      action.hasRunningChats !== undefined &&
      action.hasRunningChats !== running
    )
      continue;
    items.push({
      ...botTaskRow(bot.botId, entry),
      chatCount: chatIds.length,
      hasRunningChats: running,
    });
  }
  return items;
}

export async function listBotChatRows(
  action: BotsListTaskChatsAction,
): Promise<BotChatRow[]> {
  const bot = requireBot(action.botId);
  assertRetained(action.retentionStates);
  const entries = await readBotEntries(bot.botId);
  const selected = action.taskId
    ? entries.filter((entry) => entry.id === action.taskId)
    : entries;
  if (action.taskId && selected.length === 0)
    throw new DiscoveryError('not_found', 'Task was not found.');
  const items: BotChatRow[] = [];
  for (const entry of selected) {
    const snapshot = await readTaskRuntimeSnapshot(bot.projectId, entry.id);
    for (const tab of snapshot.tabsFile.tabs) {
      if (tab.kind === 'file') continue;
      const row = botChatRow(bot.botId, entry.id, tab, snapshot);
      if (matchesChatFilters(action, row)) items.push(row);
    }
  }
  return items;
}

function assertRetained(states: readonly string[]): void {
  if (states.includes('archived'))
    throw new DiscoveryError(
      'unsupported_filter',
      'Archived bot listing is not supported.',
    );
}
