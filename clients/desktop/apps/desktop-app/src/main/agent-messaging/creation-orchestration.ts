import { randomUUID } from 'node:crypto';
import {
  parseChatCreationAction,
  type ChatCreationAction,
  type CreatedTaskChatReceipt,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import {
  APP_ADVISOR_PROJECT_ID,
  type ChatCommand,
  type ChatCommandEnvelope,
} from '@canopy/desktop-shared/types';
import {
  AgentChatSendError,
  canonicalSource,
  dispatchAgentChatSend,
  type AgentChatSendContext,
} from './send-orchestration';
import {
  isAgentSenderContextError,
  resolveAgentSenderIdentity,
} from './sender-context';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { requireAuthorizedProject } from '../project-discovery/owner-policy';
import { listDiscoverableTaskIds } from '../project-discovery/chats-list';
import { DiscoveryError } from '../project-discovery/errors';
import { readTaskRuntimeSnapshot } from '../project-discovery/runtime-state';
import {
  requireBotAccess,
  readBotEntries,
} from '../project-discovery/bots/target';
import { requireBot } from '../project-discovery/bots/registry';
import {
  createWorkEntry,
  removeWorkEntryRow,
} from '../lib/cowork-work-entries';
import { ensureCoworkHomeScaffold } from '../lib/chat-project-utils';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../canopy-runtime/core-chat-command-adapter';
import { getChatStateCommandPort } from '../ipc/chat-state';

/** Create without navigation; initial input uses the canonical trusted send path. */
export async function dispatchAgentChatCreation(
  action: ChatCreationAction,
  context: AgentChatSendContext,
): Promise<CreatedTaskChatReceipt> {
  try {
    return await create(action, context);
  } catch (error) {
    if (isAgentSenderContextError(error)) {
      const hidden =
        error.code === 'owner_boundary' ||
        error.code === 'authorization_conflict';
      throw new AgentChatSendError(
        hidden ? 'not_found' : error.code,
        hidden ? 'The target chat is not available.' : error.message,
      );
    }
    if (error instanceof DiscoveryError)
      throw new AgentChatSendError(
        error.code === 'advisor_access_disabled'
          ? 'advisor_access_disabled'
          : 'not_found',
        'The target chat is not available.',
      );
    if (error instanceof AgentChatSendError) throw error;
    // Entry, chat and send are separate durable commits. Do not suggest retrying
    // a send whose acknowledgement may have been lost.
    throw new AgentChatSendError(
      'target_not_ready',
      'Creation or initial input could not be confirmed. Discover the task and chat before retrying; do not resend a possibly accepted input.',
    );
  }
}

async function create(
  input: ChatCreationAction,
  context: AgentChatSendContext,
): Promise<CreatedTaskChatReceipt> {
  const parsed = parseChatCreationAction(input);
  if (!parsed.ok)
    throw new AgentChatSendError('validation_failed', parsed.message);
  const action = parsed.action;
  const source = await canonicalSource(context.caller.source);
  if (
    (context.caller.kind === 'app_advisor') !==
    (source.projectId === APP_ADVISOR_PROJECT_ID)
  )
    throw new AgentChatSendError(
      'validation_failed',
      'The trusted sender runtime is inconsistent.',
    );
  await resolveAgentSenderIdentity(source);
  const caller: ProjectDiscoveryCaller =
    context.caller.kind === 'app_advisor'
      ? { kind: 'app_advisor', chatId: source.chatId }
      : { kind: 'project_agent', ...source };
  const projectAction =
    action.type === 'projects.create_task' ||
    action.type === 'projects.create_task_chat';
  let projectId: string;
  if (projectAction) {
    const project = await requireAuthorizedProject(action.projectId, caller);
    if (action.type === 'projects.create_task' && project.type !== 'cowork')
      throw new AgentChatSendError(
        'unsupported_action',
        'Code tasks must be created through the existing worktree-creation workflow.',
      );
    if (project.readiness !== 'ready')
      throw new AgentChatSendError(
        'target_not_ready',
        'The project is not ready.',
      );
    projectId = project.projectId;
    if (
      action.type === 'projects.create_task_chat' &&
      !(await listDiscoverableTaskIds(projectId, project.type)).includes(
        action.taskId,
      )
    )
      throw new AgentChatSendError('not_found', 'The task is not available.');
    // Renderer project selection awaits this scaffold through standaloneChat.init.
    // Agent creation bypasses selection, but the first turn needs the same cwd.
    if (project.type === 'cowork') await ensureCoworkHomeScaffold(projectId);
  } else {
    await requireBotAccess(caller);
    const bot = requireBot(action.botId);
    projectId = bot.projectId;
    if (
      action.type === 'bots.create_task_chat' &&
      !(await readBotEntries(bot.botId)).some(
        (entry) => entry.id === action.taskId,
      )
    )
      throw new AgentChatSendError('not_found', 'The task is not available.');
  }

  const taskCreated =
    action.type === 'projects.create_task' ||
    action.type === 'bots.create_task';
  const taskId = 'taskId' in action ? action.taskId : randomUUID();
  let chatId: string | undefined;
  if (!taskCreated) {
    const { isReusableEmptyChatTab } = await import('../services/chat-service');
    const snapshot = await readTaskRuntimeSnapshot(projectId, taskId);
    chatId = snapshot.tabsFile.tabs.find(
      (tab) =>
        !tab.readOnly &&
        tab.staleSessionDetected === undefined &&
        tab.kind !== 'file' &&
        !(
          source.projectId === projectId &&
          source.worktreeId === taskId &&
          source.chatId === tab.id
        ) &&
        isReusableEmptyChatTab(tab),
    )?.id;
  }
  const chatCreated = chatId === undefined;
  let allocatedEntry = false;
  let ambiguousInput = false;
  try {
    if (chatCreated) {
      const port = getChatStateCommandPort();
      if (!port)
        throw new AgentChatSendError(
          'target_not_ready',
          'Chat command dispatch is unavailable.',
        );
      let seed: Omit<
        Extract<ChatCommand, { type: 'chat.create_tab' }>,
        'type' | 'tabId'
      > = {};
      if (projectAction) {
        const { resolveRemoteCreateTabSeed } =
          await import('../portal/adapters/chat-adapter');
        const defaults = await resolveRemoteCreateTabSeed(projectId);
        if ('noDispatchableModel' in defaults)
          throw new AgentChatSendError(
            'target_not_ready',
            'No model is available for a new chat.',
          );
        seed = defaults;
        const started = await context.startAdmission?.(
          { workspaceId: projectId, worktreeId: taskId },
          action.initialMessage !== undefined,
        );
        if (started) seed = { ...seed, approvalMode: started.approvalMode };
      }
      // Advisor resolves its own defaults at the required initial send, just
      // like advisor-chat.create_entry. Do not stamp project defaults on bots.
      if (taskCreated) {
        const title = 'title' in action ? action.title?.trim() : undefined;
        const created = await createWorkEntry(projectId, {
          id: taskId,
          createdAt: new Date().toISOString(),
          ...(title ? { title } : {}),
        });
        allocatedEntry = !created.reusedExistingEmpty;
      }
      const tabId = taskCreated ? taskId : randomUUID();
      const envelope: ChatCommandEnvelope = {
        schemaVersion: 1,
        commandId: randomUUID(),
        projectId,
        worktreeId: taskId,
        command: { type: 'chat.create_tab', tabId, ...seed },
      };
      const result = await dispatchTrustedChatCommand(envelope, {
        ...createChatCommandDispatchOptions(port, getActiveDesktopRuntime(), {
          principalId: 'local-desktop-user',
          clientInstanceId: 'agent-chat-creation',
          authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
          interfaceKind: 'mcp',
          grants: ['core.chat.write'],
        }),
        executionOptions: { preserveActiveTab: true },
      });
      if (result.outcome !== 'applied' && result.outcome !== 'already_applied')
        throw new AgentChatSendError(
          result.outcome === 'not_found' ? 'not_found' : 'target_not_ready',
          result.reason ?? 'The target refused chat creation.',
        );
      chatId = result.entityId;
      const snapshot = await readTaskRuntimeSnapshot(projectId, taskId);
      if (
        !chatId ||
        !snapshot.tabsFile.tabs.some(
          (tab) => tab.id === chatId && tab.kind !== 'file',
        )
      )
        throw new AgentChatSendError(
          'target_not_ready',
          'The created chat is not available.',
        );
    }
    if (!chatId)
      throw new AgentChatSendError(
        'target_not_ready',
        'The created chat is not available.',
      );
    const address = projectAction
      ? { projectId, taskId, chatId }
      : { botId: action.botId, taskId, chatId };
    if (action.initialMessage !== undefined) {
      const sendAction = projectAction
        ? {
            type: 'projects.send_message' as const,
            projectId,
            taskId,
            chatId,
            text: action.initialMessage,
          }
        : {
            type: 'bots.send_message' as const,
            botId: action.botId,
            taskId,
            chatId,
            text: action.initialMessage,
          };
      try {
        const accepted = await dispatchAgentChatSend(sendAction, context);
        return { address, taskCreated, chatCreated, input: accepted };
      } catch (error) {
        // Typed send refusals precede acceptance. An unconfirmed provider or
        // transport failure may have accepted the input: retain partial state.
        ambiguousInput = !(error instanceof AgentChatSendError);
        throw error;
      }
    }
    return { address, taskCreated, chatCreated };
  } catch (error) {
    if (allocatedEntry && !ambiguousInput) {
      // The available removal API only edits the registry, not chat storage.
      // Keep even our empty founding tab: safely removing an entry AND its tab
      // needs an existing conditional deletion boundary, not a hand-rolled one.
      // Unreadable state is never proof that an entry has no chat.
      const empty = await readChatTabsFile(projectId, taskId).then(
        (tabs) => !tabs.tabs.some((tab) => (tab.kind ?? 'chat') === 'chat'),
        () => false,
      );
      if (empty)
        await removeWorkEntryRow(projectId, taskId).catch(() => undefined);
    }
    throw error;
  }
}
