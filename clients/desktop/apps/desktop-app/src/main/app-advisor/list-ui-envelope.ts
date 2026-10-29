import type {
  AppAdvisorActionResponse,
  AppAdvisorJson,
  AppAdvisorUiStateEnvelope,
} from '@canopy/desktop-shared/types';
import type {
  ProjectChatAddress,
  ProjectDiscoveryAction,
} from '@canopy/desktop-shared/lib/project-discovery';
import type {
  BotAction,
  BotChatAddress,
} from '@canopy/desktop-shared/lib/bot-discovery';
import { isRecord } from '../lib/type-guards';

type ListActionType =
  | ProjectDiscoveryAction['type']
  | Extract<BotAction, { sort: string }>['type'];
type ListResponse = Omit<AppAdvisorActionResponse, 'requestId'>;
type ListUiEnvelope = {
  revision: number;
  selection: Partial<ProjectChatAddress & BotChatAddress>;
  items: Record<string, { selected: true }>;
};

function buildListUiEnvelope(
  type: ListActionType,
  page: Record<string, AppAdvisorJson>,
  envelope: AppAdvisorUiStateEnvelope | undefined,
): ListUiEnvelope {
  if (!envelope || envelope.revision === 0) {
    return { revision: 0, selection: {}, items: {} };
  }
  const { snapshot } = envelope;
  const bot = type.startsWith('bots.');
  const taskId = bot
    ? snapshot.appAdvisor?.activeWorkEntryId
    : snapshot.selectedWorktree?.worktreeId;
  const chatId = bot
    ? snapshot.appAdvisor?.activeChatId
    : snapshot.activeChat?.chatId;
  const selection: ListUiEnvelope['selection'] = {
    ...(bot
      ? { botId: 'app_advisor' }
      : snapshot.selectedWorktree
        ? { projectId: snapshot.selectedWorktree.projectId }
        : {}),
    ...(taskId ? { taskId } : {}),
    ...(chatId ? { chatId } : {}),
  };
  const items: ListUiEnvelope['items'] = {};
  const ownerKey = bot ? 'botId' : 'projectId';
  const ownerId = selection[ownerKey];
  const needsTask = !type.endsWith('.list');
  const needsChat = type.endsWith('.list_task_chats');
  for (const row of Array.isArray(page.items) ? page.items : []) {
    if (
      !isRecord(row) ||
      !ownerId ||
      row[ownerKey] !== ownerId ||
      (needsTask && (!taskId || row.taskId !== taskId)) ||
      (needsChat && (!chatId || row.chatId !== chatId))
    ) {
      continue;
    }
    const address = {
      [ownerKey]: ownerId,
      ...(needsTask ? { taskId } : {}),
      ...(needsChat ? { chatId } : {}),
    };
    items[JSON.stringify(address)] = { selected: true };
  }
  return { revision: envelope.revision, selection, items };
}

export function withAppAdvisorListUiEnvelope(
  type: ListActionType,
  response: ListResponse,
  envelope: AppAdvisorUiStateEnvelope | undefined,
): ListResponse {
  if (!response.ok || !isRecord(response.result)) return response;
  return {
    ...response,
    result: {
      ...response.result,
      ui: buildListUiEnvelope(type, response.result, envelope),
    },
  };
}
