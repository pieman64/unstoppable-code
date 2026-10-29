import type {
  BotChatAddress,
  BotChatRow,
} from '@canopy/desktop-shared/lib/bot-discovery';
import type {
  ProjectChatAddress,
  ProjectChatRow,
  ProjectType,
} from '@canopy/desktop-shared/lib/project-discovery';
import type {
  ChatStateSnapshot,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import type { ProjectDiscoveryCaller } from './index';
import { DiscoveryError } from './errors';
import { requireAuthorizedProject } from './owner-policy';
import { listDiscoverableTaskIds, projectChatRow } from './chats-list';
import { readTaskRuntimeSnapshot } from './runtime-state';

/** The canonical transcript scope of one retained chat. */
export interface ChatReadScope {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * One authorized chat, resolved from an explicit address. `tab` and
 * `snapshot` are main-only and must never be serialized into a result; `row`
 * is the public projection.
 */
export interface AuthorizedChatReadContext {
  address: ProjectChatAddress;
  projectType: ProjectType;
  scope: ChatReadScope;
  tab: PersistedChatTab;
  snapshot: ChatStateSnapshot;
  row: ProjectChatRow;
}

/**
 * A bot read target keeps its public bot address while projecting the same
 * main-only chat state used by project transcript readers.
 */
export interface BotChatReadContext {
  kind: 'bot';
  address: BotChatAddress;
  projectType: 'cowork';
  scope: ChatReadScope;
  tab: PersistedChatTab;
  snapshot: ChatStateSnapshot;
  row: BotChatRow;
}

/** The address union is discriminated by its projectId or botId property. */
export type ChatReadAddress = ProjectChatAddress | BotChatAddress;

/** A fully resolved transcript context for either a project or a bot chat. */
export type ChatReadContext = AuthorizedChatReadContext | BotChatReadContext;

/**
 * Resolve an explicit project chat address for a read. The project goes
 * through the same owner policy as discovery; the task must be a discoverable
 * task of that project and the chat a chat tab of that task. Anything else,
 * including a chat ID that exists under another task, is `not_found`.
 */
export async function resolveAuthorizedChat(
  address: ProjectChatAddress,
  caller: ProjectDiscoveryCaller,
): Promise<AuthorizedChatReadContext> {
  const project = await requireAuthorizedProject(address.projectId, caller);
  if (project.readiness === 'unavailable')
    throw new DiscoveryError(
      'execution_failed',
      'Project inventory could not be read.',
    );
  const taskIds = await listDiscoverableTaskIds(
    project.projectId,
    project.type,
  );
  if (!taskIds.includes(address.taskId))
    throw new DiscoveryError('not_found', 'Task was not found.');
  const snapshot = await readTaskRuntimeSnapshot(
    project.projectId,
    address.taskId,
  );
  const tab = snapshot.tabsFile.tabs.find(
    (candidate) => candidate.id === address.chatId && candidate.kind !== 'file',
  );
  if (!tab) throw new DiscoveryError('not_found', 'Chat was not found.');
  return {
    address: {
      projectId: project.projectId,
      taskId: address.taskId,
      chatId: tab.id,
    },
    projectType: project.type,
    scope: {
      workspaceId: resolveCoworkWorkspaceId(project.projectId),
      worktreeId: address.taskId,
      chatId: tab.id,
    },
    tab,
    snapshot,
    row: projectChatRow(project.projectId, address.taskId, tab, snapshot),
  };
}
